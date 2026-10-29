import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { registerGrokbotSkill } from '../src/skill.ts'

interface RegisteredSkill {
  name: string
  description: string
  content: string
  source: string
  invocation?: { modelInvocable: boolean; userInvocable: boolean }
}

function fakeContext(options: { skills: boolean }): { ctx: Context; registered: RegisteredSkill[] } {
  const registered: RegisteredSkill[] = []
  const registry = {
    register(skill: RegisteredSkill) {
      registered.push(skill)
      return () => {}
    },
  }
  const ctx = {
    logger: { warn() {} },
    get(name: string) {
      return options.skills && name === 'skills' ? registry : undefined
    },
    inject(_deps: readonly string[], callback: (value: unknown) => void) {
      callback(ctx)
    },
    effect(body: () => () => void) {
      body()
    },
  }
  return { ctx: ctx as unknown as Context, registered }
}

test('registers the bundled skill as a user-invocable runtime contribution', () => {
  const { ctx, registered } = fakeContext({ skills: true })
  registerGrokbotSkill(ctx)
  assert.equal(registered.length, 1)
  const skill = registered[0]
  assert.equal(skill?.name, 'grokbot')
  assert.equal(skill?.source, 'bundled')
  assert.equal(skill?.invocation?.userInvocable, true)
  assert.equal(skill?.invocation?.modelInvocable, true)
  assert.match(skill?.content ?? '', /grok_targets/)
  assert.match(skill?.content ?? '', /grok_thread/)
})

test('a composition without a skill registry is left untouched', () => {
  const { ctx, registered } = fakeContext({ skills: false })
  registerGrokbotSkill(ctx)
  assert.equal(registered.length, 0)
})
