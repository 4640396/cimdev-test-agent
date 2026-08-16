import { describe, expect, it } from 'vitest'
import { runWorkflow } from './workflow.js'

describe('workflow stage runner', () => {
  it('runs stages in order and records durations', async () => {
    const calls: string[] = []
    const results = await runWorkflow([
      { name: 'generating', run: () => { calls.push('generating') } },
      { name: 'validating', run: () => { calls.push('validating') } },
      { name: 'analyzing', run: () => { calls.push('analyzing') } }
    ])
    expect(calls).toEqual(['generating', 'validating', 'analyzing'])
    expect(results.map((item) => item.status)).toEqual(['passed', 'passed', 'passed'])
  })

  it('stops on the first failed stage', async () => {
    const results = await runWorkflow([
      { name: 'generating', run: () => { throw new Error('boom') } },
      { name: 'validating', run: () => {} }
    ])
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ name: 'generating', status: 'failed' })
  })
})
