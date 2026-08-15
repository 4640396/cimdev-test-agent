import type { AgentAdapter } from './types.js'
import { ClaudeCodeAdapter, resolveClaudeExecutable } from './claude-code-adapter.js'
import { createCimiCodeAdapter } from '../cimicode/adapter.js'
import { LocalGoAdapter } from './local-go-adapter.js'
import { CodexCliAdapter, resolveCodexExecutable } from './codex-cli-adapter.js'
import { ExistingMavenAdapter } from './existing-maven-adapter.js'

export function createAgentAdapter(): AgentAdapter | null {
  if (process.env.TEST_AGENT_PROVIDER === 'existing-maven') return new ExistingMavenAdapter()
  if (process.env.TEST_AGENT_PROVIDER === 'cimicode') return createCimiCodeAdapter()
  if (process.env.TEST_AGENT_PROVIDER === 'codex-cli') {
    const codex = resolveCodexExecutable()
    return codex ? new CodexCliAdapter(codex) : null
  }
  if (process.env.TEST_AGENT_PROVIDER === 'claude-code') {
    const claude = resolveClaudeExecutable()
    return claude ? new ClaudeCodeAdapter(claude) : null
  }
  return new LocalGoAdapter()
}
