import assert from 'node:assert/strict'
import test from 'node:test'

import { connectGateway, createGrokClient } from '../src/grok/gateway.ts'
import { GrokBotError } from '../src/grok/errors.ts'

interface CapturedCall {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fakeFetch(handler: (url: string, body: Record<string, unknown>) => Response): {
  fetchImpl: typeof fetch
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : {}
    calls.push({
      url,
      body,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    return handler(url, body)
  }) as typeof fetch
  return { fetchImpl, calls }
}

const session = {
  gatewayUrl: 'https://gateway.cursor.sh/',
  gatewayToken: 'secret-token',
  gatewayHeaders: { 'x-session': 'yes' },
}

const roster = {
  agents: [
    { id: 'bot-1', name: 'Researcher', title: 'Research', isGroup: false },
    { id: 'group-1', name: 'Launch', memberIds: ['bot-1'] },
  ],
}

test('lists and resolves bots and groups', async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(roster))
  const client = createGrokClient(session, { fetchImpl })
  const agents = await client.listAgents()
  assert.equal(agents.length, 2)
  assert.equal(agents.find(agent => agent.id === 'bot-1')?.name, 'Researcher')
  assert.equal(agents.find(agent => agent.id === 'group-1')?.isGroup, true)
  assert.equal(calls[0]?.url, 'https://gateway.cursor.sh/api/listAgents')
  assert.equal(calls[0]?.headers.authorization, 'Bearer secret-token')
  assert.equal(calls[0]?.headers['x-session'], 'yes')
})

test('sendPrompt resolves the target and reports confirmed delivery', async () => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url.endsWith('/listAgents')) return jsonResponse(roster)
    return jsonResponse({ messageId: 'message-1' })
  })
  const client = createGrokClient(session, { fetchImpl })
  const receipt = await client.sendPrompt('Researcher', 'Please investigate')
  assert.equal(receipt.delivery, 'accepted')
  assert.equal(receipt.messageId, 'message-1')
  assert.equal(receipt.target.id, 'bot-1')
  assert.match(receipt.clientNonce, /^[0-9a-f-]{36}$/)
  const send = calls.find(call => call.url.endsWith('/sendPrompt'))
  assert.equal(send?.body.agentId, 'bot-1')
  assert.equal(send?.body.prompt, 'Please investigate')
  assert.equal(calls.filter(call => call.url.endsWith('/getAgentTranscriptTail')).length, 0)
})

test('sendPrompt treats a response without messageId as unknown when confirmation is disabled', async () => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url.endsWith('/listAgents')) return jsonResponse(roster)
    return jsonResponse({})
  })
  const client = createGrokClient(session, { fetchImpl })
  const receipt = await client.sendPrompt('Researcher', 'hello', { confirmDelivery: false })
  assert.equal(receipt.delivery, 'unknown')
  assert.equal(receipt.messageId, undefined)
  assert.equal(calls.filter(call => call.url.endsWith('/getAgentTranscriptTail')).length, 0)
})

test('sendPrompt confirms delivery from the transcript by client nonce', async () => {
  let sentNonce = ''
  let tailReads = 0
  const { fetchImpl, calls } = fakeFetch((url, body) => {
    if (url.endsWith('/listAgents')) return jsonResponse(roster)
    if (url.endsWith('/sendPrompt')) {
      sentNonce = String(body.clientNonce)
      return jsonResponse({ accepted: true })
    }
    tailReads += 1
    return tailReads === 1
      ? jsonResponse({ entries: [{ id: 't0u', kind: 'message', clientNonce: 'someone-else' }] })
      : jsonResponse({
          entries: [
            { id: 't0u', kind: 'message', role: 'user', clientNonce: sentNonce },
            { id: 't0s0', kind: 'send-message', requestId: 'request-1' },
          ],
        })
  })
  const client = createGrokClient(session, { fetchImpl })
  const receipt = await client.sendPrompt('Researcher', 'hello', {
    confirmation: { attempts: 2, delayMs: 0, limit: 25 },
  })
  assert.equal(receipt.delivery, 'accepted')
  assert.equal(receipt.messageId, 't0u')
  assert.equal(receipt.clientNonce, sentNonce)
  const tails = calls.filter(call => call.url.endsWith('/getAgentTranscriptTail'))
  assert.equal(tails.length, 2)
  assert.deepEqual(tails[0]?.body, { id: 'bot-1', limit: 25 })
})

test('sendPrompt stays unknown when the nonce never reaches the transcript', async () => {
  const { fetchImpl } = fakeFetch((url) => {
    if (url.endsWith('/listAgents')) return jsonResponse(roster)
    if (url.endsWith('/sendPrompt')) return jsonResponse({ accepted: true })
    return jsonResponse({ entries: [{ id: 't0u', kind: 'message', clientNonce: 'someone-else' }] })
  })
  const client = createGrokClient(session, { fetchImpl })
  const receipt = await client.sendPrompt('Researcher', 'hello', {
    confirmation: { attempts: 1, delayMs: 0 },
  })
  assert.equal(receipt.delivery, 'unknown')
  assert.equal(receipt.messageId, undefined)
})

test('sendPrompt maps a 4xx response to rejected delivery', async () => {
  const { fetchImpl } = fakeFetch((url) => {
    if (url.endsWith('/listAgents')) return jsonResponse(roster)
    return jsonResponse({ message: 'invalid prompt' }, 400)
  })
  const client = createGrokClient(session, { fetchImpl })
  await assert.rejects(
    () => client.sendPrompt('Researcher', 'hello'),
    (error: unknown) => {
      assert.ok(error instanceof GrokBotError)
      assert.equal(error.delivery, 'rejected')
      assert.equal(error.targetId, 'bot-1')
      return true
    },
  )
})

test('getTranscriptTail resolves the target and forwards the bounded limit', async () => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url.endsWith('/listAgents')) return jsonResponse(roster)
    return jsonResponse({ entries: [{ id: 'entry-1', kind: 'message', text: 'hi' }] })
  })
  const client = createGrokClient(session, { fetchImpl })
  const result = await client.getTranscriptTail('Launch', 999)
  assert.equal(result.target.id, 'group-1')
  const tail = calls.find(call => call.url.endsWith('/getAgentTranscriptTail'))
  assert.deepEqual(tail?.body, { id: 'group-1', limit: 200 })
})

test('readAttachmentChunk reads a size probe and a byte range', async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse({
    totalSize: 12,
    resolvedName: 'form.pdf',
    bytesBase64: Buffer.from('hello').toString('base64'),
  }))
  const client = createGrokClient(session, { fetchImpl })
  const probe = await client.readAttachmentChunk('/home/box/agent-data/form.pdf', 0, 0)
  assert.equal(probe.totalSize, 12)
  assert.equal(probe.resolvedName, 'form.pdf')
  assert.equal(probe.bytesBase64, Buffer.from('hello').toString('base64'))
  const chunk = await client.readAttachmentChunk('/home/box/agent-data/form.pdf', 4, 8)
  assert.equal(chunk.totalSize, 12)
  assert.deepEqual(calls.map(call => call.body), [
    { path: '/home/box/agent-data/form.pdf', offset: 0, length: 0 },
    { path: '/home/box/agent-data/form.pdf', offset: 4, length: 8 },
  ])
  assert.equal(calls[0]?.url, 'https://gateway.cursor.sh/api/readAttachmentChunk')
})

test('connectGateway prefers an explicit gateway environment override', async () => {
  const session = await connectGateway({
    env: {
      GROK_BOT_GATEWAY_URL: 'https://gateway.cursor.sh/',
      GROK_BOT_GATEWAY_TOKEN: 'env-token',
    },
    loadSession: () => {
      throw new Error('app session must not be read when an override exists')
    },
  })
  assert.equal(session.gatewayUrl, 'https://gateway.cursor.sh')
  assert.equal(session.gatewayToken, 'env-token')
})

test('connectGateway can use an injected desktop session', async () => {
  const session = await connectGateway({
    env: {},
    loadSession: () => ({
      gatewayUrl: 'https://gateway.cursor.sh',
      gatewayToken: 'app-token',
      gatewayHeaders: {},
    }),
  })
  assert.equal(session.gatewayToken, 'app-token')
})

test('connectGateway mints a session from the desktop access token', async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse({
    gatewayUrl: 'https://gateway.cursor.sh/',
    gatewayToken: 'minted-token',
    networkToken: 'network-token',
  }))
  const session = await connectGateway({
    env: {},
    appSession: true,
    loadSession: () => null,
    loadAccessToken: () => 'desktop-access-token',
    appVersion: '0.77.0',
    fetchImpl,
  })
  assert.equal(session.gatewayToken, 'minted-token')
  assert.equal(session.gatewayHeaders['x-anyrun-network-token'], 'network-token')
  assert.equal(calls[0]?.url, 'https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox')
  assert.equal(calls[0]?.headers.authorization, 'Bearer desktop-access-token')
  assert.equal(calls[0]?.headers['x-cursor-client-version'], '0.77.0')
  assert.equal(calls[0]?.headers['x-cursor-client-type'], 'sand')
})

test('connectGateway fails loudly when no auth source exists', async () => {
  await assert.rejects(
    () => connectGateway({ env: {}, appSession: false }),
    /No Grok Bot auth found/,
  )
})
