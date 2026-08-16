import { runMavenUnitTests } from '../validator.js'
import type { MavenExecutor } from './runtime.js'

export const localMavenExecutor: MavenExecutor = {
  name: 'maven',
  requiredCapabilities: ['java'],
  execute(context) {
    return runMavenUnitTests(context.projectPath, context.signal, context.sandbox)
  }
}
