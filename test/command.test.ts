import assert from 'node:assert/strict'
import test from 'node:test'

import type { ResolvedConfig } from '../src/config.ts'
import { parseGrokbotInput } from '../src/command/parse.ts'
import { createGrokbotCommand, type CommandDefinitionLike, type TuiDialogsLike } from '../src/command/register.ts'
import type { GrokAgentRecord, GrokSendReceipt, GrokTranscriptTail } from '../src/grok/gateway.ts'
import { messagesFor } from '../src/messages.ts'
import type { GrokBotService } from '../src/service.ts'

const config: ResolvedConfig = {
  appSession: true,
  requestTimeoutMs: 30_000,
  maxResponseBytes: 1024,
  defaultThreadLimit: 40,
  locale: 'en',
}

const messages = messagesFor('en')

function record(overrides: Partial<GrokAgentRecord> = {}): GrokAgentRecord {
  return {
    id: 'bot-1',
    name: 'Researcher',
    title: 'Research',
    description: '',
    avatarShape: '',
    avatarColor: '',
    isGroup: false,
    memberIds: [],
    ...overrides,
  }
}

const secondBot = record({ id: 'bot-2', name: 'Support Bot', title: 'Support' })

function receipt(target: GrokAgentRecord): GrokSendReceipt {
  return { target, result: {}, delivery: 'accepted', messageId: 'message-1', clientNonce: 'nonce-1' }
}

function tail(target: GrokAgentRecord, entries: readonly unknown[]): GrokTranscriptTail {
  return { target, transcript: { entries } }
}

function fakeService(overrides: Record<string, unknown> = {}): GrokBotService {
  return {
    targets: async () => [record()],
    send: async () => receipt(record()),
    thread: async () => tail(record(), []),
    ...overrides,
  } as unknown as GrokBotService
}

function fakeDialogs(answers: { select?: (request: unknown) => Promise<string | undefined>; input?: (request: unknown) => Promise<string | undefined> }): TuiDialogsLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async select(request) {
      calls.push('select')
      return await (answers.select?.(request) ?? Promise.resolve(undefined))
    },
    async input(request) {
      calls.push('input')
      return await (answers.input?.(request) ?? Promise.resolve(undefined))
    },
  }
}

function handlerOf(command: CommandDefinitionLike): (rawInput: string, dialogs?: TuiDialogsLike, service?: GrokBotService) => Promise<{ kind: string; text?: string }> {
  return async (rawInput, dialogs, service) => {
    const built = service === undefined
      ? command
      : createGrokbotCommand({ service, config, messages, ...(dialogs === undefined ? {} : { dialogs: () => dialogs }) })
    const invocation = {
      agent: { id: 'session-1' },
      rawInput,
      signal: new AbortController().signal,
    }
    return await built.handler(invocation) as { kind: string; text?: string }
  }
}

test('the parser treats free text as a message and keeps shape words optional', () => {
  const targets = [record(), secondBot]
  assert.deepEqual(parseGrokbotInput('', targets), { kind: 'list', query: '' })
  assert.deepEqual(parseGrokbotInput('  你好  ', targets), { kind: 'send', message: '你好' })
  assert.deepEqual(parseGrokbotInput('send 你好', targets), { kind: 'send', message: '你好' })
  assert.deepEqual(parseGrokbotInput('list researcher', targets), { kind: 'list', query: 'researcher' })
})

test('the parser recognises a roster target by longest prefix', () => {
  const targets = [record({ id: 'support', name: 'Support' }), secondBot]
  assert.deepEqual(parseGrokbotInput('send Support Bot 你好', targets), {
    kind: 'send',
    targetRef: 'bot-2',
    message: '你好',
  })
  assert.deepEqual(parseGrokbotInput('send Support', targets), { kind: 'send', targetRef: 'support' })
})

test('the parser accepts a literal message after --', () => {
  assert.deepEqual(parseGrokbotInput('send -- Support Bot 你好', [secondBot]), {
    kind: 'send',
    message: 'Support Bot 你好',
  })
})

test('the parser reads limits and targets', () => {
  const targets = [secondBot]
  assert.deepEqual(parseGrokbotInput('read', targets), { kind: 'read' })
  assert.deepEqual(parseGrokbotInput('read 10', targets), { kind: 'read', limit: 10 })
  assert.deepEqual(parseGrokbotInput('read Support Bot 5', targets), {
    kind: 'read',
    targetRef: 'bot-2',
    limit: 5,
  })
  assert.deepEqual(parseGrokbotInput('read nobody', targets), { kind: 'read', targetRef: 'nobody' })
})

test('a bare /grokbot lists the roster and the usage line', async () => {
  const result = await handlerOf(createGrokbotCommand({ service: fakeService(), config, messages }))('')
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /1 Grok Bot target/)
  assert.match(result.text ?? '', /Researcher/)
  assert.match(result.text ?? '', /Usage:/)
})

test('free text asks which bot and sends the text as typed', async () => {
  const sent: Array<{ ref: string; message: string }> = []
  const service = fakeService({
    targets: async () => [record(), secondBot],
    send: async (ref: string, message: string) => {
      sent.push({ ref, message })
      return receipt(secondBot)
    },
  })
  const dialogs = fakeDialogs({ select: async () => 'bot-2' })
  const command = createGrokbotCommand({ service, config, messages, dialogs: () => dialogs })
  const result = await handlerOf(command)('方便的话回我一句')
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /Sent to Support Bot/)
  assert.deepEqual(sent, [{ ref: 'bot-2', message: '方便的话回我一句' }])
  assert.deepEqual(dialogs.calls, ['select'])
})

test('send <bot> only asks for the message', async () => {
  const sent: Array<{ ref: string; message: string }> = []
  const service = fakeService({
    targets: async () => [record(), secondBot],
    send: async (ref: string, message: string) => {
      sent.push({ ref, message })
      return receipt(secondBot)
    },
  })
  const dialogs = fakeDialogs({ input: async () => '上线了吗' })
  const command = createGrokbotCommand({ service, config, messages, dialogs: () => dialogs })
  const result = await handlerOf(command)('send Support Bot')
  assert.equal(result.kind, 'success')
  assert.deepEqual(sent, [{ ref: 'bot-2', message: '上线了吗' }])
  assert.deepEqual(dialogs.calls, ['input'])
})

test('a single visible target is still confirmed before sending', async () => {
  const sent: Array<{ ref: string; message: string }> = []
  const service = fakeService({
    send: async (ref: string, message: string) => {
      sent.push({ ref, message })
      return receipt(record())
    },
  })
  const dialogs = fakeDialogs({ select: async () => 'bot-1' })
  const command = createGrokbotCommand({ service, config, messages, dialogs: () => dialogs })
  const result = await handlerOf(command)('你好')
  assert.equal(result.kind, 'success')
  assert.deepEqual(sent, [{ ref: 'bot-1', message: '你好' }])
  assert.deepEqual(dialogs.calls, ['select'])
})

test('cancelling the picker settles as cancelled, not as an error', async () => {
  const service = fakeService({ targets: async () => [record(), secondBot] })
  const dialogs = fakeDialogs({ select: async () => undefined })
  const command = createGrokbotCommand({ service, config, messages, dialogs: () => dialogs })
  const result = await handlerOf(command)('你好')
  assert.equal(result.kind, 'success')
  assert.equal(result.text, messages.cancelled)
})

test('a host without dialogs answers a missing target with usage', async () => {
  const service = fakeService({ targets: async () => [record(), secondBot] })
  const command = createGrokbotCommand({ service, config, messages })
  const result = await handlerOf(command)('你好')
  assert.equal(result.kind, 'error')
  assert.equal(result.text, messages.targetRequired)
})

test('read reuses the target remembered from the previous send', async () => {
  const read: Array<{ ref: string; limit: number }> = []
  const service = fakeService({
    targets: async () => [record(), secondBot],
    send: async () => receipt(secondBot),
    thread: async (ref: string, limit: number) => {
      read.push({ ref, limit })
      return tail(secondBot, [{ id: 'e1', kind: 'message', role: 'assistant', text: '好的' }])
    },
  })
  const command = createGrokbotCommand({ service, config, messages })
  await handlerOf(command)('send Support Bot 上线了吗')
  const result = await handlerOf(command)('read')
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /Support Bot/)
  assert.deepEqual(read, [{ ref: 'bot-2', limit: 40 }])
})

test('gateway failures settle as command errors', async () => {
  const service = fakeService({
    targets: async () => {
      throw new Error('No Grok Bot credentials')
    },
  })
  const command = createGrokbotCommand({ service, config, messages })
  const result = await handlerOf(command)('')
  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'No Grok Bot credentials')
})
