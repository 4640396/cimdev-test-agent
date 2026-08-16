import type { TimelineRecord } from '../../../contracts/src/contracts.js'
import type { TestKernelOutcome, TestKernelSessionContext } from './test-kernel.js'
import { runAnalyzingStage, runGeneratingStage, runValidatingStage, type AnalyzingStageResult, type GeneratingStageResult, type ValidatingStageResult } from './test-workflow-stages.js'
import { runWorkflow } from './workflow.js'

const stageLabels: Record<string, string> = {
  generating: '生成测试',
  validating: '独立验证',
  analyzing: '质量门禁与分析'
}

/** DSH 风格的三阶段工作流：生成 → 独立验证 → 质量门禁与分析。 */
export async function runTestWorkflow(context: TestKernelSessionContext): Promise<TestKernelOutcome> {
  const { emit } = context
  const startedAt = Date.now()
  const timeline: TimelineRecord[] = []
  let generated: GeneratingStageResult | undefined
  let validated: ValidatingStageResult | undefined
  let analyzed: AnalyzingStageResult | undefined

  const startTimelineStage = (stage: string, message: string): void => {
    timeline.push({ stage, status: 'running', startedAt: new Date().toISOString(), message })
  }
  const finishTimelineStage = (stage: string, status: 'passed' | 'failed' = 'passed', message?: string): void => {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index]
      if (item.stage === stage && item.status === 'running') {
        item.status = status
        item.durationMs = Date.now() - new Date(item.startedAt).getTime()
        if (message !== undefined) item.message = message
        return
      }
    }
  }
  const emitStage = async (stage: string, code: string): Promise<void> => {
    const label = stageLabels[stage] ?? stage
    startTimelineStage(label, `进入阶段：${code}`)
    await emit({ level: 'info', message: `进入阶段：${code}`, stage: code })
  }

  const results = await runWorkflow([
    {
      name: 'generating',
      run: async () => {
        await emitStage('generating', 'GENERATING')
        generated = await runGeneratingStage(context, emit)
        finishTimelineStage('生成测试', 'passed', `测试计划 ${generated.plan.meta.count} 条`)
      }
    },
    {
      name: 'validating',
      run: async () => {
        await emitStage('validating', 'VALIDATING')
        if (!generated) throw new Error('生成阶段未产出结果')
        validated = await runValidatingStage(context, generated, emit)
        finishTimelineStage('独立验证', 'passed', `通过 ${validated.totalPass} / 失败 ${validated.totalFail}`)
      }
    },
    {
      name: 'analyzing',
      run: async () => {
        await emitStage('analyzing', 'ANALYZING')
        if (!generated || !validated) throw new Error('前置阶段未产出结果')
        analyzed = await runAnalyzingStage(context, generated, validated, startedAt, timeline)
        await emit({
          level: analyzed.gate.passed ? 'success' : 'warning',
          message: `质量门禁：${analyzed.gate.reason}；四率=编译${Math.round(validated.metrics.compileRate * 100)}% 执行${Math.round(validated.metrics.execRate * 100)}% 断言${Math.round(validated.metrics.assertRate * 100)}% 有效${Math.round(validated.metrics.effectiveRate * 100)}%`
        })
        finishTimelineStage('质量门禁与分析', 'passed', analyzed.gate.reason)
        context.runEvents.append('run/result-ready', { gatePassed: analyzed.gate.passed, passed: validated.totalPass, failed: validated.totalFail })
      }
    }
  ])

  const failed = results.find((result) => result.status === 'failed')
  if (failed) throw failed.error ?? new Error(`测试工作流阶段失败：${failed.name}`)
  if (!generated || !validated || !analyzed) throw new Error('测试工作流未产出完整结果')
  return {
    adapterResult: generated.adapterResult,
    report: analyzed.report,
    lanes: analyzed.lanes,
    gate: analyzed.gate
  }
}
