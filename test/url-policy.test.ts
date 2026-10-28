import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertAllowedCredentialUrl,
  redactSecrets,
} from '../src/grok/url-policy.ts'

test('accepts Cursor gateway hosts and rejects unrelated hosts', () => {
  assert.equal(
    assertAllowedCredentialUrl('https://gateway.cursor.sh/', 'gateway', {}),
    'https://gateway.cursor.sh',
  )
  assert.throws(
    () => assertAllowedCredentialUrl('https://evil.example/', 'gateway', {}),
    /Rejected gateway URL host/,
  )
})

test('backend URLs cannot use cursorvm hosts', () => {
  assert.throws(
    () => assertAllowedCredentialUrl('https://box.cursorvm.com', 'backend', {}),
    /Rejected backend URL host/,
  )
})

test('redacts bearer tokens and named credential fields', () => {
  const text = redactSecrets('Authorization: Bearer abc.def token=supersecret')
  assert.doesNotMatch(text, /abc\.def/)
  assert.doesNotMatch(text, /supersecret/)
})
