import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { GrokBotService } from '../service.js'
import { targetSchema, targetView, textContent } from './shared.js'

/** Register `grok_targets` on the tool runtime. */
export function registerTargetsTool(ctx: Context, service: GrokBotService): void {
  ctx.tools.register(defineTool({
    name: 'grok_targets',
    description:
      'List Grok Bot bots and groups visible to the signed-in account. Use this before grok_send when a target name is ambiguous.',
    parameters: {
      kind: {
        type: 'string',
        enum: ['all', 'bot', 'group'],
        description: 'Filter by target kind. Defaults to all.',
      },
      query: {
        type: 'string',
        description: 'Optional case-insensitive id, name, or title filter.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true, description: 'Number of returned targets.' },
          targets: {
            type: 'array',
            required: true,
            items: targetSchema,
            description: 'Matching bots and groups.',
          },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return textContent('No matching Grok Bot targets.')
        const lines = value.targets.map(target =>
          `- [${target.kind}] ${target.name} (${target.id})${target.title ? ` — ${target.title}` : ''}`)
        return textContent(`${value.count} Grok Bot target${value.count === 1 ? '' : 's'}:\n${lines.join('\n')}`)
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const records = await service.targets(exec.signal)
      const needle = args.query?.trim().toLowerCase()
      const filtered = records.filter((record) => {
        if (args.kind === 'bot' && record.isGroup) return false
        if (args.kind === 'group' && !record.isGroup) return false
        if (needle === undefined || needle === '') return true
        return record.id.toLowerCase().includes(needle)
          || record.name.toLowerCase().includes(needle)
          || record.title.toLowerCase().includes(needle)
      })
      return {
        count: filtered.length,
        targets: filtered.map(targetView),
      }
    },
  }))
}
