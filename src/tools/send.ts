import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { GrokBotService } from '../service.js'
import { targetSchema, targetView, textContent, toJsonValue } from './shared.js'

/** Register `grok_send` on the tool runtime. */
export function registerSendTool(ctx: Context, service: GrokBotService): void {
  ctx.tools.register(defineTool({
    name: 'grok_send',
    description:
      'Send a message to a Grok Bot bot or group. This is asynchronous: it returns a delivery receipt, not the bot reply. Read replies later with grok_thread. If delivery is unknown, inspect the thread before resending. Never auto-approve Grok approval cards.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'Bot or group name or id. Use grok_targets when ambiguous.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Message text to submit.',
      },
      replyTo: {
        type: 'string',
        description: 'Optional prior transcript entry id this message replies to.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { ...targetSchema, required: true, description: 'Resolved recipient.' },
          delivery: {
            type: 'string',
            required: true,
            enum: ['accepted', 'unknown'],
            description: 'Accepted means the gateway confirmed a message id; unknown means inspect the thread.',
          },
          messageId: {
            type: 'string',
            description: 'Gateway message id when the submission was confirmed.',
          },
          clientNonce: {
            type: 'string',
            required: true,
            description: 'Idempotency nonce attached to this submission.',
          },
          result: {
            type: 'json',
            required: true,
            description: 'Raw gateway response without credentials.',
          },
        },
      },
      render: (_args, value) => {
        const recipient = `${value.target.kind} ${value.target.name} (${value.target.id})`
        if (value.delivery === 'accepted') {
          return textContent(
            `Sent to ${recipient}${value.messageId ? `; message ${value.messageId}` : ''}. Use grok_thread to read the reply.`,
          )
        }
        return textContent(
          `Delivery unknown for ${recipient}. Inspect grok_thread before resending; the request may have landed.`,
        )
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const message = args.message.trim()
      if (message === '') throw new Error('grok_send: message must not be empty')
      const receipt = await service.send(args.target, message, {
        signal: exec.signal,
        ...(args.replyTo === undefined ? {} : { replyToId: args.replyTo }),
      })
      return {
        target: targetView(receipt.target),
        delivery: receipt.delivery,
        ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
        clientNonce: receipt.clientNonce,
        result: toJsonValue(receipt.result),
      }
    },
  }))
}
