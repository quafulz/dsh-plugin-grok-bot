/**
 * `/grokbot` as a deterministic DSH command.
 *
 * The grammar is forgiving on purpose: free text becomes a message and the
 * user is asked which bot should receive it. Asking happens through dsh-TUI's
 * managed dialogs (`ctx.tuiDialogs`), which a command handler can await; the
 * command's own result text cannot ask a follow-up question. On hosts without
 * that seam the command still serves fully specified lines and answers a
 * missing argument with usage instead of guessing.
 *
 * The companion skill (`skills/grokbot/SKILL.md`) covers the free-form
 * conversation route: dsh-TUI prefers a registered command over a skill of the
 * same name, so `/grokbot` always lands here and the skill serves the model
 * when the user asks in plain language.
 *
 * @module command/register
 */

import type { Context } from '@deepseek-ai/cordis'

import type { ResolvedConfig } from '../config.js'
import { errorText } from '../grok/errors.js'
import type { GrokAgentRecord, GrokSendReceipt } from '../grok/gateway.js'
import type { AttachmentLinker } from '../grok/attachment-links.js'
import {
  latestTurnEntries,
  projectThreadEntries,
  transcriptDelta,
  type GrokThreadEntry,
} from '../grok/transcript.js'
import { messagesFor, type GrokbotMessages } from '../messages.js'
import { parseGrokbotInput } from './parse.js'
import type { GrokBotService } from '../service.js'

/** Registry name, also the skill name; dsh-TUI prefers this command on collision. */
export const COMMAND_NAME = 'grokbot'

/** The dialog seam's own option cap. */
const MAX_DIALOG_OPTIONS = 100
/** Long enough to read a roster, short enough not to hold the keyboard all day. */
const DIALOG_TIMEOUT_MS = 120_000
/** Rows the command report shows before summarising the rest. */
const MAX_REPORT_TARGETS = 50
const MAX_REPORT_ENTRIES = 20
/** Bounded per-session memory for "the bot I used last". */
const LAST_TARGET_CAPACITY = 32

/** Handler invocation as the registry delivers it. */
interface CommandInvocationLike {
  readonly agent: { readonly id: string }
  readonly rawInput: string
  readonly signal: AbortSignal
}

type CommandResultLike =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Structural view of a `dsh-commands` definition (no runtime dependency). */
export interface CommandDefinitionLike {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly recordInput?: boolean
  handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
}

/** Structural view of `dsh-commands`' `CommandRuntime.register`. */
interface CommandRuntimeLike {
  register(definition: CommandDefinitionLike): () => void
}

/** Structural view of dsh-TUI's managed dialogs (`ctx.tuiDialogs`). */
export interface TuiDialogsLike {
  select(request: {
    title: string
    options: readonly { id: string; label: string; description?: string }[]
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<string | undefined>
  input(request: {
    title: string
    placeholder?: string
    initial?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<string | undefined>
}

type TargetPick =
  | { readonly kind: 'target'; readonly id: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable' }

type MessageAsk =
  | { readonly kind: 'message'; readonly message: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable' }

/** Everything the command closure reads; kept explicit so tests can build one. */
export interface GrokbotCommandDeps {
  readonly service: GrokBotService
  readonly config: ResolvedConfig
  readonly messages: GrokbotMessages
  /** Absent when the host has no `tuiDialogs` service. */
  readonly dialogs?: () => TuiDialogsLike | undefined
  /** Optional loopback download-link factory for attachment entries. */
  readonly attachments?: AttachmentLinker
}

/**
 * Build the `/grokbot` definition. Pure wiring: no registry, no lifecycle.
 *
 * @param deps - service, resolved config, copy and the optional dialog seam.
 * @returns a command definition ready for `commands.register`.
 */
export function createGrokbotCommand(deps: GrokbotCommandDeps): CommandDefinitionLike {
  const { service, config, messages, attachments } = deps
  const remembered = new Map<string, string>()

  return {
    name: COMMAND_NAME,
    description: messages.commandDescription,
    input: { hint: messages.inputHint },
    async handler({ agent, rawInput, signal }) {
      try {
        const targets = await service.targets(signal)
        const intent = parseGrokbotInput(rawInput, targets)
        if (intent.kind === 'list') {
          return { kind: 'success', text: listText(targets, intent.query, messages) }
        }
        if (targets.length === 0) return { kind: 'error', text: messages.noTargets }

        let ref = intent.targetRef ?? rememberedTarget(remembered, agent.id, targets)
        if (ref === undefined) {
          const picked = await pickTarget(deps.dialogs?.(), targets, signal, messages)
          if (picked.kind === 'cancelled') return { kind: 'success', text: messages.cancelled }
          if (picked.kind === 'unavailable') return { kind: 'error', text: messages.targetRequired }
          ref = picked.id
        }

        if (intent.kind === 'read') {
          const limit = intent.limit ?? config.defaultThreadLimit
          const tail = await service.thread(ref, limit, signal)
          rememberTarget(remembered, agent.id, targets, tail.target.id)
          const delta = transcriptDelta(tail.transcript, { limit })
          const links = attachments === undefined
            ? undefined
            : await attachments.linksFor(tail.target.id, delta.entries, signal)
          const entries = projectThreadEntries(
            delta.entries,
            links === undefined
              ? {}
              : { attachmentUrl: attachment => links.get(attachment.source) },
          )
          return { kind: 'success', text: threadText(tail.target.name, entries, messages) }
        }

        let message = intent.message
        if (message === undefined) {
          const display = targets.find(target => target.id === ref)?.name ?? ref
          const asked = await askMessage(deps.dialogs?.(), display, signal, messages)
          if (asked.kind === 'cancelled') return { kind: 'success', text: messages.cancelled }
          if (asked.kind === 'unavailable') return { kind: 'error', text: messages.messageRequired }
          message = asked.message
        }

        const receipt = await service.send(ref, message, { signal })
        rememberTarget(remembered, agent.id, targets, receipt.target.id)
        return { kind: 'success', text: receiptText(receipt, messages) }
      } catch (error) {
        return { kind: 'error', text: errorText(error) }
      }
    },
  }
}

/**
 * Register `/grokbot` on the command service of the calling scope.
 *
 * The plugin registers directly (`ctx.get('commands')`), the documented
 * same-process trust boundary. dsh-TUI's attributed surface
 * (`ctx.tuiPluginHost.registerCommand`) additionally requires an admitted
 * package manifest declaring the command; the plugin ships no manifest yet, so
 * attribution is left to the host's default-allow invoke checkpoint.
 *
 * Both the registry and the command are optional: a composition without
 * `dsh-commands` keeps the tools and the skill and simply loses the command.
 *
 * @param ctx - plugin activation context.
 * @param service - shared Grok Bot facade.
 * @param config - resolved plugin configuration.
 * @param attachments - optional loopback download-link factory.
 */
export function registerGrokbotCommand(
  ctx: Context,
  service: GrokBotService,
  config: ResolvedConfig,
  attachments?: AttachmentLinker,
): void {
  const definition = createGrokbotCommand({
    service,
    config,
    messages: messagesFor(config.locale),
    dialogs: () => ctx.get('tuiDialogs', false) as TuiDialogsLike | undefined,
    ...(attachments === undefined ? {} : { attachments }),
  })

  ctx.inject(['commands'], (commandCtx) => {
    const runtime = commandCtx.get('commands', false) as CommandRuntimeLike | undefined
    if (runtime === undefined) return
    try {
      commandCtx.effect(() => runtime.register(definition))
    } catch (error) {
      // A duplicate name (two copies of the plugin in one layer) must not take
      // the host down; the tools and the skill keep working.
      ctx.logger.warn(`grok-bot: /${COMMAND_NAME} was not registered: %o`, error)
    }
  })
}

function listText(
  targets: readonly GrokAgentRecord[],
  query: string,
  messages: GrokbotMessages,
): string {
  if (targets.length === 0) return messages.noTargets
  const needle = query.trim().toLowerCase()
  const matching = needle === ''
    ? targets
    : targets.filter(target =>
      target.name.toLowerCase().includes(needle)
      || target.title.toLowerCase().includes(needle)
      || target.id.toLowerCase().includes(needle))
  const lines = [messages.targetCount(matching.length)]
  for (const target of matching.slice(0, MAX_REPORT_TARGETS)) lines.push(messages.targetLine(target))
  if (matching.length > MAX_REPORT_TARGETS) {
    lines.push(messages.moreTargets(matching.length - MAX_REPORT_TARGETS))
  }
  if (matching.length > 0) lines.push('', messages.usage)
  return lines.join('\n')
}

async function pickTarget(
  dialogs: TuiDialogsLike | undefined,
  targets: readonly GrokAgentRecord[],
  signal: AbortSignal,
  messages: GrokbotMessages,
): Promise<TargetPick> {
  // Even a single visible target is confirmed, never assumed: a mistyped bot
  // name parses as message text, and silently sending that text to the only
  // bot is the one mistake this flow must not make.
  if (dialogs === undefined) return { kind: 'unavailable' }
  const shown = targets.slice(0, MAX_DIALOG_OPTIONS)
  const title = targets.length > shown.length
    ? `${messages.pickTarget} (${messages.pickTargetNote(shown.length, targets.length)})`
    : messages.pickTarget
  const id = await dialogs.select({
    title,
    options: shown.map(target => ({
      id: target.id,
      label: target.name,
      description: messages.kindLabel(target.isGroup, target.title),
    })),
    timeoutMs: DIALOG_TIMEOUT_MS,
    signal,
  })
  return id === undefined ? { kind: 'cancelled' } : { kind: 'target', id }
}

async function askMessage(
  dialogs: TuiDialogsLike | undefined,
  target: string,
  signal: AbortSignal,
  messages: GrokbotMessages,
): Promise<MessageAsk> {
  if (dialogs === undefined) return { kind: 'unavailable' }
  const text = await dialogs.input({
    title: messages.askMessage(target),
    placeholder: messages.askMessagePlaceholder,
    timeoutMs: DIALOG_TIMEOUT_MS,
    signal,
  })
  const message = text?.trim() ?? ''
  return message === '' ? { kind: 'cancelled' } : { kind: 'message', message }
}

function receiptText(receipt: GrokSendReceipt, messages: GrokbotMessages): string {
  return receipt.delivery === 'accepted'
    ? messages.sent(receipt.target.name, receipt.messageId)
    : messages.deliveryUnknown(receipt.target.name)
}

function threadText(
  target: string,
  entries: readonly GrokThreadEntry[],
  messages: GrokbotMessages,
): string {
  if (entries.length === 0) return messages.threadEmpty

  // A read is about what the bot just said. Older turns are useful context for
  // the model-facing tool, but a command report should open on the human's
  // latest prompt instead of replaying the whole tail.
  const latestTurn = latestTurnEntries(entries)
  const visible = latestTurn.filter(entry => entry.text.trim() !== '')
  if (visible.length === 0) return messages.threadEmpty

  const shown = visible.slice(-MAX_REPORT_ENTRIES)
  const lines = [messages.threadHeader(target, visible.length)]
  if (latestTurn.length < entries.length) lines.push(messages.latestTurnOnly)
  lines.push('')

  let previousSpeaker: (typeof shown)[number]['speaker'] | undefined
  for (const entry of shown) {
    // Speaker, not the wire kind (`send-message`, `event`, …): the reader
    // scans for who is talking; the opaque entry id belongs to the tool
    // surface (`replyTo`), not to this report.
    const speaker = entry.speaker
    if (speaker !== previousSpeaker) {
      if (previousSpeaker !== undefined) lines.push('')
      lines.push(speaker === 'user'
        ? messages.userSpeaker
        : speaker === 'assistant' ? target : messages.otherSpeaker)
      previousSpeaker = speaker
    } else {
      lines.push('')
    }
    lines.push(`${entry.text.trimEnd()}${entry.truncated ? '…' : ''}`)
  }
  if (visible.length > shown.length) {
    lines.push('', messages.moreEntries(visible.length - shown.length))
  }
  return lines.join('\n')
}

function rememberedTarget(
  store: ReadonlyMap<string, string>,
  key: string,
  targets: readonly GrokAgentRecord[],
): string | undefined {
  const id = store.get(key)
  return id !== undefined && targets.some(target => target.id === id) ? id : undefined
}

function rememberTarget(
  store: Map<string, string>,
  key: string,
  targets: readonly GrokAgentRecord[],
  id: string,
): void {
  if (!targets.some(target => target.id === id)) return
  store.delete(key)
  store.set(key, id)
  while (store.size > LAST_TARGET_CAPACITY) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}
