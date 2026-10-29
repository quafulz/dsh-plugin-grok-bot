/**
 * The bundled `grokbot` skill.
 *
 * The body lives next to the package (`skills/grokbot/SKILL.md`) so it can be
 * edited as Markdown; `apply` reads it once and registers it with the DSH skill
 * registry as a runtime contribution. The registry merges it into every agent's
 * catalog, and a user-invocable skill is what dsh-TUI turns into a `/name`
 * command when no command of that name exists.
 *
 * Registration is strictly best-effort: a missing registry, an unreadable file
 * or a rejected definition must never take the host down.
 *
 * @module skill
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

/** Must match the file path and stay kebab-case (the registry's name grammar). */
export const SKILL_NAME = 'grokbot'

const SKILL_FILE = new URL('../skills/grokbot/SKILL.md', import.meta.url)

const SKILL_DESCRIPTION = 'Send messages to Grok Bot bots and groups and read their threaded replies'

const SKILL_WHEN_TO_USE = 'When the user wants to message a Grok Bot, check its replies, or list available bots'

/** Structural view of the DSH skill registry (no runtime dependency). */
interface SkillRegistryLike {
  register(skill: {
    readonly name: string
    readonly description: string
    readonly whenToUse?: string
    readonly content: string
    readonly path?: string
    readonly source: string
    readonly provider?: string
    readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  }): () => void
}

/**
 * Register the bundled skill on the calling scope's skill registry.
 *
 * `ctx.inject` keeps the dependency optional: a composition without
 * `@deepseek-ai/dsh-skill` never runs the callback and the tools keep working.
 *
 * @param ctx - plugin activation context.
 */
export function registerGrokbotSkill(ctx: Context): void {
  const content = readSkillBody()
  if (content === undefined) {
    ctx.logger.warn(`grok-bot: skills/${SKILL_NAME}/SKILL.md is unreadable; the skill is not registered`)
    return
  }

  ctx.inject(['skills'], (skillsCtx) => {
    const registry = skillsCtx.get('skills', false) as SkillRegistryLike | undefined
    if (registry === undefined) return
    try {
      skillsCtx.effect(() => registry.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        content,
        path: fileURLToPath(SKILL_FILE),
        source: 'bundled',
        provider: 'grok-bot',
        invocation: { modelInvocable: true, userInvocable: true },
      }))
    } catch (error) {
      ctx.logger.warn(`grok-bot: the ${SKILL_NAME} skill was not registered: %o`, error)
    }
  })
}

/** Read the bundled Markdown body, or `undefined` when the packaged file is missing. */
function readSkillBody(): string | undefined {
  try {
    const body = readFileSync(SKILL_FILE, 'utf8').trim()
    return body === '' ? undefined : body
  } catch {
    return undefined
  }
}
