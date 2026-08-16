import type { MavenTestOutcome } from '../validator.js'

export interface TestExecutorContext {
  projectPath: string
  signal: AbortSignal
  sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }
}

export interface TestExecutorProvider<Result> {
  readonly name: string
  readonly requiredCapabilities: readonly string[]
  execute(context: TestExecutorContext): Promise<Result>
}

type AnyProvider = TestExecutorProvider<unknown>

/** Provider registry separating test intent from local, sandboxed or remote execution. */
export class TestExecutorRegistry {
  private readonly providers = new Map<string, AnyProvider>()
  private sealed = false

  register<Result>(provider: TestExecutorProvider<Result>): () => void {
    if (this.sealed) throw new Error('Test executor registry is sealed')
    if (this.providers.has(provider.name)) throw new Error(`Test executor already registered: ${provider.name}`)
    this.providers.set(provider.name, provider as AnyProvider)
    return () => { this.providers.delete(provider.name) }
  }

  seal(): void { this.sealed = true }

  resolve<Result>(name: string, capabilities: readonly string[]): TestExecutorProvider<Result> {
    const provider = this.providers.get(name) as TestExecutorProvider<Result> | undefined
    if (!provider) throw new Error(`Unknown test executor: ${name}`)
    const missing = provider.requiredCapabilities.filter((capability) => !capabilities.includes(capability))
    if (missing.length > 0) throw new Error(`${name} requires capabilities: ${missing.join(', ')}`)
    return provider
  }
}

export type MavenExecutor = TestExecutorProvider<MavenTestOutcome>
