import assert from 'node:assert/strict'
import test from 'node:test'

import type { ResolvedConfig } from '../src/config.ts'
import { GrokBotError } from '../src/grok/errors.ts'
import { createGrokClient } from '../src/grok/gateway.ts'
import { GrokBotService } from '../src/service.ts'

const config: ResolvedConfig = {
  appSession: true,
  requestTimeoutMs: 30_000,
  maxResponseBytes: 1024,
  defaultThreadLimit: 40,
  locale: 'en',
}

const session = {
  gatewayUrl: 'https://gateway.cursor.sh',
  gatewayToken: 'token',
  gatewayHeaders: {},
}

const roster = {
  agents: [{ id: 'bot-1', name: 'Researcher', title: 'Research' }],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('targets reconnects and retries a read after a stale-session 417', async () => {
  let factoryCalls = 0
  let firstCalls = 0
  let secondCalls = 0
  const service = new GrokBotService(config, {
    clientFactory: async () => {
      factoryCalls += 1
      if (factoryCalls === 1) {
        return createGrokClient(session, {
          fetchImpl: async () => {
            firstCalls += 1
            return jsonResponse({ message: 'Expectation Failed' }, 417)
          },
        })
      }
      return createGrokClient(session, {
        fetchImpl: async () => {
          secondCalls += 1
          return jsonResponse(roster)
        },
      })
    },
  })

  const targets = await service.targets()
  assert.equal(targets[0]?.id, 'bot-1')
  assert.equal(factoryCalls, 2)
  assert.equal(firstCalls, 1)
  assert.equal(secondCalls, 1)
})

test('send does not blindly retry after a 417, but drops the stale client', async () => {
  let factoryCalls = 0
  const service = new GrokBotService(config, {
    clientFactory: async () => {
      factoryCalls += 1
      if (factoryCalls === 1) {
        return createGrokClient(session, {
          fetchImpl: async (input) => String(input).endsWith('/listAgents')
            ? jsonResponse(roster)
            : jsonResponse({ message: 'Expectation Failed' }, 417),
        })
      }
      return createGrokClient(session, {
        fetchImpl: async () => jsonResponse(roster),
      })
    },
  })

  await assert.rejects(
    () => service.send('Researcher', 'hello'),
    (error: unknown) => {
      assert.ok(error instanceof GrokBotError)
      assert.equal(error.status, 417)
      assert.equal(error.delivery, 'rejected')
      return true
    },
  )
  assert.equal(factoryCalls, 1)

  const targets = await service.targets()
  assert.equal(targets[0]?.id, 'bot-1')
  assert.equal(factoryCalls, 2)
})
