/**
 * Native DeepSeek Harness tools for Grok Bot.
 *
 * The plugin registers only the focused subset DSH needs: target discovery,
 * asynchronous message submission, and bounded thread reads. It intentionally
 * does not register subagent providers, MCP servers, or approval decisions.
 *
 * @module dsh-plugin-grok-bot
 */

import type { Context } from '@deepseek-ai/cordis'

import { registerGrokbotCommand } from './command/register.js'
import { resolveConfig, type Config } from './config.js'
import { GrokBotService } from './service.js'
import { registerGrokbotSkill } from './skill.js'
import { registerSendTool } from './tools/send.js'
import { registerTargetsTool } from './tools/targets.js'
import { registerThreadTool } from './tools/thread.js'

export { Config } from './config.js'
export { GrokBotService } from './service.js'
export { GrokBotError } from './grok/errors.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'grok-bot'

/** The tool registry is the only required service. */
export const inject = ['tools']

/**
 * Register the model-facing tools, the `/grokbot` command and the bundled
 * skill. Every surface is optional: a composition without `commands` or
 * `skills` keeps the remaining ones.
 * @param ctx - context carrying the DSH tool runtime.
 * @param config - deployment limits and auth source selection.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const service = new GrokBotService(resolved)
  registerTargetsTool(ctx, service)
  registerSendTool(ctx, service)
  registerThreadTool(ctx, service, resolved)
  // Order matters: dsh-TUI turns a user-invocable skill into a `/name`
  // command only when no command of that name exists yet, and it prefers a
  // registered command on collision. Cordis settles `ctx.inject` forks in
  // creation order, so registering the command first keeps `/grokbot` on the
  // deterministic, dialog-driven path.
  registerGrokbotCommand(ctx, service, resolved)
  registerGrokbotSkill(ctx)
}
