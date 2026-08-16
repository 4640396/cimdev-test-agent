import type { TestWorkflowContext, TestWorkflowRun } from './test-workflow.js'

export function createTestWorkflowStages(): TestWorkflowRun['stages'] {
  return [
    {
      name: 'generating',
      async run(_context: TestWorkflowContext) {
        // 生成阶段将在独立文件完成后接入真实逻辑
      }
    },
    {
      name: 'validating',
      async run(_context: TestWorkflowContext) {
        // 验证阶段将在独立文件完成后接入真实逻辑
      }
    },
    {
      name: 'analyzing',
      async run(_context: TestWorkflowContext) {
        // 分析阶段将在独立文件完成后接入真实逻辑
      }
    }
  ]
}
