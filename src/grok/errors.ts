/** Failure raised by the Grok Bot auth or gateway layer. */
export interface GrokBotErrorOptions {
  code?: string
  status?: number
  method?: string
  delivery?: 'rejected' | 'unknown'
  reason?: string
  targetId?: string
}

/** One Grok Bot failure with stable machine-readable fields when available. */
export class GrokBotError extends Error {
  readonly code: string | undefined
  readonly status: number | undefined
  readonly method: string | undefined
  delivery: 'rejected' | 'unknown' | undefined
  readonly reason: string | undefined
  targetId: string | undefined

  constructor(message: string, options: GrokBotErrorOptions = {}) {
    super(message)
    this.name = 'GrokBotError'
    this.code = options.code
    this.status = options.status
    this.method = options.method
    this.delivery = options.delivery
    this.reason = options.reason
    this.targetId = options.targetId
  }
}

/** Render an unknown thrown value without losing its text. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
