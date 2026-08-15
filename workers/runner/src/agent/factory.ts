import type { AgentAdapter } from './types.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeCodeAdapter, resolveClaudeExecutable } from './claude-code-adapter.js'
import { createCimiCodeAdapter } from '../cimicode/adapter.js'
import { LocalGoAdapter } from './local-go-adapter.js'
import { CodexCliAdapter, resolveCodexExecutable } from './codex-cli-adapter.js'
import { ExistingMavenAdapter } from './existing-maven-adapter.js'
import { NodeAdapter } from './node-adapter.js'

export function createAgentAdapter(projectPath?: string): AgentAdapter | null {
  const explicit = process.env.TEST_AGENT_PROVIDER?.trim()
  const detected = explicit
    ?? (projectPath && existsSync(join(projectPath, 'pom.xml'))
      ? 'existing-maven'
      : projectPath && existsSync(join(projectPath, 'package.json'))
        ? 'node'
        : 'existing-maven')
  const provider = detected
  if (provider === 'existing-maven') return new ExistingMavenAdapter()
  if (provider === 'node') return new NodeAdapter()
  if (provider === 'local-go') return new LocalGoAdapter()
  if (provider === 'cimicode') return createCimiCodeAdapter()
  if (provider === 'codex-cli') {
    const codex = resolveCodexExecutable()
    return codex ? new CodexCliAdapter(codex) : null
  }
  if (provider === 'claude-code') {
    const claude = resolveClaudeExecutable()
    return claude ? new ClaudeCodeAdapter(claude) : null
  }
  throw new Error(`Unsupported TEST_AGENT_PROVIDER: ${provider}`)
}

/**
 * Local Host provider selection. The desktop product is AI-first: when the
 * host opts into AI mode, prefer Codex CLI (read code, generate tests, run,
 * fix and collect coverage), then Claude Code, then the deterministic
 * existing-suite adapters as a safe fallback.
 */
export function createHostAgentAdapter(projectPath: string, preferAi: boolean): AgentAdapter | null {
  if (preferAi && !process.env.TEST_AGENT_PROVIDER?.trim()) {
    const codex = resolveCodexExecutable()
    if (codex) return new CodexCliAdapter(codex)
    const claude = resolveClaudeExecutable()
    if (claude) return new ClaudeCodeAdapter(claude)
  }
  return createAgentAdapter(projectPath)
}
