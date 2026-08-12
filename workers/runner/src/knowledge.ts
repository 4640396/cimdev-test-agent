import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

export interface KnowledgeRef {
  source: string
  root: string
  version: string | null
  type: string
  content: string
}

export interface KnowledgeContext {
  refs: KnowledgeRef[]
  degraded: boolean
  reason?: string
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.test-agent', '.test-agent-worker', 'legacy'])
const MAX_REF_SIZE = 20_000
const MAX_TOTAL_SIZE = 40_000

export function loadProjectConfig(projectPath: string): { knowledgeRoots?: string[] } {
  try {
    const parsed = JSON.parse(readFileSync(join(projectPath, 'test-agent.config.json'), 'utf8')) as { knowledgeRoots?: unknown }
    if (Array.isArray(parsed.knowledgeRoots)) {
      return { knowledgeRoots: parsed.knowledgeRoots.filter((item): item is string => typeof item === 'string') }
    }
  } catch {
    // 无配置时忽略
  }
  return {}
}

/** 知识库根目录解析优先级：任务级 knowledgeRoots > 项目 test-agent.config.json > 环境变量 TEST_AGENT_KNOWLEDGE_ROOT > 默认 <项目>/knowledge。 */
export function resolveKnowledgeRoots(input: { knowledgeRoots?: string[] }, projectPath: string): string[] {
  const projectConfig = loadProjectConfig(projectPath)
  const envRoot = process.env.TEST_AGENT_KNOWLEDGE_ROOT
  const candidates = [
    ...(input.knowledgeRoots ?? []),
    ...(projectConfig.knowledgeRoots ?? []),
    ...(envRoot ? envRoot.split(';').map((item) => item.trim()).filter(Boolean) : [])
  ]
  if (candidates.length === 0) {
    const defaultRoot = join(projectPath, 'knowledge')
    if (existsSync(defaultRoot)) candidates.push(defaultRoot)
  }
  const roots: string[] = []
  for (const candidate of candidates) {
    const absolute = resolve(projectPath, candidate)
    try {
      if (statSync(absolute).isDirectory()) roots.push(absolute)
    } catch {
      // 不存在的根目录跳过，降级时披露
    }
  }
  return [...new Set(roots)]
}

function gitVersion(root: string): string | null {
  try {
    const result = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
  } catch {
    // 非 git 目录返回 null
  }
  return null
}

function refType(path: string): string {
  const name = basename(path).toLowerCase()
  const dir = basename(join(path, '..')).toLowerCase()
  if (dir.includes('rule') || name.includes('rule')) return 'business-rule'
  if (dir.includes('defect') || name.includes('defect') || name.includes('bug')) return 'historical-defect'
  if (dir.includes('baseline') || name.includes('baseline')) return 'baseline'
  return 'doc'
}

export function collectKnowledgeRefs(roots: string[], systemName: string): KnowledgeContext {
  const refs: KnowledgeRef[] = []
  let total = 0
  const keyword = systemName.toLowerCase().trim()
  for (const root of roots) {
    const version = gitVersion(root)
    const walk = (dir: string, depth: number): void => {
      if (depth > 5 || total >= MAX_TOTAL_SIZE) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry)
        let stat
        try {
          stat = statSync(full)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(basename(full))) walk(full, depth + 1)
        } else if (/\.(md|markdown|txt|yaml|yml)$/i.test(entry)) {
          const rel = relative(root, full).replace(/\\/g, '/')
          if (keyword && !rel.toLowerCase().includes(keyword)) continue
          try {
            const content = readFileSync(full, 'utf8')
            if (content.length > MAX_REF_SIZE) continue
            refs.push({ source: rel, root, version, type: refType(full), content })
            total += content.length
          } catch {
            // 跳过不可读文件
          }
        }
      }
    }
    walk(root, 0)
  }
  if (refs.length === 0) return { refs: [], degraded: true, reason: '未配置或未找到匹配知识文件，降级为代码推导' }
  return { refs, degraded: false }
}

export function buildKnowledgeContext(context: KnowledgeContext): string {
  if (context.refs.length === 0) return ''
  const parts = context.refs.map((ref) => `[来源 ${ref.source}（版本 ${ref.version ?? 'unversioned'}，类型 ${ref.type}）]\n${ref.content.trim()}`)
  return ['以下是系统业务知识，仅作带来源的参考；与代码实现冲突时转人工确认：', ...parts].join('\n\n---\n\n')
}
