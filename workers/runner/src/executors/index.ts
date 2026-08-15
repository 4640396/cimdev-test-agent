import { createDockerMavenExecutor, type DockerMavenConfig } from './docker-maven.js'
import { localMavenExecutor } from './maven.js'
import { TestExecutorRegistry } from './runtime.js'

export interface TestExecutionConfig {
  mode: 'local' | 'docker'
  docker: DockerMavenConfig
}

export function parseTestExecutionConfig(env: NodeJS.ProcessEnv = process.env): TestExecutionConfig {
  const mode = env.TEST_AGENT_EXECUTION_MODE ?? 'local'
  if (mode !== 'local' && mode !== 'docker') throw new TypeError('TEST_AGENT_EXECUTION_MODE must be local or docker')
  return {
    mode,
    docker: {
      image: env.TEST_AGENT_MAVEN_DOCKER_IMAGE ?? 'maven:3.9.11-eclipse-temurin-17',
      memory: env.TEST_AGENT_EXECUTION_MEMORY ?? '2g',
      cpus: env.TEST_AGENT_EXECUTION_CPUS ?? '2',
      pidsLimit: Number(env.TEST_AGENT_EXECUTION_PIDS_LIMIT ?? '512'),
      repositoryPath: env.TEST_AGENT_MAVEN_REPOSITORY || undefined
    }
  }
}

export function createTestExecutorRegistry(config: TestExecutionConfig = parseTestExecutionConfig()): TestExecutorRegistry {
  const registry = new TestExecutorRegistry()
  registry.register(config.mode === 'docker' ? createDockerMavenExecutor(config.docker) : localMavenExecutor)
  registry.seal()
  return registry
}

export { TestExecutorRegistry } from './runtime.js'
