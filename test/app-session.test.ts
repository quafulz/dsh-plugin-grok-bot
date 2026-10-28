import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  grokBotGatewayDescriptorPath,
  loadGrokBotGatewaySession,
} from '../src/grok/app-session.ts'

function encrypt(clear: string, password: string, iterations: number): string {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1')
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(clear),
    cipher.final(),
  ]).toString('base64')
}

function writeDescriptor(path: string, password: string, iterations: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const descriptor = JSON.stringify({
    baseUrl: 'https://gateway.cursor.sh/',
    token: 'gateway-token',
    headers: { 'x-test-header': 'yes' },
  })
  writeFileSync(path, JSON.stringify({
    version: 1,
    encrypted: encrypt(descriptor, password, iterations),
  }))
}

test('loads a macOS desktop gateway session', () => {
  const home = mkdtempSync(join(tmpdir(), 'grok-session-mac-'))
  try {
    const path = grokBotGatewayDescriptorPath(home, 'darwin', {})
    writeDescriptor(path, 'keychain-password', 1003)
    const session = loadGrokBotGatewaySession({
      platform: 'darwin',
      home,
      env: {},
      getKeychainPassword: () => 'keychain-password',
    })
    assert.equal(session?.gatewayUrl, 'https://gateway.cursor.sh')
    assert.equal(session?.gatewayToken, 'gateway-token')
    assert.deepEqual(session?.gatewayHeaders, { 'x-test-header': 'yes' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loads a Linux basic_text gateway session without a keyring lookup', () => {
  const home = mkdtempSync(join(tmpdir(), 'grok-session-linux-'))
  const configHome = join(home, '.config')
  try {
    const path = grokBotGatewayDescriptorPath(home, 'linux', { XDG_CONFIG_HOME: configHome })
    writeDescriptor(path, 'peanuts', 1)
    const session = loadGrokBotGatewaySession({
      platform: 'linux',
      home,
      env: { XDG_CONFIG_HOME: configHome },
      getKeychainPassword: () => {
        throw new Error('keyring must not be read for Linux basic_text')
      },
    })
    assert.equal(session?.gatewayToken, 'gateway-token')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('returns null when the desktop descriptor is absent', () => {
  const home = mkdtempSync(join(tmpdir(), 'grok-session-empty-'))
  try {
    assert.equal(loadGrokBotGatewaySession({
      platform: 'darwin',
      home,
      env: {},
    }), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
