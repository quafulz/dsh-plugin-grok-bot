import assert from 'node:assert/strict'
import test from 'node:test'

import {
  entryText,
  projectThreadEntries,
  transcriptDelta,
} from '../src/grok/transcript.ts'

test('transcriptDelta returns only entries after the cursor', () => {
  const payload = {
    entries: [
      { id: '1', kind: 'message', text: 'one' },
      { id: '2', kind: 'message', text: 'two' },
      { id: '3', kind: 'message', text: 'three' },
    ],
  }
  const delta = transcriptDelta(payload, { after: '2', limit: 10 })
  assert.equal(delta.gapReset, false)
  assert.equal(delta.entryCount, 1)
  assert.equal(delta.cursor, '3')
  assert.deepEqual(delta.entries.map(entry => (entry as { id: string }).id), ['3'])
})

test('transcriptDelta resets an unknown cursor to the bounded snapshot', () => {
  const payload = { entries: [{ id: '1', text: 'one' }, { id: '2', text: 'two' }] }
  const delta = transcriptDelta(payload, { after: 'missing', limit: 1 })
  assert.equal(delta.gapReset, true)
  assert.equal(delta.entryCount, 1)
  assert.equal(delta.cursor, '2')
})

test('entryText understands Grok Bot nested message shapes', () => {
  assert.equal(entryText({ message: { type: 'text', content: 'hello' } }), 'hello')
  assert.equal(entryText({ content: [{ text: 'a' }, { text: 'b' }] }), 'a\nb')
  assert.equal(entryText({ preview: 'preview' }), 'preview')
})

test('projectThreadEntries bounds per-entry and total text', () => {
  const entries = projectThreadEntries([
    { id: '1', kind: 'message', text: 'x'.repeat(20_001) },
    { id: '2', kind: 'message', text: 'y'.repeat(20_001) },
  ])
  assert.equal(entries[0]?.text.length, 20_000)
  assert.equal(entries[0]?.truncated, true)
  assert.equal(entries[0]?.fullLength, 20_001)
  assert.equal(entries[1]?.text.length, 20_000)
})
