import { describe, expect, it } from 'vitest'
import { createTestWorkflowStages } from './test-workflow-stages.js'

describe('test workflow stages', () => {
  it('exposes the three expected stages', () => {
    expect(createTestWorkflowStages().map((stage) => stage.name)).toEqual(['generating', 'validating', 'analyzing'])
  })
})
