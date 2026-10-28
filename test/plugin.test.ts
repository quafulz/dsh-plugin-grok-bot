import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { apply } from '../src/index.ts'

test('registers the three focused Grok Bot tools', () => {
  const registered = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        registered.set(definition.name, definition)
        return () => {}
      },
    },
  } as unknown as Context

  apply(ctx, {
    appSession: true,
    requestTimeoutMs: 30_000,
    maxResponseBytes: 2 * 1024 * 1024,
    defaultThreadLimit: 40,
  })

  assert.deepEqual([...registered.keys()].sort(), [
    'grok_send',
    'grok_targets',
    'grok_thread',
  ])
  assert.equal(registered.get('grok_send')?.parameters.required?.includes('target'), true)
  assert.equal(registered.get('grok_thread')?.parameters.required?.includes('target'), true)
  assert.equal(registered.get('grok_targets')?.parameters.required, undefined)
})
