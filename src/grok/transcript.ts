/** One bounded Grok Bot transcript entry exposed to the model. */
export interface GrokThreadEntry {
  id: string
  kind: string
  role?: string
  text: string
  truncated: boolean
  fullLength: number
  timestampMs?: number
}

/** Client-side delta over a bounded gateway transcript tail. */
export interface TranscriptDelta {
  cursor: string
  entries: unknown[]
  entryCount: number
  gapReset: boolean
}

const ENTRY_FULL_MAX = 20_000
const TRANSCRIPT_TOTAL_MAX = 200_000
const ENTRY_META_MAX = 200
const RECEIPT_CURSOR_MAX = 1024

function toSafeText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    const out = JSON.stringify(value)
    return typeof out === 'string' ? out : ''
  } catch {
    return '[unserializable]'
  }
}

function normalizeText(value: unknown): string {
  return toSafeText(value).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  )
}

/** Extract the full body from Grok Bot transcript entry shapes. */
export function entryText(entry: unknown): string {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ''
  const record = entry as Record<string, unknown>
  const direct = record.text ?? record.prompt ?? record.message
  if (typeof direct === 'string' && direct) return normalizeText(direct)
  const content = record.content
  if (typeof content === 'string') return normalizeText(content)
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const partRecord = part as Record<string, unknown>
        return partRecord.text ?? partRecord.content ?? ''
      }
      return ''
    }).filter((part) => part !== '').map(normalizeText).join('\n')
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const contentRecord = content as Record<string, unknown>
    return contentRecord.text === undefined
      ? normalizeText(content)
      : normalizeText(contentRecord.text)
  }
  const message = record.message
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const messageRecord = message as Record<string, unknown>
    if (typeof messageRecord.content === 'string') return normalizeText(messageRecord.content)
  }
  return typeof record.preview === 'string' ? normalizeText(record.preview) : ''
}

/** Read the entry array from a gateway transcript payload. */
export function transcriptEntries(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const entries = (payload as { entries?: unknown }).entries
  return Array.isArray(entries) ? entries : []
}

/** Return an entry's opaque id, or an empty string when absent. */
export function sourceEntryId(entry: unknown): string {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ''
  const id = (entry as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

function lastSourceId(entries: readonly unknown[], fallback = ''): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const id = sourceEntryId(entries[index])
    if (id) return id
  }
  return fallback
}

/**
 * Apply the `after` cursor to a bounded tail.
 * @param payload - gateway transcript payload.
 * @param options - opaque cursor and requested tail size.
 * @returns the selected suffix and the next cursor.
 */
export function transcriptDelta(
  payload: unknown,
  options: { after?: string; limit?: number } = {},
): TranscriptDelta {
  const bounded = Math.min(Math.max(Math.trunc(options.limit ?? 40) || 40, 1), 200)
  const page = transcriptEntries(payload).slice(-bounded)
  const cursorOf = (entries: readonly unknown[], fallback = ''): string => {
    const cursor = lastSourceId(entries, fallback)
    return cursor.length > RECEIPT_CURSOR_MAX ? cursor.slice(0, RECEIPT_CURSOR_MAX) : cursor
  }
  if (options.after === undefined) {
    const gapReset = page.length > 0 && !sourceEntryId(page[page.length - 1])
    return { cursor: cursorOf(page), entries: page, entryCount: page.length, gapReset }
  }
  const afterIndex = page.findIndex(entry => sourceEntryId(entry) === options.after)
  if (afterIndex === -1) {
    return { cursor: cursorOf(page), entries: page, entryCount: page.length, gapReset: true }
  }
  const entries = page.slice(afterIndex + 1)
  if (entries.length > 0 && !sourceEntryId(entries[entries.length - 1])) {
    return { cursor: cursorOf(page), entries: page, entryCount: page.length, gapReset: true }
  }
  return {
    cursor: cursorOf(entries, options.after),
    entries,
    entryCount: entries.length,
    gapReset: false,
  }
}

/** Bound one entry's metadata and text for model-facing output. */
function threadEntry(raw: unknown): { entry: GrokThreadEntry; metaLength: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const text = entryText(raw)
    const bounded = text.length > ENTRY_FULL_MAX ? text.slice(0, ENTRY_FULL_MAX) : text
    return {
      entry: {
        id: '',
        kind: 'unknown',
        text: bounded,
        truncated: bounded.length < text.length,
        fullLength: text.length,
      },
      metaLength: 'unknown'.length,
    }
  }
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const kind = typeof record.kind === 'string' ? record.kind : 'message'
  const role = typeof record.role === 'string' ? record.role : undefined
  const timestampMs = typeof record.timestampMs === 'number' ? record.timestampMs : undefined
  const text = entryText(raw)
  const truncated = text.length > ENTRY_FULL_MAX
  const entry: GrokThreadEntry = {
    id: id.length > ENTRY_META_MAX ? `${id.slice(0, ENTRY_META_MAX)}…` : id,
    kind: kind.length > ENTRY_META_MAX ? `${kind.slice(0, ENTRY_META_MAX)}…` : kind,
    ...(role === undefined
      ? {}
      : { role: role.length > ENTRY_META_MAX ? `${role.slice(0, ENTRY_META_MAX)}…` : role }),
    text: truncated ? text.slice(0, ENTRY_FULL_MAX) : text,
    truncated,
    fullLength: text.length,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  }
  return {
    entry,
    metaLength: entry.id.length + entry.kind.length + (entry.role?.length ?? 0),
  }
}

/** Bound an entry list by per-entry and total model-facing budgets. */
export function projectThreadEntries(entries: readonly unknown[]): GrokThreadEntry[] {
  let remaining = TRANSCRIPT_TOTAL_MAX
  return entries.map((raw) => {
    const { entry, metaLength } = threadEntry(raw)
    const allowedText = Math.max(0, Math.min(entry.text.length, remaining - metaLength))
    if (allowedText < entry.text.length) {
      entry.text = allowedText <= 0 ? '' : entry.text.slice(0, allowedText)
      entry.truncated = entry.fullLength > entry.text.length
    }
    remaining = Math.max(0, remaining - metaLength - entry.text.length)
    return entry
  })
}
