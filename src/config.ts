import z from '@deepseek-ai/schemastery'

/** Deployment configuration for the Grok Bot tools. */
export interface Config {
  /** Use signed-in Grok Bot desktop credentials. Default true. */
  appSession?: boolean
  /** Deadline for one Grok gateway request in milliseconds. */
  requestTimeoutMs?: number
  /** Hard cap on a buffered gateway response in bytes. */
  maxResponseBytes?: number
  /** Default tail size for grok_thread. */
  defaultThreadLimit?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  appSession: z.boolean().default(true),
  requestTimeoutMs: z.number().default(30_000),
  maxResponseBytes: z.number().default(2 * 1024 * 1024),
  defaultThreadLimit: z.number().default(40),
})

/** Configuration after defaults and validation. */
export interface ResolvedConfig {
  appSession: boolean
  requestTimeoutMs: number
  maxResponseBytes: number
  defaultThreadLimit: number
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`dsh-plugin-grok-bot: ${name} must be a positive safe integer`)
  }
}

/**
 * Validate deployment-varying limits before any tool is registered.
 * @param config - schema-validated plugin config.
 * @returns the complete configuration with defaults applied.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const resolved: ResolvedConfig = {
    appSession: config.appSession ?? true,
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
    maxResponseBytes: config.maxResponseBytes ?? 2 * 1024 * 1024,
    defaultThreadLimit: config.defaultThreadLimit ?? 40,
  }
  positiveInteger('requestTimeoutMs', resolved.requestTimeoutMs)
  positiveInteger('maxResponseBytes', resolved.maxResponseBytes)
  positiveInteger('defaultThreadLimit', resolved.defaultThreadLimit)
  if (resolved.defaultThreadLimit > 200) {
    throw new Error('dsh-plugin-grok-bot: defaultThreadLimit must be at most 200')
  }
  return resolved
}
