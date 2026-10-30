import { randomUUID } from 'node:crypto'

import {
  ensureSandboxHeaders,
  headersFromEnsureSandbox,
  headersFromEnv,
  mergeGatewayHeaders,
  normalizeHeaderMap,
  requestHeaders,
} from './headers.js'
import { GrokBotError } from './errors.js'
import {
  assertAllowedCredentialUrl,
  redactSecrets,
} from './url-policy.js'
import {
  loadGrokBotAccessToken,
  loadGrokBotAppVersion,
  loadGrokBotGatewaySession,
  type GrokBotGatewaySession,
} from './app-session.js'

/** A bot or group from the Grok Bot roster. */
export interface GrokAgentRecord {
  id: string
  name: string
  title: string
  description: string
  avatarShape: string
  avatarColor: string
  notifyOnAgentUpdates?: boolean
  hiddenFromSidebar?: boolean
  isGroup: boolean
  memberIds: string[]
}

/** One accepted or uncertain gateway submission. */
export interface GrokSendReceipt {
  target: GrokAgentRecord
  result: unknown
  delivery: 'accepted' | 'unknown'
  /** Gateway message id, or transcript entry id when confirmed there. */
  messageId?: string
  clientNonce: string
}

/** One bounded transcript tail plus its resolved target. */
export interface GrokTranscriptTail {
  target: GrokAgentRecord
  transcript: unknown
}

/** One chunk returned by the gateway attachment reader. */
export interface GrokAttachmentChunk {
  /** Full attachment size in bytes, stable across chunks. */
  totalSize: number
  /** Gateway-resolved file name when it differs from the transcript name. */
  resolvedName?: string
  /** Base64 bytes in this chunk. Empty for a size probe (`length: 0`). */
  bytesBase64: string
}

/** Bounded polling used to reconcile a submission without a gateway receipt. */
export interface GrokSendConfirmationOptions {
  /** Transcript reads to attempt. Defaults to 3. */
  attempts?: number
  /** Delay between transcript reads in milliseconds. Defaults to 500. */
  delayMs?: number
  /** Trailing transcript entries to inspect. Defaults to 100. */
  limit?: number
}

/** Options shared by the gateway exchange and method calls. */
export interface GrokGatewayOptions {
  /** Injectable fetch implementation for tests. */
  fetchImpl?: typeof fetch
  /** Environment holding auth and routing overrides. */
  env?: NodeJS.ProcessEnv
  /** Deadline for one HTTP request. */
  requestTimeoutMs?: number
  /** Hard cap on a buffered gateway response. */
  maxResponseBytes?: number
  /** Whether the desktop app's saved session may be used. */
  appSession?: boolean
  /** Test seam for the desktop session loader. */
  loadSession?: () => GrokBotGatewaySession | null
  /** Test seam for the desktop access-token loader. */
  loadAccessToken?: () => string | null
  /** Test seam for the desktop app version. */
  appVersion?: string | null
  /** Caller cancellation for authentication or method calls. */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_CONFIRM_ATTEMPTS = 3
const DEFAULT_CONFIRM_DELAY_MS = 500
const DEFAULT_CONFIRM_LIMIT = 100
const MAX_CONFIRM_ATTEMPTS = 10

function assertGatewayActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new GrokBotError('Grok Bot request cancelled before transmission', {
      code: 'ABORTED',
      delivery: 'rejected',
      reason: 'cancelled',
    })
  }
}

function deadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readTextCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new GrokBotError(`Gateway response too large (over ${maxBytes} bytes)`)
    }
    return text
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    bytes += chunk.byteLength
    if (bytes > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        // The stream may already be closed by the peer.
      }
      throw new GrokBotError(`Gateway response too large (over ${maxBytes} bytes)`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readTextCapped(response, maxBytes)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * Explain a status that means the Grok Bot sign-in is stale.
 *
 * Read calls already rebuild the session once before such a status reaches the
 * caller, so the hint tells the model to ask the user to sign in again rather
 * than retry in a loop.
 */
function sessionHint(status: number): string {
  return status === 401 || status === 403 || status === 417
    ? ' (Grok Bot session expired; ask the user to open the Grok Bot app and sign in again)'
    : ''
}

/** Wait between confirmation reads, waking immediately when the caller aborts. */
function waitForConfirmation(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Match the client nonce attached to the submission against a user transcript
 * entry. Grok Bot currently acknowledges sendPrompt with no message id, but the
 * transcript preserves the nonce and gives the message's entry id.
 */
function transcriptReceipt(
  payload: unknown,
  clientNonce: string,
): { matched: boolean; messageId?: string } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const entries = (payload as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (record.clientNonce !== clientNonce) continue
    return {
      matched: true,
      ...(typeof record.id === 'string' && record.id !== ''
        ? { messageId: record.id }
        : {}),
    }
  }
  return undefined
}

function pick(record: unknown, ...keys: string[]): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
  const value = record as Record<string, unknown>
  for (const key of keys) {
    if (value[key] !== null && value[key] !== undefined && value[key] !== '') {
      return value[key]
    }
  }
  return undefined
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  const value = pick(record, ...keys)
  return typeof value === 'string' ? value : ''
}

/** Parse the gateway's attachment chunk envelope without trusting field types. */
function attachmentChunkOf(value: unknown): GrokAttachmentChunk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GrokBotError('readAttachmentChunk returned an invalid response', {
      method: 'readAttachmentChunk',
    })
  }
  const record = value as Record<string, unknown>
  const rawSize = pick(record, 'totalSize', 'total_size')
  const totalSize = typeof rawSize === 'bigint' ? Number(rawSize) : Number(rawSize)
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new GrokBotError('readAttachmentChunk returned no valid totalSize', {
      method: 'readAttachmentChunk',
    })
  }
  const resolvedName = stringField(record, 'resolvedName', 'resolved_name')
  const bytesBase64 = stringField(record, 'bytesBase64', 'bytes_base64')
  return {
    totalSize,
    ...(resolvedName === '' ? {} : { resolvedName }),
    bytesBase64,
  }
}

function asAgentRecord(value: unknown): GrokAgentRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = pick(record, 'id', 'agentId')
  if (typeof id !== 'string' || !id) return null
  const memberIds = pick(record, 'memberIds', 'memberAgentIds')
  const notify = record.notifyOnUpdatesEnabled ?? record.notifyOnAgentUpdates
  const hidden = record.isHiddenFromSidebar ?? record.hiddenFromSidebar
  const resolvedMembers = Array.isArray(memberIds)
    ? memberIds.filter((member): member is string => typeof member === 'string')
    : []
  return {
    id,
    name: stringField(record, 'name'),
    title: stringField(record, 'title'),
    description: stringField(record, 'description'),
    avatarShape: stringField(record, 'avatarShape'),
    avatarColor: stringField(record, 'avatarColor'),
    ...(typeof notify === 'boolean' ? { notifyOnAgentUpdates: notify } : {}),
    ...(typeof hidden === 'boolean' ? { hiddenFromSidebar: hidden } : {}),
    isGroup: record.isGroup === true
      || (record.isGroup === undefined && resolvedMembers.length > 0),
    memberIds: resolvedMembers,
  }
}

function unwrapList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (Array.isArray(record.agents)) return record.agents
    if (record.agent !== undefined) return [record.agent]
  }
  return []
}

function unwrapOne(value: unknown): GrokAgentRecord | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const agent = (value as { agent?: unknown }).agent
    return asAgentRecord(agent ?? value)
  }
  return null
}

function resolveFromList(records: readonly GrokAgentRecord[], ref: string): GrokAgentRecord {
  const needle = ref.trim().toLowerCase()
  const byId = records.find(record => record.id.toLowerCase() === needle)
  if (byId) return byId
  const matches = records.filter(record =>
    record.name.toLowerCase() === needle || record.title.toLowerCase() === needle)
  if (matches.length === 1) return matches[0] as GrokAgentRecord
  if (matches.length === 0) {
    throw new GrokBotError(`No Grok Bot bot or group named "${ref}".`)
  }
  throw new GrokBotError(
    `Ambiguous Grok Bot target "${ref}": ${matches.map(record => `${record.name} (${record.id})`).join(', ')}. Use the id.`,
  )
}

function backendBase(env: NodeJS.ProcessEnv): string {
  return (env.CURSOR_API_BASE_URL || 'https://api2.cursor.sh').replace(/\/$/, '')
}

function accessTokenFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.CURSOR_ACCESS_TOKEN ?? '').trim()
}

function gatewayOverride(env: NodeJS.ProcessEnv): GrokBotGatewaySession | null {
  const url = (env.GROK_BOT_GATEWAY_URL ?? '').trim()
  const token = (env.GROK_BOT_GATEWAY_TOKEN ?? '').trim()
  if (!url && !token) return null
  if (!url || !token) {
    throw new GrokBotError(
      'Set both GROK_BOT_GATEWAY_URL and GROK_BOT_GATEWAY_TOKEN, or neither.',
      { code: 'INCOMPLETE_GATEWAY_OVERRIDE' },
    )
  }
  return {
    gatewayUrl: assertAllowedCredentialUrl(url, 'gateway', env),
    gatewayToken: token,
    gatewayHeaders: headersFromEnv(env),
  }
}

async function ensureSandbox(
  accessToken: string,
  options: Required<Pick<GrokGatewayOptions, 'requestTimeoutMs' | 'maxResponseBytes'>>
    & Pick<GrokGatewayOptions, 'fetchImpl' | 'env' | 'signal' | 'appVersion'>,
): Promise<GrokBotGatewaySession> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch
  const url = assertAllowedCredentialUrl(backendBase(env), 'backend', env)
    + '/aiserver.v1.GrokBotService/EnsureSandBox'
  assertGatewayActive(options.signal)
  let response: Response
  let body: unknown
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: deadline(options.signal, options.requestTimeoutMs),
      headers: ensureSandboxHeaders(accessToken, env, options.appVersion ?? undefined),
      body: '{}',
    })
    body = await readJson(response, options.maxResponseBytes)
  } catch (error) {
    assertGatewayActive(options.signal)
    throw error
  }
  assertGatewayActive(options.signal)
  if (!response.ok) {
    const detail = pick(body, 'message', 'error') ?? response.statusText
    throw new GrokBotError(
      `EnsureSandBox failed: ${response.status} ${redactSecrets(String(detail))}`,
      { status: response.status, method: 'EnsureSandBox' },
    )
  }
  const gatewayUrl = pick(body, 'gatewayUrl', 'gateway_url')
  const gatewayToken = pick(body, 'gatewayToken', 'gateway_token')
  if (typeof gatewayUrl !== 'string' || !gatewayUrl
    || (gatewayToken !== undefined && typeof gatewayToken !== 'string')) {
    throw new GrokBotError(
      'EnsureSandBox returned no gatewayUrl. A Cursor dashboard API key does not work here.',
      { method: 'EnsureSandBox' },
    )
  }
  return {
    gatewayUrl: assertAllowedCredentialUrl(gatewayUrl, 'gateway', env),
    gatewayToken: typeof gatewayToken === 'string' ? gatewayToken : '',
    gatewayHeaders: mergeGatewayHeaders(headersFromEnsureSandbox(body), headersFromEnv(env)),
  }
}

/**
 * Resolve auth and routing credentials for the Grok Bot gateway.
 * @param options - auth source overrides, environment, fetch, and cancellation.
 * @returns a usable gateway session.
 */
export async function connectGateway(
  options: GrokGatewayOptions = {},
): Promise<GrokBotGatewaySession> {
  const env = options.env ?? process.env
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const override = gatewayOverride(env)
  if (override) {
    return {
      ...override,
      gatewayHeaders: mergeGatewayHeaders(override.gatewayHeaders, headersFromEnv(env)),
    }
  }

  let appSessionError: unknown
  if (options.appSession !== false) {
    try {
      const loaded = options.loadSession
        ? options.loadSession()
        : loadGrokBotGatewaySession({ env })
      if (loaded) {
        return {
          gatewayUrl: assertAllowedCredentialUrl(loaded.gatewayUrl, 'gateway', env),
          gatewayToken: loaded.gatewayToken,
          gatewayHeaders: mergeGatewayHeaders(loaded.gatewayHeaders, headersFromEnv(env)),
        }
      }
    } catch (error) {
      appSessionError = error
    }
  }

  let desktopToken: string | null = null
  if (options.appSession !== false) {
    try {
      desktopToken = options.loadAccessToken
        ? options.loadAccessToken()
        : loadGrokBotAccessToken({ env })
    } catch (error) {
      appSessionError ??= error
    }
  }
  const token = accessTokenFromEnv(env) || desktopToken
  if (!token) {
    if (appSessionError !== undefined) throw appSessionError
    throw new GrokBotError(
      'No Grok Bot auth found. Sign in to the Grok Bot desktop app, or set GROK_BOT_GATEWAY_URL + GROK_BOT_GATEWAY_TOKEN, or set CURSOR_ACCESS_TOKEN.',
      { code: 'NO_AUTH' },
    )
  }

  let appVersion = options.appVersion
  if (appVersion === undefined) {
    try {
      appVersion = loadGrokBotAppVersion({ env })
    } catch {
      appVersion = null
    }
  }
  return ensureSandbox(token, {
    requestTimeoutMs,
    maxResponseBytes,
    fetchImpl: options.fetchImpl,
    env,
    signal: options.signal,
    appVersion,
  })
}

/** Bound and resolved client for the Grok Bot HTTP gateway. */
export class GrokClient {
  readonly session: GrokBotGatewaySession
  readonly #fetch: typeof fetch
  readonly #requestTimeoutMs: number
  readonly #maxResponseBytes: number

  constructor(
    session: GrokBotGatewaySession,
    options: Pick<GrokGatewayOptions, 'fetchImpl' | 'requestTimeoutMs' | 'maxResponseBytes'> = {},
  ) {
    this.session = session
    this.#fetch = options.fetchImpl ?? fetch
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  }

  async #call(
    method: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertGatewayActive(signal)
    const base = assertAllowedCredentialUrl(this.session.gatewayUrl, 'gateway')
    const url = `${base}/api/${method}`
    let response: Response
    let data: unknown
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: deadline(signal, this.#requestTimeoutMs),
        headers: requestHeaders(this.session),
        body: JSON.stringify(body),
      })
      data = await readJson(response, this.#maxResponseBytes)
    } catch (error) {
      if (method === 'sendPrompt') {
        throw new GrokBotError(
          `sendPrompt failed: ${redactSecrets(error instanceof Error ? error.message : String(error))} (delivery unknown; check the thread before resending)`,
          { method, delivery: 'unknown' },
        )
      }
      assertGatewayActive(signal)
      throw error
    }
    if (method === 'sendPrompt') {
      if (signal?.aborted) {
        throw new GrokBotError(
          'sendPrompt cancelled after transmission (delivery unknown; check the thread before resending)',
          { method, delivery: 'unknown' },
        )
      }
    } else {
      assertGatewayActive(signal)
    }
    if (!response.ok) {
      const detail = pick(data, 'message', 'error') ?? response.statusText
      throw new GrokBotError(
        `${method} failed: ${response.status} ${redactSecrets(String(detail).slice(0, 300))}${sessionHint(response.status)}`,
        {
          status: response.status,
          method,
          ...(method === 'sendPrompt'
            ? { delivery: response.status < 500 ? 'rejected' as const : 'unknown' as const }
            : {}),
        },
      )
    }
    return data
  }

  /** List every bot and group visible to this account. */
  async listAgents(options: { signal?: AbortSignal } = {}): Promise<GrokAgentRecord[]> {
    const data = await this.#call('listAgents', {}, options.signal)
    return unwrapList(data)
      .map(asAgentRecord)
      .filter((record): record is GrokAgentRecord => record !== null)
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  }

  /** Resolve a bot or group by exact id, name, or title. */
  async resolveRef(ref: string, options: { signal?: AbortSignal } = {}): Promise<GrokAgentRecord> {
    return resolveFromList(await this.listAgents(options), ref)
  }

  /**
   * Submit one message. A gateway message id means accepted. Otherwise the
   * default confirmation reads the transcript for the submission nonce, because
   * the gateway currently accepts prompts without returning a message id.
   * Set `confirmDelivery: false` to return the raw uncertain receipt.
   */
  async sendPrompt(
    ref: string,
    prompt: string,
    options: {
      signal?: AbortSignal
      clientNonce?: string
      replyToId?: string
      confirmDelivery?: boolean
      confirmation?: GrokSendConfirmationOptions
    } = {},
  ): Promise<GrokSendReceipt> {
    assertGatewayActive(options.signal)
    const target = await this.resolveRef(ref, options)
    const clientNonce = options.clientNonce ?? randomUUID()
    const body: Record<string, unknown> = {
      agentId: target.id,
      prompt,
      clientNonce,
    }
    if (options.replyToId !== undefined) body.replyToId = options.replyToId
    let data: unknown
    try {
      data = await this.#call('sendPrompt', body, options.signal)
    } catch (error) {
      if (error instanceof GrokBotError) {
        error.delivery ??= error.status !== undefined && error.status < 500
          ? 'rejected'
          : 'unknown'
        error.targetId ??= target.id
        if (error.delivery === 'unknown' && !/delivery unknown/.test(error.message)) {
          error.message += ' (delivery unknown; check the thread before resending)'
        }
      }
      throw error
    }
    const messageId = data && typeof data === 'object' && !Array.isArray(data)
      ? (data as { messageId?: unknown }).messageId
      : undefined
    if (typeof messageId === 'string' && messageId !== '') {
      return { target, result: data, delivery: 'accepted', messageId, clientNonce }
    }
    if (options.confirmDelivery !== false) {
      const confirmed = await this.#confirmByNonce(
        target.id,
        clientNonce,
        options.signal,
        options.confirmation,
      )
      if (confirmed.matched) {
        return {
          target,
          result: data,
          delivery: 'accepted',
          ...(confirmed.messageId === undefined ? {} : { messageId: confirmed.messageId }),
          clientNonce,
        }
      }
    }
    return { target, result: data, delivery: 'unknown', clientNonce }
  }

  /**
   * Look for the submission nonce in the latest bounded transcript tail.
   * Confirmation failures stay uncertain; they never turn a transmitted prompt
   * into a thrown error that could tempt the caller to resend.
   */
  async #confirmByNonce(
    targetId: string,
    clientNonce: string,
    signal: AbortSignal | undefined,
    options: GrokSendConfirmationOptions | undefined,
  ): Promise<{ matched: boolean; messageId?: string }> {
    const attempts = Math.min(
      Math.max(Math.trunc(options?.attempts ?? DEFAULT_CONFIRM_ATTEMPTS) || DEFAULT_CONFIRM_ATTEMPTS, 1),
      MAX_CONFIRM_ATTEMPTS,
    )
    const delayMs = Math.min(Math.max(Math.trunc(options?.delayMs ?? DEFAULT_CONFIRM_DELAY_MS) || 0, 0), 10_000)
    const limit = Math.min(Math.max(Math.trunc(options?.limit ?? DEFAULT_CONFIRM_LIMIT) || DEFAULT_CONFIRM_LIMIT, 1), 200)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await waitForConfirmation(delayMs, signal)
      if (signal?.aborted) return { matched: false }
      let transcript: unknown
      try {
        transcript = await this.#call(
          'getAgentTranscriptTail',
          { id: targetId, limit },
          signal,
        )
      } catch {
        continue
      }
      const match = transcriptReceipt(transcript, clientNonce)
      if (match !== undefined) return match
    }
    return { matched: false }
  }

  /**
   * Read one byte range of a node-local Grok Bot attachment.
   *
   * `offset: 0, length: 0` is the metadata probe: it returns the total size
   * and optional resolved name without transferring the body. The caller
   * passes that size back to bound and validate subsequent chunks.
   */
  async readAttachmentChunk(
    path: string,
    offset: number,
    length: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<GrokAttachmentChunk> {
    if (path.trim() === '') throw new Error('readAttachmentChunk: path must not be empty')
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('readAttachmentChunk: offset must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('readAttachmentChunk: length must be a non-negative safe integer')
    }
    const data = await this.#call(
      'readAttachmentChunk',
      { path, offset, length },
      options.signal,
    )
    return attachmentChunkOf(data)
  }

  /** Read the latest bounded transcript tail for a bot or group. */
  async getTranscriptTail(
    ref: string,
    limit = 40,
    options: { signal?: AbortSignal } = {},
  ): Promise<GrokTranscriptTail> {
    const target = await this.resolveRef(ref, options)
    const bounded = Math.min(Math.max(Math.trunc(limit) || 40, 1), 200)
    const transcript = await this.#call(
      'getAgentTranscriptTail',
      { id: target.id, limit: bounded },
      options.signal,
    )
    return { target, transcript }
  }
}

/** Construct a client over an already resolved gateway session. */
export function createGrokClient(
  session: GrokBotGatewaySession,
  options: Pick<GrokGatewayOptions, 'fetchImpl' | 'requestTimeoutMs' | 'maxResponseBytes'> = {},
): GrokClient {
  return new GrokClient(
    {
      ...session,
      gatewayHeaders: normalizeHeaderMap(session.gatewayHeaders),
    },
    options,
  )
}
