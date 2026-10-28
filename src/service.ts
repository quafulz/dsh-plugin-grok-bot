import type { ResolvedConfig } from './config.js'
import { GrokBotError } from './grok/errors.js'
import {
  connectGateway,
  createGrokClient,
  type GrokAgentRecord,
  type GrokSendReceipt,
  type GrokTranscriptTail,
} from './grok/gateway.js'

/** Lazily authenticated facade shared by the three registered tools. */
export class GrokBotService {
  readonly #config: ResolvedConfig
  #clientPromise: Promise<import('./grok/gateway.js').GrokClient> | null = null

  constructor(config: ResolvedConfig) {
    this.#config = config
  }

  async #client(signal?: AbortSignal): Promise<import('./grok/gateway.js').GrokClient> {
    if (this.#clientPromise === null) {
      this.#clientPromise = connectGateway({
        appSession: this.#config.appSession,
        requestTimeoutMs: this.#config.requestTimeoutMs,
        maxResponseBytes: this.#config.maxResponseBytes,
        signal,
      }).then(session => createGrokClient(session, {
        requestTimeoutMs: this.#config.requestTimeoutMs,
        maxResponseBytes: this.#config.maxResponseBytes,
      }))
      this.#clientPromise.catch(() => {
        this.#clientPromise = null
      })
    }
    return this.#clientPromise
  }

  #resetAuth(error: unknown): void {
    if (error instanceof GrokBotError && (error.status === 401 || error.status === 403)) {
      this.#clientPromise = null
    }
  }

  /** List every visible bot and group. */
  async targets(signal?: AbortSignal): Promise<GrokAgentRecord[]> {
    try {
      return await (await this.#client(signal)).listAgents({ signal })
    } catch (error) {
      this.#resetAuth(error)
      throw error
    }
  }

  /** Send one message and report whether the gateway confirmed delivery. */
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
      this.#resetAuth(error)
      throw error
    }
  }

  /** Read a bounded transcript tail for one bot or group. */
  async thread(
    target: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<GrokTranscriptTail> {
    try {
      return await (await this.#client(signal)).getTranscriptTail(
        target,
        limit,
        { signal },
      )
    } catch (error) {
      this.#resetAuth(error)
      throw error
    }
  }

  /** Drop the cached gateway client and credentials. */
  reset(): void {
    this.#clientPromise = null
  }
}
