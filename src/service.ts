import type { ResolvedConfig } from './config.js'
import { GrokBotError } from './grok/errors.js'
import {
  connectGateway,
  createGrokClient,
  type GrokAgentRecord,
  type GrokClient,
  type GrokSendReceipt,
  type GrokTranscriptTail,
} from './grok/gateway.js'

/** Test seam for a lazily connected gateway client. */
export interface GrokBotServiceOptions {
  clientFactory?: (signal?: AbortSignal) => Promise<GrokClient>
}

/** Lazily authenticated facade shared by the three registered tools. */
export class GrokBotService {
  readonly #config: ResolvedConfig
  readonly #clientFactory: GrokBotServiceOptions['clientFactory']
  #clientPromise: Promise<GrokClient> | null = null

  constructor(config: ResolvedConfig, options: GrokBotServiceOptions = {}) {
    this.#config = config
    this.#clientFactory = options.clientFactory
  }

  async #client(signal?: AbortSignal): Promise<GrokClient> {
    if (this.#clientPromise === null) {
      const factory = this.#clientFactory
      this.#clientPromise = factory === undefined
        ? connectGateway({
            appSession: this.#config.appSession,
            requestTimeoutMs: this.#config.requestTimeoutMs,
            maxResponseBytes: this.#config.maxResponseBytes,
            signal,
          }).then(session => createGrokClient(session, {
            requestTimeoutMs: this.#config.requestTimeoutMs,
            maxResponseBytes: this.#config.maxResponseBytes,
          }))
        : factory(signal)
      this.#clientPromise.catch(() => {
        this.#clientPromise = null
      })
    }
    return this.#clientPromise
  }

  /**
   * Cursor's session gateway can answer 401/403, or 417 when the minted session
   * has gone stale. All three mean the cached client should be rebuilt.
   */
  #isSessionFailure(error: unknown): boolean {
    return error instanceof GrokBotError
      && (error.status === 401 || error.status === 403 || error.status === 417)
  }

  #resetOnSessionFailure(error: unknown): void {
    if (this.#isSessionFailure(error)) this.#clientPromise = null
  }

  /** Retry a read-only call once with a freshly minted session. */
  async #readWithReconnect<T>(
    signal: AbortSignal | undefined,
    operation: (client: GrokClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(await this.#client(signal))
    } catch (error) {
      if (!this.#isSessionFailure(error)) throw error
      this.#clientPromise = null
      try {
        return await operation(await this.#client(signal))
      } catch (retryError) {
        this.#resetOnSessionFailure(retryError)
        throw retryError
      }
    }
  }

  /** List every visible bot and group. */
  async targets(signal?: AbortSignal): Promise<GrokAgentRecord[]> {
    return this.#readWithReconnect(signal, async client => client.listAgents({ signal }))
  }

  /** Send one message and confirm delivery from the gateway receipt or transcript nonce. */
  async send(
    target: string,
    message: string,
    options: { signal?: AbortSignal; replyToId?: string } = {},
  ): Promise<GrokSendReceipt> {
    try {
      return await (await this.#client(options.signal)).sendPrompt(
        target,
        message,
        options.replyToId === undefined
          ? { signal: options.signal }
          : { signal: options.signal, replyToId: options.replyToId },
      )
    } catch (error) {
      this.#resetOnSessionFailure(error)
      throw error
    }
  }

  /** Read a bounded transcript tail for one bot or group. */
  async thread(
    target: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<GrokTranscriptTail> {
    return this.#readWithReconnect(
      signal,
      async client => client.getTranscriptTail(target, limit, { signal }),
    )
  }

  /** Drop the cached gateway client and credentials. */
  reset(): void {
    this.#clientPromise = null
  }
}
