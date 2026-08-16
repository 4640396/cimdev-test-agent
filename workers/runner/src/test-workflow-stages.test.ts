import { describe, expect, it } from 'vitest'
import { runAnalyzingStage, runGeneratingStage, runValidatingStage } from './test-workflow-stages.js'

describe('test workflow stages', () => {
  it('exposes the three real stage functions', () => {
    expect(typeof runGeneratingStage).toBe('function')
    expect(typeof runValidatingStage).toBe('function')
    expect(typeof runAnalyzingStage).toBe('function')
  })
})
