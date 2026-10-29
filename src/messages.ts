/**
 * User-facing copy for the `/grokbot` command, kept in one table so the
 * command surface and the managed dialogs share a single wording source.
 *
 * A plugin cannot read the host UI language, so the locale is explicit
 * configuration: `en` (default) or `zh`.
 *
 * @module messages
 */

/** Locale accepted by {@link messagesFor}. */
export type GrokbotLocale = 'en' | 'zh'

/** Every string the `/grokbot` command renders. */
export interface GrokbotMessages {
  /** Discovery description registered with the command registry. */
  readonly commandDescription: string
  /** Free-form input hint advertised to capable composers. */
  readonly inputHint: string
  /** Usage line appended to listings and missing-argument errors. */
  readonly usage: string
  readonly noTargets: string
  readonly cancelled: string
  readonly targetRequired: string
  readonly messageRequired: string
  readonly pickTarget: string
  readonly askMessagePlaceholder: string
  readonly threadEmpty: string
  /** `1 Grok Bot target` / `2 Grok Bot targets`. */
  targetCount(count: number): string
  /** Filters the roster when the user supplied a query. */
  targetLine(target: { name: string; id: string; title: string; isGroup: boolean }): string
  /** `… and 3 more` for a roster longer than the report budget. */
  moreTargets(count: number): string
  /** Title when a roster is longer than the dialog option budget. */
  pickTargetNote(shown: number, total: number): string
  askMessage(target: string): string
  /** `bot · Title` or `group · Title`. */
  kindLabel(isGroup: boolean, title: string): string
  /** Receipt line for a confirmed submission. */
  sent(target: string, messageId: string | undefined): string
  /** Receipt line when neither the gateway nor the transcript confirmed delivery. */
  deliveryUnknown(target: string): string
  threadHeader(target: string, count: number): string
  moreEntries(count: number): string
}

const EN: GrokbotMessages = {
  commandDescription: 'Talk to Grok Bot: list targets, send a message, or read a thread',
  inputHint: '<message | send <bot> <message> | read <bot> | list>',
  usage: 'Usage: /grokbot <message> · /grokbot send <bot> <message> · /grokbot read <bot> [limit] · /grokbot list [query]',
  noTargets: 'No Grok Bot bots or groups are visible to this account.',
  cancelled: 'Cancelled.',
  targetRequired: 'Which bot? Name it in the command: /grokbot send <bot> <message>',
  messageRequired: 'What should be sent? Name it in the command: /grokbot send <bot> <message>',
  pickTarget: 'Send to which bot?',
  askMessagePlaceholder: 'Enter to send, Esc to cancel',
  threadEmpty: 'No entries in this thread yet.',
  targetCount: count => `${count} Grok Bot target${count === 1 ? '' : 's'}`,
  targetLine: target =>
    `- [${target.isGroup ? 'group' : 'bot'}] ${target.name} (${target.id})${target.title.trim() === '' ? '' : ` — ${target.title}`}`,
  moreTargets: count => `… and ${count} more`,
  pickTargetNote: (shown, total) => `showing ${shown} of ${total}`,
  askMessage: target => `What should ${target} receive?`,
  kindLabel: (isGroup, title) => `${isGroup ? 'group' : 'bot'}${title.trim() === '' ? '' : ` · ${title}`}`,
  sent: (target, messageId) =>
    `Sent to ${target}${messageId === undefined ? '' : ` (message ${messageId})`}. Read the reply with /grokbot read ${target}.`,
  deliveryUnknown: target =>
    `Delivery unknown for ${target}: no gateway receipt, and the message was not found in the latest transcript yet. Check with /grokbot read ${target} before resending.`,
  threadHeader: (target, count) => `${target}: ${count} entr${count === 1 ? 'y' : 'ies'}`,
  moreEntries: count => `… ${count} earlier entr${count === 1 ? 'y' : 'ies'} not shown`,
}

const ZH: GrokbotMessages = {
  commandDescription: '与 Grok Bot 对话：列出目标、发送消息、读取会话',
  inputHint: '<消息 | send <bot> <消息> | read <bot> | list>',
  usage: '用法：/grokbot <消息> · /grokbot send <bot> <消息> · /grokbot read <bot> [条数] · /grokbot list [关键词]',
  noTargets: '当前账号看不到任何 Grok Bot 机器人或群组。',
  cancelled: '已取消。',
  targetRequired: '要发给哪个 bot？请在命令里写明：/grokbot send <bot> <消息>',
  messageRequired: '要发什么？请在命令里写上消息：/grokbot send <bot> <消息>',
  pickTarget: '发送给哪个 bot？',
  askMessagePlaceholder: '回车发送，Esc 取消',
  threadEmpty: '这个会话还没有内容。',
  targetCount: count => `共 ${count} 个目标`,
  targetLine: target =>
    `- [${target.isGroup ? '群组' : 'bot'}] ${target.name} (${target.id})${target.title.trim() === '' ? '' : ` — ${target.title}`}`,
  moreTargets: count => `… 另有 ${count} 个未显示`,
  pickTargetNote: (shown, total) => `显示 ${shown}/${total} 个`,
  askMessage: target => `给 ${target} 发什么？`,
  kindLabel: (isGroup, title) => `${isGroup ? '群组' : 'bot'}${title.trim() === '' ? '' : ` · ${title}`}`,
  sent: (target, messageId) =>
    `已投递给 ${target}${messageId === undefined ? '' : `（message ${messageId}）`}。用 /grokbot read ${target} 查看回复。`,
  deliveryUnknown: target => `无法确认是否已投递给 ${target}：网关没有回执，最新会话里暂未找到匹配条目。重发前先用 /grokbot read ${target} 检查会话。`,
  threadHeader: (target, count) => `${target}：${count} 条`,
  moreEntries: count => `… 另有 ${count} 条较早内容未显示`,
}

/** Copy for one resolved locale. */
export function messagesFor(locale: GrokbotLocale): GrokbotMessages {
  return locale === 'zh' ? ZH : EN
}
