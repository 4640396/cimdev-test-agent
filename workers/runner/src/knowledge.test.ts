import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildKnowledgeContext, collectKnowledgeRefs, resolveKnowledgeRoots } from './knowledge.js'

const projects: string[] = []

function makeRoot(files: Record<string, string>): string {
  const root = join(tmpdir(), `cimdev-knowledge-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  projects.push(root)
  return root
}

afterAll(() => {
  for (const project of projects) {
    try {
      rmSync(project, { recursive: true, force: true })
    } catch {
      // 忽略清理失败
    }
  }
})

describe('knowledge provider', () => {
  it('知识库根目录合并 任务级 + 项目配置 + 环境变量（默认仅兜底），并跳过不存在的目录', () => {
    const project = makeRoot({ 'knowledge/demo-rules.md': '# demo 规则' })
    const explicit = makeRoot({ 'rules.md': '# 规则' })
    const missing = join(tmpdir(), 'cimdev-missing-' + Math.random().toString(36).slice(2))

    const roots = resolveKnowledgeRoots({ knowledgeRoots: [explicit, missing] }, project)
    expect(roots).toEqual([explicit])

    const fromConfig = makeRoot({ 'config.md': '# 配置' })
    writeFileSync(join(project, 'test-agent.config.json'), JSON.stringify({ knowledgeRoots: [fromConfig] }), 'utf8')
    expect(resolveKnowledgeRoots({}, project)).toEqual([fromConfig])

    const oldEnv = process.env.TEST_AGENT_KNOWLEDGE_ROOT
    process.env.TEST_AGENT_KNOWLEDGE_ROOT = fromConfig
    try {
      expect(resolveKnowledgeRoots({ knowledgeRoots: [explicit] }, project)).toEqual([explicit, fromConfig])
      const emptyProject = makeRoot({ 'x.txt': 'x' })
      expect(resolveKnowledgeRoots({}, emptyProject)).toEqual([fromConfig])
    } finally {
      if (oldEnv === undefined) delete process.env.TEST_AGENT_KNOWLEDGE_ROOT
      else process.env.TEST_AGENT_KNOWLEDGE_ROOT = oldEnv
    }
  })

  it('按系统名匹配知识文件，生成带来源与类型的 ref，缺失时降级', () => {
    const root = makeRoot({
      'demo/business-rules.md': '# demo 业务规则\n状态不能从已关闭回到处理中',
      'other/notes.md': '# 其他系统说明',
      'demo/historical-defects/bug-101.md': '# 历史缺陷 101'
    })
    const matched = collectKnowledgeRefs([root], 'demo')
    expect(matched.degraded).toBe(false)
    expect(matched.refs.length).toBe(2)
    expect(matched.refs.map((ref) => ref.type).sort()).toEqual(['business-rule', 'historical-defect'])
    expect(matched.refs.every((ref) => ref.source.startsWith('demo/'))).toBe(true)
    expect(matched.refs.every((ref) => ref.version === null)).toBe(true)

    const noMatch = collectKnowledgeRefs([root], 'nosuchsystem')
    expect(noMatch.degraded).toBe(true)
    expect(noMatch.refs.length).toBe(0)

    const context = buildKnowledgeContext(matched)
    expect(context).toContain('[来源 demo/business-rules.md')
    expect(context).toContain('业务规则')
  })
})
