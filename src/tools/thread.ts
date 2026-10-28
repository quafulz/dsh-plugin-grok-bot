import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { ResolvedConfig } from '../config.js'
import type { GrokBotService } from '../service.js'
import { projectThreadEntries, transcriptDelta } from '../grok/transcript.js'
import { targetSchema, targetView, textContent, threadEntrySchema } from './shared.js'

/** Register `grok_thread` on the tool runtime. */
export function registerThreadTool(
  ctx: Context,
  service: GrokBotService,
  config: ResolvedConfig,
): void {
  ctx.tools.register(defineTool({
    name: 'grok_thread',
    description:
      'Read a bounded Grok Bot thread tail. By default it returns a small receipt; pass full=true for bounded entry text. Pass the previous cursor as after to receive only new entries. An unknown cursor returns a bounded snapshot with gapReset=true.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'Bot or group name or id. Use grok_targets when ambiguous.',
      },
      after: {
        type: 'string',
        description: 'Opaque cursor from the prior call. Returns entries strictly after it.',
      },
      limit: {
        type: 'integer',
        description: `How many trailing entries to inspect (1-200). Defaults to ${config.defaultThreadLimit}.`,
      },
      full: {
        type: 'boolean',
        description: 'Include bounded entry text. Defaults to false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { ...targetSchema, required: true, description: 'Resolved thread target.' },
          cursor: {
            type: 'string',
            required: true,
            description: 'Opaque cursor for the next after call.',
          },
          entryCount: {
            type: 'integer',
            required: true,
            description: 'Number of selected entries.',
          },
          gapReset: {
            type: 'boolean',
            required: true,
            description: 'True when the cursor was unknown and a bounded snapshot was returned.',
          },
          summary: { type: 'string', required: true, description: 'Short result summary.' },
          entries: {
            type: 'array',
            items: threadEntrySchema,
            description: 'Bounded entries when full=true.',
          },
        },
      },
      render: (_args, value) => {
        const lines = [`${value.summary}\ncursor: ${value.cursor}`]
        if (value.entries === undefined) {
          lines.push('Pass full=true to include bounded entry text.')
        } else if (value.entries.length === 0) {
          lines.push('No new entries.')
        } else {
          lines.push(value.entries.map(entry =>
            `[${entry.id}] ${entry.kind}${entry.role ? `/${entry.role}` : ''}: ${entry.text}${entry.truncated ? '…' : ''}`,
          ).join('\n'))
        }
        return textContent(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const limit = args.limit ?? config.defaultThreadLimit
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new Error('grok_thread: limit must be an integer from 1 to 200')
      }
      const tail = await service.thread(args.target, limit, exec.signal)
      const delta = transcriptDelta(tail.transcript, {
        ...(args.after === undefined ? {} : { after: args.after }),
        limit,
      })
      const entries = projectThreadEntries(delta.entries)
      const summary = args.after === undefined
        ? `${delta.entryCount} entr${delta.entryCount === 1 ? 'y' : 'ies'}`
        : delta.gapReset
          ? `${delta.entryCount} entries; gap reset`
          : `${delta.entryCount} new entr${delta.entryCount === 1 ? 'y' : 'ies'}`
      return {
        target: targetView(tail.target),
        cursor: delta.cursor,
        entryCount: delta.entryCount,
        gapReset: delta.gapReset,
        summary,
        ...(args.full === true ? { entries } : {}),
      }
    },
  }))
}
