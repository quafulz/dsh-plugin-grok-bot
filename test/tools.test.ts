import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { apply } from '../src/index.ts'
import { AttachmentDownloadLinks } from '../src/grok/attachment-links.ts'
import { GrokBotService } from '../src/service.ts'
import { registerThreadTool } from '../src/tools/thread.ts'

function registeredTools(): Map<string, ToolDefinition> {
  const registered = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        registered.set(definition.name, definition)
        return () => {}
      },
    },
    // Tools are the subject here; the command and skill forks never run.
    inject() {},
    logger: { warn() {} },
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
    ) as { entryCount: number; gapReset: boolean; entries?: Array<{ text: string; speaker: string }> }
    assert.equal(read.entryCount, 1)
    assert.equal(read.gapReset, false)
    assert.equal(read.entries?.[0]?.text, 'answer')
    assert.equal(read.entries?.[0]?.speaker, 'assistant')
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

test('grok_thread rendering uses speakers and keeps attachment links', async () => {
  const tools = registeredTools()
  const originalThread = GrokBotService.prototype.thread
  GrokBotService.prototype.thread = async () => ({
    target: record,
    transcript: {
      entries: [
        { id: 'entry-1', kind: 'message', role: 'user', content: 'question' },
        { id: 'entry-2', kind: 'send-message', message: { type: 'text', content: 'answer' } },
        {
          id: 'entry-3',
          kind: 'send-message',
          message: {
            type: 'attachment',
            file_name: 'form.pdf',
            url: 'https://example.com/form.pdf',
          },
        },
      ],
    },
  })
  try {
    const tool = tools.get('grok_thread')
    const read = await tool?.execute(
      { target: 'Researcher', full: true },
      { signal: new AbortController().signal } as never,
    )
    const rendered = tool?.output.render(
      { target: 'Researcher', full: true },
      read as never,
    )
    const text = rendered?.[0]?.type === 'text' ? rendered[0].text : ''
    assert.match(text, /You\nquestion/)
    assert.match(text, /Researcher\nanswer/)
    assert.match(text, /form\.pdf/)
    assert.match(text, /https:\/\/example\.com\/form\.pdf/)
    assert.doesNotMatch(text, /send-message/)
  } finally {
    GrokBotService.prototype.thread = originalThread
  }
})

test('grok_thread uses the attachment linker for cloud file URLs', async () => {
  const registered = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        registered.set(definition.name, definition)
        return () => {}
      },
    },
  } as unknown as Context
  const raw = 'file:///home/box/agent-data/agents/bot/assets/form.pdf'
  const service = {
    async thread() {
      return {
        target: record,
        transcript: {
          entries: [{
            id: 'entry-1',
            kind: 'send-message',
            message: { type: 'attachment', file_name: 'form.pdf', url: raw },
          }],
        },
      }
    },
    async readAttachmentChunk() {
      throw new Error('not downloaded')
    },
  } as unknown as GrokBotService
  const links = new AttachmentDownloadLinks(service)
  try {
    registerThreadTool(ctx, service, {
      appSession: true,
      requestTimeoutMs: 30_000,
      maxResponseBytes: 2 * 1024 * 1024,
      defaultThreadLimit: 40,
      locale: 'en',
    }, links)
    const read = await registered.get('grok_thread')?.execute(
      { target: 'Researcher', full: true },
      { signal: new AbortController().signal } as never,
    )
    const text = JSON.stringify(read)
    assert.match(text, /http:\/\/127\.0\.0\.1:\d+\/d\/[0-9a-f]{32}/u)
    assert.doesNotMatch(text, /file:\/\/\/home\/box/)
  } finally {
    links.close()
  }
})
