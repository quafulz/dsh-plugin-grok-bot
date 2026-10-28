import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { apply } from '../src/index.ts'
import { GrokBotService } from '../src/service.ts'

function registeredTools(): Map<string, ToolDefinition> {
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
  return registered
}

const record = {
  id: 'bot-1',
  name: 'Researcher',
  title: 'Research',
  description: 'Investigate things',
  avatarShape: '',
  avatarColor: '',
  isGroup: false,
  memberIds: [],
}

test('grok_targets renders and returns a bounded target list', async () => {
  const tools = registeredTools()
  const original = GrokBotService.prototype.targets
  GrokBotService.prototype.targets = async () => [record]
  try {
    const value = await tools.get('grok_targets')?.execute(
      { kind: 'all', query: 'research' },
      { signal: new AbortController().signal } as never,
    ) as { count: number; targets: Array<{ id: string; kind: string }> }
    assert.equal(value.count, 1)
    assert.equal(value.targets[0]?.id, 'bot-1')
    assert.equal(value.targets[0]?.kind, 'bot')
  } finally {
    GrokBotService.prototype.targets = original
  }
})

test('grok_send returns a receipt and grok_thread projects entries', async () => {
  const tools = registeredTools()
  const originalSend = GrokBotService.prototype.send
  const originalThread = GrokBotService.prototype.thread
  GrokBotService.prototype.send = async () => ({
    target: record,
    result: { ok: true },
    delivery: 'accepted',
    messageId: 'message-1',
    clientNonce: 'nonce-1',
  })
  GrokBotService.prototype.thread = async () => ({
    target: record,
    transcript: {
      entries: [
        { id: 'entry-1', kind: 'message', role: 'assistant', text: 'answer' },
      ],
    },
  })
  try {
    const sent = await tools.get('grok_send')?.execute(
      { target: 'Researcher', message: 'investigate' },
      { signal: new AbortController().signal } as never,
    ) as { delivery: string; messageId: string; result: { ok: boolean } }
    assert.equal(sent.delivery, 'accepted')
    assert.equal(sent.messageId, 'message-1')
    assert.equal(sent.result.ok, true)

    const read = await tools.get('grok_thread')?.execute(
      { target: 'Researcher', full: true },
      { signal: new AbortController().signal } as never,
    ) as { entryCount: number; gapReset: boolean; entries?: Array<{ text: string }> }
    assert.equal(read.entryCount, 1)
    assert.equal(read.gapReset, false)
    assert.equal(read.entries?.[0]?.text, 'answer')
  } finally {
    GrokBotService.prototype.send = originalSend
    GrokBotService.prototype.thread = originalThread
  }
})

test('grok_send rejects an empty message before calling the gateway', async () => {
  const tools = registeredTools()
  await assert.rejects(
    () => tools.get('grok_send')?.execute(
      { target: 'Researcher', message: '   ' },
      { signal: new AbortController().signal } as never,
    ) as Promise<unknown>,
    /message must not be empty/,
  )
})
