import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentAdapter } from './factory.js'

const originalProvider = process.env.TEST_AGENT_PROVIDER

afterEach(() => {
  if (originalProvider === undefined) delete process.env.TEST_AGENT_PROVIDER
  else process.env.TEST_AGENT_PROVIDER = originalProvider
})

describe('createAgentAdapter', () => {
  it('defaults to the deterministic Maven provider', () => {
    delete process.env.TEST_AGENT_PROVIDER
    expect(createAgentAdapter()?.name).toBe('Existing Maven Suite')
  })

  it('keeps the legacy Go provider explicit', () => {
    process.env.TEST_AGENT_PROVIDER = 'local-go'
    expect(createAgentAdapter()?.name).toBe('Local Go Runner')
  })

  it('rejects unknown providers during worker startup', () => {
    process.env.TEST_AGENT_PROVIDER = 'typo-provider'
    expect(() => createAgentAdapter()).toThrow('Unsupported TEST_AGENT_PROVIDER')
  })

  it('auto-detects the Node provider from package.json when no provider is configured', () => {
    delete process.env.TEST_AGENT_PROVIDER
    const root = mkdtempSync(join(tmpdir(), 'factory-node-'))
    writeFileSync(join(root, 'package.json'), '{}')
    try {
      expect(createAgentAdapter(root)?.name).toBe('Existing Node Suite')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
