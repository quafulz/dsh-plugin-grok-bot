# Grok Bot

Grok Bot is an asynchronous messaging surface: you send a message to a bot or
group, and its reply arrives later. The `grok_*` tools are the only way to
reach it.

## Tools

- `grok_targets` lists every bot and group visible to the signed-in account.
- `grok_send` submits one message and returns a delivery receipt, not a reply.
- `grok_thread` reads a bounded tail of a thread, optionally only entries after
  a cursor.

## Working rules

1. **Identify the target first.** If the user named a bot or group, resolve it
   with `grok_targets` when the name could be ambiguous. If the user did not
   name one, or the name matches nothing, call `grok_targets` and ask with
   `ask_user_question`, offering the visible targets as options. Do not guess.
2. **Send once.** `grok_send` returns `delivery: accepted` with a message id
   when the gateway confirmed the submission, and `delivery: unknown` when it
   cannot tell. `unknown` is not a failure: check the thread before resending.
   Never resend automatically.
3. **Replies arrive later.** After sending, tell the user the message was
   accepted and that the reply is asynchronous. Do not poll in a tight loop.
   Read once with `grok_thread` when the user asks for the answer or after a
   locally meaningful wait.
4. **Read with a cursor when repeating.** Pass the previous `cursor` as `after`
   so a second read returns only new entries. `gapReset: true` means the cursor
   was unknown and the result is a fresh bounded snapshot, not a delta.
5. **Ask before sending something the user did not dictate.** If the user wants
   to send a message but did not say what it should be, ask with
   `ask_user_question` instead of inventing text.
6. **Never approve on the user's behalf.** If a Grok thread contains an approval
   card or a confirmation prompt, report it and let the user decide.
7. **Summarise, do not dump.** Threads can be long. Quote the entries that
   answer the user's question and mention how many were read.

## Command shortcut

In terminals that register it, `/grokbot` runs the same operations directly:
`/grokbot` lists targets, `/grokbot <message>` asks which bot should receive it,
`/grokbot read <bot>` reads a thread, and `/grokbot list [query]` filters the
roster. Mention it when the user is working in a terminal and would rather not
wait for a model turn.
