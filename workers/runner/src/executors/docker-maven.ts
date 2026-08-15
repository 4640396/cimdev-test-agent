import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { runMavenCommand } from '../validator.js'
import type { MavenExecutor } from './runtime.js'

export interface DockerMavenConfig {
  image: string
  memory: string
  cpus: string
  pidsLimit: number
  repositoryPath?: string
}

const SAFE_VALUE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/

export function validateDockerMavenConfig(config: DockerMavenConfig): DockerMavenConfig {
  if (!SAFE_VALUE.test(config.image)) throw new TypeError('Docker Maven image contains unsupported characters')
  if (!/^\d+(?:[kKmMgG])?$/.test(config.memory)) throw new TypeError('Docker Maven memory must be a Docker size such as 2g')
  if (!/^\d+(?:\.\d+)?$/.test(config.cpus) || Number(config.cpus) <= 0) throw new TypeError('Docker Maven cpus must be positive')
  if (!Number.isInteger(config.pidsLimit) || config.pidsLimit < 32 || config.pidsLimit > 4096) throw new TypeError('Docker Maven pidsLimit must be 32..4096')
  if (config.repositoryPath !== undefined) {
    if (!isAbsolute(config.repositoryPath) || /[,\r\n]/.test(config.repositoryPath)) throw new TypeError('Docker Maven repository must be an absolute mount-safe path')
    if (!existsSync(config.repositoryPath) || !statSync(config.repositoryPath).isDirectory()) throw new TypeError('Docker Maven repository must be an existing directory')
  }
  return config
}

export function dockerMavenArgs(projectPath: string, config: DockerMavenConfig): string[] {
  validateDockerMavenConfig(config)
  const source = resolve(projectPath)
  if (/[,\r\n]/.test(source)) throw new TypeError('Project path is not safe for a Docker mount')
  const args = [
    'run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--pids-limit', String(config.pidsLimit),
    '--memory', config.memory, '--cpus', config.cpus, '--mount', `type=bind,source=${source},target=/workspace`
  ]
  if (config.repositoryPath) args.push('--mount', `type=bind,source=${resolve(config.repositoryPath)},target=/maven-repo,readonly`)
  args.push('--workdir', '/workspace', config.image, 'mvn', '--batch-mode', '--no-transfer-progress')
  if (config.repositoryPath) args.push('--offline', '-Dmaven.repo.local=/maven-repo')
  args.push('test')
  return args
}

export function createDockerMavenExecutor(config: DockerMavenConfig): MavenExecutor {
  validateDockerMavenConfig(config)
  return {
    name: 'maven',
    requiredCapabilities: ['docker'],
    execute(context) {
      return runMavenCommand(context.projectPath, { command: 'docker', args: dockerMavenArgs(context.projectPath, config), cwd: context.projectPath }, context.signal)
    }
  }
}
