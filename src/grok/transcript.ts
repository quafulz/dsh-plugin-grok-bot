/** One bounded Grok Bot transcript entry exposed to the model. */
export interface GrokThreadEntry {
  id: string
  kind: string
  role?: string
  speaker: 'user' | 'assistant' | 'other'
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

/** One attachment discovered in a transcript entry. */
export interface GrokThreadAttachmentRef {
  /** Display name reported by the transcript, or the source basename. */
  name: string
  /** Raw URL/path carried by the transcript. */
  source: string
}

/** Display-only URL rewriting for projected transcript entries. */
export interface GrokThreadTextOptions {
  /**
   * Replace one attachment's raw URL/path with a UI-clickable link. The
   * projector never resolves remote files itself; it just keeps the text
   * representation bounded and consistent.
   */
  attachmentUrl?: (attachment: GrokThreadAttachmentRef) => string | undefined
}

const ENTRY_FULL_MAX = 20_000
const TRANSCRIPT_TOTAL_MAX = 200_000
const ENTRY_META_MAX = 200
const RECEIPT_CURSOR_MAX = 1024
const ATTACHMENT_MARK = '📎'

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** First non-empty string field, preserving the original spelling. */
function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

/** Basename of a URL or POSIX/Windows path, decoded when possible. */
function fileNameOf(value: string): string {
  const path = value.split(/[?#]/u, 1)[0] ?? ''
  const part = path.replace(/\\/gu, '/').split('/').filter(Boolean).pop() ?? ''
  if (part === '') return ''
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** The URL a transcript attachment entry points at. */
function attachmentUrl(record: Record<string, unknown>): string {
  return stringField(
    record,
    'url',
    'file_url',
    'fileUrl',
    'download_url',
    'downloadUrl',
    'href',
    'source_path',
    'sourcePath',
    'file_path',
    'filePath',
    'path',
  )
}

/** One attachment descriptor parsed from a transcript object. */
function attachmentRef(value: unknown): GrokThreadAttachmentRef | undefined {
  const record = asRecord(value)
  if (record === undefined) {
    const source = typeof value === 'string' ? value : ''
    if (source === '') return undefined
    return { name: fileNameOf(source) || source, source }
  }
  const source = attachmentUrl(record)
  const explicitName = stringField(record, 'file_name', 'fileName', 'filename', 'name', 'alt')
  const name = explicitName || fileNameOf(source)
  if (name === '' && source === '') return undefined
  return { name: name || source, source }
}

/** De-duplicate attachment descriptors in source order. */
function dedupeAttachmentRefs(
  values: readonly (GrokThreadAttachmentRef | undefined)[],
): GrokThreadAttachmentRef[] {
  const seen = new Set<string>()
  const out: GrokThreadAttachmentRef[] = []
  for (const value of values) {
    if (value === undefined) continue
    const key = `${value.source}\0${value.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/** Attachment descriptors carried by an images/files/attachments array. */
function attachmentRefs(value: unknown): GrokThreadAttachmentRef[] {
  if (!Array.isArray(value)) return []
  return dedupeAttachmentRefs(value.map(attachmentRef))
}

/** Render one attachment as a bounded display block. */
function attachmentText(
  attachment: GrokThreadAttachmentRef,
  options: GrokThreadTextOptions,
): string {
  const name = attachment.name || fileNameOf(attachment.source) || attachment.source
  const source = attachment.source === ''
    ? ''
    : options.attachmentUrl?.(attachment) ?? attachment.source
  if (name === '' && source === '') return ''
  if (source === '' || name === source) return `${ATTACHMENT_MARK} ${name || source}`
  return `${ATTACHMENT_MARK} ${name}\n${source}`
}

/** Flatten text and text-part arrays from one content field. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return normalizeText(value)
  if (!Array.isArray(value)) {
    const record = asRecord(value)
    if (record === undefined) return ''
    const text = record.text ?? record.content
    return typeof text === 'string' ? normalizeText(text) : normalizeText(record)
  }
  return value.map((part) => {
    if (typeof part === 'string') return normalizeText(part)
    const record = asRecord(part)
    if (record === undefined) return ''
    const text = record.text ?? record.content
    return typeof text === 'string' ? text : ''
  }).filter((part) => part !== '').map(normalizeText).join('\n')
}

/** Body text and attachment descriptors from a structured message object. */
function messageParts(value: unknown): {
  body: string
  attachments: GrokThreadAttachmentRef[]
} {
  if (typeof value === 'string') return { body: normalizeText(value), attachments: [] }
  const record = asRecord(value)
  if (record === undefined) return { body: '', attachments: [] }
  const type = stringField(record, 'type')
  const body = contentText(record.content ?? record.text)
  const attachments = dedupeAttachmentRefs([
    ...(type === 'attachment' ? [attachmentRef(record)] : []),
    ...attachmentRefs(record.content),
    ...attachmentRefs(record.images),
    ...attachmentRefs(record.attachments),
    ...attachmentRefs(record.files),
  ])
  if (body !== '') return { body, attachments }
  if (type === 'attachment') return { body: '', attachments }
  // Non-text cards still carry useful labels in a few known shapes.
  const title = stringField(record, 'title', 'label')
  return { body: title === '' ? '' : normalizeText(title), attachments }
}

function entryParts(entry: unknown): {
  body: string
  attachments: GrokThreadAttachmentRef[]
} {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { body: normalizeText(entry), attachments: [] }
  }
  const record = entry as Record<string, unknown>
  const direct = record.text ?? record.prompt
  const directBody = typeof direct === 'string' && direct !== ''
    ? normalizeText(direct)
    : contentText(record.content)

  const message = messageParts(record.message)
  return {
    body: directBody !== '' ? directBody : message.body,
    attachments: dedupeAttachmentRefs([
      ...message.attachments,
      ...attachmentRefs(record.content),
      ...attachmentRefs(record.images),
      ...attachmentRefs(record.attachments),
      ...attachmentRefs(record.files),
      ...(typeof record.file_path === 'string' || typeof record.file_name === 'string'
        ? [attachmentRef(record)]
        : []),
    ]),
  }
}

/** Attachment descriptors carried by one raw transcript entry. */
export function entryAttachmentRefs(entry: unknown): GrokThreadAttachmentRef[] {
  return entryParts(entry).attachments
}

/**
 * Extract the full body from Grok Bot transcript entry shapes.
 *
 * Bot replies arrive as `{ kind: "send-message", message: { type, content } }`.
 * Attachment replies use `{ message: { type: "attachment", url, file_name } }`;
 * those become a visible `📎 name` line followed by the link so a text-only
 * renderer never turns them into an empty row. An optional attachmentUrl hook
 * can substitute a clickable download URL without changing the transcript.
 */
export function entryText(entry: unknown, options: GrokThreadTextOptions = {}): string {
  const { body, attachments } = entryParts(entry)
  const rendered = attachments
    .map(attachment => attachmentText(attachment, options))
    .filter(part => part !== '')
  if (body !== '' && rendered.length > 0) return `${body}\n\n${rendered.join('\n')}`
  if (body !== '') return body
  if (rendered.length > 0) return rendered.join('\n')
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof (entry as Record<string, unknown>).preview === 'string'
    ? normalizeText((entry as Record<string, unknown>).preview)
    : ''
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

function speakerOf(record: Record<string, unknown>): GrokThreadEntry['speaker'] {
  if (record.kind === 'send-message') return 'assistant'
  if (record.kind === 'user-attachment') return 'user'
  if (record.kind !== 'message') return 'other'
  const role = typeof record.role === 'string' ? record.role.toLowerCase() : ''
  if (role === 'user') return 'user'
  if (role === 'assistant' || role === 'agent' || role === 'bot') return 'assistant'
  return 'other'
}

/** Bound one entry's metadata and text for model-facing output. */
function threadEntry(
  raw: unknown,
  options: GrokThreadTextOptions,
): { entry: GrokThreadEntry; metaLength: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const text = entryText(raw, options)
    const bounded = text.length > ENTRY_FULL_MAX ? text.slice(0, ENTRY_FULL_MAX) : text
    return {
      entry: {
        id: '',
        kind: 'unknown',
        speaker: 'other',
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
  const text = entryText(raw, options)
  const truncated = text.length > ENTRY_FULL_MAX
  const entry: GrokThreadEntry = {
    id: id.length > ENTRY_META_MAX ? `${id.slice(0, ENTRY_META_MAX)}…` : id,
    kind: kind.length > ENTRY_META_MAX ? `${kind.slice(0, ENTRY_META_MAX)}…` : kind,
    speaker: speakerOf(record),
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
    metaLength: entry.id.length + entry.kind.length + entry.speaker.length + (entry.role?.length ?? 0),
  }
}

/** Bound an entry list by per-entry and total model-facing budgets. */
export function projectThreadEntries(
  entries: readonly unknown[],
  options: GrokThreadTextOptions = {},
): GrokThreadEntry[] {
  let remaining = TRANSCRIPT_TOTAL_MAX
  return entries.map((raw) => {
    const { entry, metaLength } = threadEntry(raw, options)
    const allowedText = Math.max(0, Math.min(entry.text.length, remaining - metaLength))
    if (allowedText < entry.text.length) {
      entry.text = allowedText <= 0 ? '' : entry.text.slice(0, allowedText)
      entry.truncated = entry.fullLength > entry.text.length
    }
    remaining = Math.max(0, remaining - metaLength - entry.text.length)
    return entry
  })
}

/** Drop the earlier transcript context before the most recent human prompt. */
export function latestTurnEntries(entries: readonly GrokThreadEntry[]): GrokThreadEntry[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.speaker === 'user' && entry.kind === 'message') return entries.slice(index)
  }
  return [...entries]
}
