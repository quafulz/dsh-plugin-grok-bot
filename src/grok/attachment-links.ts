import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { GrokBotService } from '../service.js'
import { entryAttachmentRefs, type GrokThreadAttachmentRef } from './transcript.js'

/** Largest attachment this proxy will transfer in one click. */
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
/** Gateway chunk size used by the desktop app for attachment downloads. */
const CHUNK_BYTES = 4 * 1024 * 1024
/** How long a printed link remains usable. */
const LINK_TTL_MS = 60 * 60 * 1000
/** Bound the token table so repeated reads cannot grow it forever. */
const MAX_PENDING_LINKS = 512

/** Resolve raw transcript attachments to clickable download URLs. */
export interface AttachmentLinker {
  /**
   * Register the attachments in one transcript page and return a map keyed
   * by each raw source. Direct HTTP(S) attachments stay unchanged; node-local
   * cloud-computer paths receive a loopback URL backed by the gateway reader.
   */
  linksFor(
    agentId: string,
    entries: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>>
  /** Stop the loopback listener, if one was started. */
  close(): void
}

interface PendingDownload {
  readonly agentId: string
  readonly path: string
  readonly name: string
  readonly expiresAt: number
}

interface AttachmentServer {
  readonly origin: string
}

/**
 * Convert a Grok Bot attachment source to the absolute path accepted by
 * `readAttachmentChunk`. This mirrors the desktop app: file URLs become
 * decoded POSIX paths, absolute paths pass through, and other schemes are
 * left to the original URL.
 */
export function attachmentReadPath(source: string): string | undefined {
  const value = source.trim()
  if (value === '') return undefined
  if (value.startsWith('file:')) {
    try {
      const url = new URL(value)
      if (url.protocol !== 'file:' || url.host !== '' || url.search !== '' || url.hash !== '') {
        return undefined
      }
      return decodeURIComponent(url.pathname)
    } catch {
      return undefined
    }
  }
  if (value.startsWith('/')) return value
  if (/^[A-Za-z]:[\\/]/u.test(value)) return value
  return undefined
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value)
}

function contentTypeOf(name: string): string {
  const extension = /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase()
  switch (extension) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'pdf': return 'application/pdf'
    case 'txt': return 'text/plain; charset=utf-8'
    case 'csv': return 'text/csv; charset=utf-8'
    case 'json': return 'application/json; charset=utf-8'
    case 'md': return 'text/markdown; charset=utf-8'
    case 'doc': return 'application/msword'
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xls': return 'application/vnd.ms-excel'
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'zip': return 'application/zip'
    case 'mp3': return 'audio/mpeg'
    case 'mp4': return 'video/mp4'
    default: return 'application/octet-stream'
  }
}

function contentDisposition(name: string): string {
  const cleaned = name.replace(/[\r\n"]/gu, '_').trim() || 'attachment'
  const fallback = cleaned.replace(/[^\x20-\x7e]/gu, '_').replace(/\\/gu, '_')
  const encoded = encodeURIComponent(cleaned).replace(/['()]/gu, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function drain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      res.off('drain', done)
      res.off('error', fail)
      res.off('close', fail)
      resolve()
    }
    const fail = (): void => {
      res.off('drain', done)
      res.off('error', fail)
      res.off('close', fail)
      reject(new Error('attachment response closed'))
    }
    if (signal.aborted) {
      fail()
      return
    }
    res.once('drain', done)
    res.once('error', fail)
    res.once('close', fail)
  })
}

/**
 * A loopback-only attachment proxy.
 *
 * dsh-TUI delegates clicks on plain HTTP(S) URLs to the operating system, so
 * printing a localhost URL makes the download action a real browser click
 * without teaching the TUI about Grok Bot internals. The actual cloud file is
 * fetched only when that URL is requested.
 */
export class AttachmentDownloadLinks implements AttachmentLinker {
  readonly #reader: Pick<GrokBotService, 'readAttachmentChunk'>
  readonly #downloads = new Map<string, PendingDownload>()
  #server: Server | undefined
  #serverPromise: Promise<AttachmentServer | undefined> | undefined

  constructor(reader: Pick<GrokBotService, 'readAttachmentChunk'>) {
    this.#reader = reader
  }

  async linksFor(
    agentId: string,
    entries: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    const refs = new Map<string, GrokThreadAttachmentRef>()
    for (const entry of entries) {
      for (const ref of entryAttachmentRefs(entry)) {
        if (ref.source !== '' && !refs.has(ref.source)) refs.set(ref.source, ref)
      }
    }

    const links = new Map<string, string>()
    const local: GrokThreadAttachmentRef[] = []
    for (const ref of refs.values()) {
      if (isHttpUrl(ref.source)) {
        links.set(ref.source, ref.source)
      } else if (attachmentReadPath(ref.source) !== undefined) {
        local.push(ref)
      }
    }
    if (local.length === 0) return links

    const server = await this.#ensureServer()
    if (server === undefined) return links
    if (signal?.aborted) return links

    this.#prune()
    for (const ref of local) {
      const path = attachmentReadPath(ref.source)
      if (path === undefined) continue
      const token = randomBytes(16).toString('hex')
      this.#downloads.set(token, {
        agentId,
        path,
        name: ref.name || 'attachment',
        expiresAt: Date.now() + LINK_TTL_MS,
      })
      links.set(ref.source, `${server.origin}/d/${token}`)
    }
    this.#prune()
    return links
  }

  close(): void {
    this.#downloads.clear()
    const server = this.#server
    this.#server = undefined
    this.#serverPromise = undefined
    if (server !== undefined) {
      server.closeAllConnections?.()
      server.close()
    }
  }

  #prune(): void {
    const now = Date.now()
    for (const [token, download] of this.#downloads) {
      if (download.expiresAt <= now) this.#downloads.delete(token)
    }
    while (this.#downloads.size > MAX_PENDING_LINKS) {
      const oldest = this.#downloads.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#downloads.delete(oldest)
    }
  }

  #ensureServer(): Promise<AttachmentServer | undefined> {
    if (this.#serverPromise !== undefined) return this.#serverPromise
    this.#serverPromise = new Promise((resolve) => {
      let settled = false
      const finish = (value: AttachmentServer | undefined): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let server: Server
      try {
        server = createServer((request, response) => {
          void this.#serve(request, response)
        })
      } catch {
        finish(undefined)
        return
      }
      server.once('error', () => finish(undefined))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          server.close()
          finish(undefined)
          return
        }
        server.unref()
        this.#server = server
        finish({ origin: `http://127.0.0.1:${address.port}` })
      })
    })
    return this.#serverPromise
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
        response.end('method not allowed')
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const match = /^\/d\/([0-9a-f]{32})$/u.exec(pathname)
      if (match === null) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      const download = this.#downloads.get(match[1] as string)
      if (download === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      if (download.expiresAt <= Date.now()) {
        this.#downloads.delete(match[1] as string)
        response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('link expired')
        return
      }

      const controller = new AbortController()
      const onClose = (): void => {
        if (!response.writableEnded) controller.abort()
      }
      response.once('close', onClose)
      try {
        const probe = await this.#reader.readAttachmentChunk(
          download.path,
          0,
          0,
          controller.signal,
        )
        const totalSize = probe.totalSize
        if (!Number.isSafeInteger(totalSize) || totalSize < 0) throw new Error('invalid attachment size')
        if (totalSize > MAX_ATTACHMENT_BYTES) {
          response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('attachment too large')
          return
        }
        const name = probe.resolvedName || download.name
        response.writeHead(200, {
          'content-type': contentTypeOf(name),
          'content-length': String(totalSize),
          'content-disposition': contentDisposition(name),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        if (request.method === 'HEAD' || totalSize === 0) {
          response.end()
          return
        }
        let offset = 0
        while (offset < totalSize) {
          if (controller.signal.aborted) throw new Error('attachment download cancelled')
          const chunk = await this.#reader.readAttachmentChunk(
            download.path,
            offset,
            Math.min(CHUNK_BYTES, totalSize - offset),
            controller.signal,
          )
          if (chunk.totalSize !== totalSize) throw new Error('attachment size changed')
          const bytes = Buffer.from(chunk.bytesBase64, 'base64')
          if (bytes.length === 0 || offset + bytes.length > totalSize) {
            throw new Error('attachment chunk was empty or oversized')
          }
          if (!response.write(bytes)) await drain(response, controller.signal)
          offset += bytes.length
        }
        response.end()
      } finally {
        response.off('close', onClose)
      }
    } catch {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('attachment download failed')
      } else if (!response.writableEnded) {
        response.destroy()
      }
    }
  }
}
