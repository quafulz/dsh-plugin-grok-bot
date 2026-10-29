import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AttachmentDownloadLinks,
  attachmentReadPath,
} from '../src/grok/attachment-links.ts'
import { entryText } from '../src/grok/transcript.ts'

test('attachmentReadPath decodes cloud file URLs and leaves other sources alone', () => {
  assert.equal(
    attachmentReadPath('file:///home/box/agent-data/agents/bot/assets/form%20one.pdf'),
    '/home/box/agent-data/agents/bot/assets/form one.pdf',
  )
  assert.equal(attachmentReadPath('/home/box/agent-data/agents/bot/assets/form.pdf'),
    '/home/box/agent-data/agents/bot/assets/form.pdf')
  assert.equal(attachmentReadPath('https://example.com/form.pdf'), undefined)
  assert.equal(attachmentReadPath('sand://asset/one'), undefined)
})

test('entryText can swap the raw attachment path for a clickable link', () => {
  const entry = {
    kind: 'send-message',
    message: {
      type: 'attachment',
      file_name: 'form.pdf',
      url: 'file:///home/box/agent-data/agents/bot/assets/form.pdf',
    },
  }
  const text = entryText(entry, {
    attachmentUrl: () => 'http://127.0.0.1:4567/a/token/form.pdf',
  })
  assert.match(text, /form\.pdf/)
  assert.match(text, /http:\/\/127\.0\.0\.1:4567\/a\/token\/form\.pdf/)
  assert.doesNotMatch(text, /file:\/\/\/home\/box/)
})

test('local download links call readAttachmentChunk only when the URL is opened', async () => {
  const bytes = Buffer.from('attachment body 无业材料')
  const calls: Array<{ path: string; offset: number; length: number }> = []
  const reader = {
    async readAttachmentChunk(path: string, offset: number, length: number) {
      calls.push({ path, offset, length })
      if (length === 0) {
        return { totalSize: bytes.length, resolvedName: '表单.txt', bytesBase64: '' }
      }
      return {
        totalSize: bytes.length,
        bytesBase64: bytes.subarray(offset, offset + length).toString('base64'),
      }
    },
  }
  const links = new AttachmentDownloadLinks(reader)
  const raw = 'file:///home/box/agent-data/agents/bot/assets/form.txt'
  try {
    const mapped = await links.linksFor('bot-1', [{
      kind: 'send-message',
      message: { type: 'attachment', file_name: '表单.txt', url: raw },
    }])
    const url = mapped.get(raw)
    assert.ok(url !== undefined)
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/d\/[0-9a-f]{32}$/u)
    assert.ok(url.length <= 64, 'download URL must fit one typical terminal row')
    assert.deepEqual(calls, [])

    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/u)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    assert.deepEqual(calls[0], {
      path: '/home/box/agent-data/agents/bot/assets/form.txt',
      offset: 0,
      length: 0,
    })
    assert.ok(calls.some(call => call.length > 0))

    const missing = await fetch(url.replace(/[0-9a-f]{32}/u, '0'.repeat(32)))
    assert.equal(missing.status, 404)
  } finally {
    links.close()
  }
})

test('direct HTTP attachment URLs are already clickable and stay unchanged', async () => {
  const links = new AttachmentDownloadLinks({
    async readAttachmentChunk() {
      throw new Error('must not read a direct HTTP attachment')
    },
  })
  try {
    const mapped = await links.linksFor('bot-1', [{
      kind: 'send-message',
      message: {
        type: 'attachment',
        file_name: 'form.pdf',
        url: 'https://example.com/form.pdf',
      },
    }])
    assert.equal(mapped.get('https://example.com/form.pdf'), 'https://example.com/form.pdf')
  } finally {
    links.close()
  }
})
