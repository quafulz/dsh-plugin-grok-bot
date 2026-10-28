import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

import type { GrokAgentRecord } from '../grok/gateway.js'

/** Lossless JSON value accepted by DSH tool outputs. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** One bot or group as exposed to the model. */
export interface TargetView {
  id: string
  name: string
  kind: 'bot' | 'group'
  title: string
  description: string
  memberIds: string[]
}

/** Output schema for a bot or group reference. */
export const targetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Opaque Grok Bot agent id.' },
    name: { type: 'string', required: true, description: 'Display name.' },
    kind: {
      type: 'string',
      required: true,
      enum: ['bot', 'group'],
      description: 'Whether this target is a single bot or a group.',
    },
    title: { type: 'string', description: 'Optional title.' },
    description: { type: 'string', description: 'Instructions or group description.' },
    memberIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Member bot ids for a group.',
    },
  },
} as const satisfies ValueSchemaSpec

/** Output schema for one bounded thread entry. */
export const threadEntrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Opaque entry id usable as a cursor.' },
    kind: { type: 'string', required: true, description: 'Transcript entry kind.' },
    role: { type: 'string', description: 'Speaker role when the gateway reports one.' },
    text: { type: 'string', required: true, description: 'Bounded entry text.' },
    truncated: {
      type: 'boolean',
      required: true,
      description: 'Whether text was cut by the model-facing budget.',
    },
    fullLength: {
      type: 'integer',
      required: true,
      description: 'Original text length before truncation.',
    },
    timestampMs: {
      type: 'integer',
      description: 'Entry timestamp in Unix milliseconds when present.',
    },
  },
} as const satisfies ValueSchemaSpec

/** Project a gateway record into the stable model-facing shape. */
export function targetView(record: GrokAgentRecord): TargetView {
  return {
    id: record.id,
    name: record.name,
    kind: record.isGroup ? 'group' : 'bot',
    title: record.title,
    description: record.description,
    memberIds: record.memberIds,
  }
}

/** Convert an arbitrary gateway payload to lossless JSON for tool output. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return null
    return JSON.parse(encoded) as JsonValue
  } catch {
    return String(value)
  }
}

/** Build one native text content block. */
export function textContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}
