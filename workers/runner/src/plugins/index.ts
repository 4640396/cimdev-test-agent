import { mavenTestPlugin } from './maven-test.js'
import { qualityGatePlugin } from './quality-gate.js'
import { WorkerPluginRuntime, type WorkerPluginPolicy } from './runtime.js'
import { testPlanPlugin } from './test-plan.js'

export function parsePluginPolicyConfig(raw: string | undefined): Record<string, Partial<WorkerPluginPolicy>> {
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('TEST_AGENT_PLUGIN_POLICY_JSON must be an object')
  return parsed as Record<string, Partial<WorkerPluginPolicy>>
}

export function createWorkerPluginRuntime(policyOverrides: Readonly<Record<string, Partial<WorkerPluginPolicy>>> = {}): WorkerPluginRuntime {
  const known = new Set(['test_plan', 'maven_test', 'quality_gate'])
  const unknown = Object.keys(policyOverrides).filter((name) => !known.has(name))
  if (unknown.length > 0) throw new Error(`Unknown plugin policy: ${unknown.join(', ')}`)
  const runtime = new WorkerPluginRuntime(policyOverrides)
  runtime.register(testPlanPlugin)
  runtime.register(mavenTestPlugin)
  runtime.register(qualityGatePlugin)
  runtime.seal()
  return runtime
}

export type { VerificationCheck } from './quality-gate.js'
