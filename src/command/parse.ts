/**
 * Intent grammar for `/grokbot`.
 *
 * The command deliberately accepts free text: a bare message means "send this
 * to the bot the user picks", `send` and `read` are optional shape words, and
 * a target is recognised by longest-prefix match against the current roster.
 * Parsing is pure so the grammar can be tested without a gateway or a UI.
 *
 * @module command/parse
 */

/** The roster fields the parser matches on. */
export interface GrokTargetRef {
  readonly id: string
  readonly name: string
  readonly title: string
}

/** What one `/grokbot` line asks for. */
export type GrokbotIntent =
  | { readonly kind: 'list'; readonly query: string }
  | { readonly kind: 'read'; readonly targetRef?: string; readonly limit?: number }
  | { readonly kind: 'send'; readonly targetRef?: string; readonly message?: string }

const SHAPE_WORDS = new Set(['list', 'read', 'send'])

/** Largest tail the gateway accepts for one read. */
export const MAX_READ_LIMIT = 200

/**
 * Parse one command line against the roster.
 *
 * @param raw - text following the command name, separator whitespace included.
 * @param targets - the current roster, used only to recognise a target prefix.
 * @returns the intent the handler should execute.
 */
export function parseGrokbotInput(raw: string, targets: readonly GrokTargetRef[]): GrokbotIntent {
  const text = raw.trim()
  if (text === '') return { kind: 'list', query: '' }
  const head = firstToken(text).toLowerCase()
  if (!SHAPE_WORDS.has(head)) return { kind: 'send', message: text }
  const rest = text.slice(head.length).trim()
  if (head === 'list') return { kind: 'list', query: rest }
  if (head === 'read') return parseRead(rest, targets)
  return parseSend(rest, targets)
}

function parseSend(rest: string, targets: readonly GrokTargetRef[]): GrokbotIntent {
  if (rest === '') return { kind: 'send' }
  if (rest.startsWith('--')) {
    const literal = rest.slice(2).trim()
    return literal === '' ? { kind: 'send' } : { kind: 'send', message: literal }
  }
  const match = matchTargetPrefix(rest, targets)
  if (match === undefined) return { kind: 'send', message: rest }
  const message = rest.slice(match.length).trim()
  return message === ''
    ? { kind: 'send', targetRef: match.id }
    : { kind: 'send', targetRef: match.id, message }
}

function parseRead(rest: string, targets: readonly GrokTargetRef[]): GrokbotIntent {
  if (rest === '') return { kind: 'read' }
  const limitOnly = parseLimit(rest)
  if (limitOnly !== undefined) return { kind: 'read', limit: limitOnly }
  const match = matchTargetPrefix(rest, targets)
  if (match === undefined) return { kind: 'read', targetRef: rest }
  const tail = rest.slice(match.length).trim()
  const limit = tail === '' ? undefined : parseLimit(tail)
  return limit === undefined
    ? { kind: 'read', targetRef: match.id }
    : { kind: 'read', targetRef: match.id, limit }
}

/**
 * Longest roster entry that prefixes `text` on a word boundary. Names, titles
 * and ids all compete; the longest wins so `Support Bot` beats `Support`.
 */
function matchTargetPrefix(
  text: string,
  targets: readonly GrokTargetRef[],
): { id: string; length: number } | undefined {
  const lower = text.toLowerCase()
  let best: { id: string; length: number } | undefined
  for (const target of targets) {
    for (const candidate of [target.name, target.title, target.id]) {
      const value = candidate.trim().toLowerCase()
      if (value === '' || !lower.startsWith(value)) continue
      if (text.length > value.length && !/^\s/u.test(text.slice(value.length))) continue
      if (best === undefined || value.length > best.length) best = { id: target.id, length: value.length }
    }
  }
  return best
}

/** A positive integer tail size, clamped to the gateway's bound. */
function parseLimit(value: string): number | undefined {
  if (!/^\d{1,3}$/u.test(value)) return undefined
  const limit = Number(value)
  if (limit < 1) return undefined
  return Math.min(limit, MAX_READ_LIMIT)
}

function firstToken(text: string): string {
  const end = text.search(/\s/u)
  return end === -1 ? text : text.slice(0, end)
}
