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
   accepted and that the reply is asynchronous. Then read with `grok_thread`
   once every 5 minutes, at most 5 times, reusing the same `after` cursor.
   `entryCount: 0` means the bot is still working, not that the message
   failed. If the fifth read still returns nothing new (~25 minutes), report
   how long you waited and what you last saw, and suggest the user open the
   Grok Bot app to look at the thread directly. Never poll faster than once
   per minute.
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
8. **Surface attachments explicitly.** Bot files and images appear in entry
   text as a `📎 file name` line followed by a clickable loopback download
   link. Give the user the file name and link. Opening the link performs the
   `readAttachmentChunk` transfer; do not fetch or claim to have opened the
   file yourself.

## Failures

- `listAgents failed: 417 Expectation Failed`, a `401`/`403` on any call, or
  `NO_AUTH` all mean the Grok Bot sign-in is stale. The plugin has already
  retried the read once with a fresh session, so retrying the same call again
  will not help. Tell the user their Grok Bot session has expired, ask them to
  open the Grok Bot app, check the account and sign in again, and try again
  only after they confirm.
- `delivery: unknown` is not an auth failure: read the thread before resending.
- Any other error: report the message as-is instead of guessing at a cause.

## Command shortcut

In terminals that register it, `/grokbot` runs the same operations directly:
`/grokbot` lists targets, `/grokbot <message>` asks which bot should receive it,
`/grokbot read <bot>` reads a thread, and `/grokbot list [query]` filters the
roster. Mention it when the user is working in a terminal and would rather not
wait for a model turn.
