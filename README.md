# dsh-plugin-grok-bot

Talk to [Grok Bot](https://cursor.com/help/grok-bot/plans) from inside
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): list your bots,
hand one an assignment, and read its reply later, without leaving the terminal.

English · [简体中文](README.zh-CN.md)

## What this does

Grok Bot is a remote agent. It works on its own cloud workstation, so it cannot see
your laptop, your open editor, or a service on your `localhost`. DeepSeek Harness (DSH)
is where you work. This plugin connects the two:

- three native DSH tools that let a model list bots, send a message, and read a thread,
- the `/grokbot` command, which does the same from the prompt without spending a model turn,
- a bundled `grokbot` skill, so a plain-language request ("ask the web bot to fix the nav")
  reaches the right tool.

Replies are asynchronous. You send once, keep working, then read the thread.

## Requirements

- A DSH build that loads plugins and provides the `tools` service (dsh-TUI is the main host).
- Node `^22.19` or `>=24`.
- Grok Bot desktop installed and signed in, running as the same OS user as DSH. This is
  the default credential source. Headless setups can pass gateway credentials instead; see
  [Authentication](#authentication).

Supported on macOS, Linux, and Windows.

## Install

From Git, no npm release needed:

```sh
dsh plugin --profile dsh-tui add github:quafulz/dsh-plugin-grok-bot
```

From npm:

```sh
dsh plugin --profile dsh-tui add dsh-plugin-grok-bot
```

From a local clone, which is best while developing:

```sh
git clone https://github.com/quafulz/dsh-plugin-grok-bot.git
cd dsh-plugin-grok-bot
npm install --include=dev && npm run build

dsh plugin --profile dsh-tui add /absolute/path/to/dsh-plugin-grok-bot
```

Pin a release with `dsh-plugin-grok-bot@0.1.0`. Remove any route with
`dsh plugin --profile dsh-tui remove dsh-plugin-grok-bot`.

Adding the row by hand does the same thing:

```yaml
- insert:
    - id: tool-grok-bot
      name: 'dsh-plugin-grok-bot'
      config:
        appSession: true
        requestTimeoutMs: 30000
        maxResponseBytes: 2097152
        defaultThreadLimit: 40
```

## Quick start

1. Install the plugin as above and restart DSH.
2. Sign in to the Grok Bot desktop app once. The plugin reuses that session.
3. Type `/grokbot` in DSH.

```
> /grokbot
2 Grok Bot targets
- [bot] web-worker (wrk_01H8…) — Frontend worker
- [group] release-crew (grp_01H9…) — Ship coordination

Usage: /grokbot <message> · /grokbot send <bot> <message> · /grokbot read <bot> [limit] · /grokbot list [query]
```

Send something, then read the answer:

```
> /grokbot send web-worker fix the mobile nav regression on branch grok/GROK-123
Sent to web-worker (message msg_01H…). Read the reply with /grokbot read web-worker.

> /grokbot read web-worker
web-worker: 2 entries
user: fix the mobile nav regression on branch grok/GROK-123
assistant: On it. I'll push the branch and reply with STATUS: done.
```

## The `/grokbot` command

The grammar is forgiving on purpose. You can type a full line, or just enough for the
command to ask you for the rest.

| Input | Behavior |
| --- | --- |
| `/grokbot` | Lists every visible bot and group, then shows the usage line. |
| `/grokbot list [query]` | Lists the roster, optionally filtered by name, title, or id. |
| `/grokbot <message>` | Treats the text as the message. Uses your last bot, or asks which one. |
| `/grokbot send <message>` | Same as above. `send` is an optional shape word. |
| `/grokbot send <bot>` | Resolves the bot and asks what it should receive. |
| `/grokbot send <bot> <message>` | Sends immediately. Quote a multi-word name: `send "Chief of Staff" <message>`. |
| `/grokbot send -- <text>` | Sends the literal text, skipping target matching. |
| `/grokbot read [bot] [limit]` | Reads a thread tail. Reuses your last bot when omitted; `limit` is 1-200. |

Missing pieces are asked for through the host's own dialogs, so you pick a bot from a list
instead of memorising a format. A host without that seam (the official DSH front end, or a
headless embedder) still serves fully specified lines and answers a partial line with usage.

Targets are matched against the current roster by longest prefix on name, title, or id, so a
multi-word name such as `release crew` also works unquoted. Quotes make the target explicit and
exact: `send "Chief of Staff" <message>` never folds the quoted name into the message. Quoting is
reserved for a target; if a message itself starts with a bot name or quoted text, use the `--`
form.

Set `locale: zh` in the plugin config if you want the command and its dialogs in Chinese.

## Handing work to Grok Bot

Grok Bot is **not** a local coding agent like Codex or Claude Code started inside DSH. Those
run against the workspace on your machine. Grok Bot has its own cloud computer: no shared
filesystem, no access to your local tree, and normally no route to a DSH-local `localhost`.

Treat it as a colleague with a separate machine. Write a self-contained assignment, use Git
as the shared workspace, and review the result yourself.

The loop:

1. Push a branch `grok/<task-id>` with a short task file: base SHA, scope, design references,
   acceptance commands, constraints.
2. Resolve the bot with `grok_targets`, then call `grok_thread` once and keep its `cursor`.
3. Call `grok_send` once with the task id, repo, branch, base SHA, and the task-file path.
   Ask for a fixed reply format. Do not wait inside the tool call.
4. Keep working. Poll `grok_thread` with `after: "<cursor>"` and `full: true`.
5. Fetch the returned branch into a separate worktree, run build and tests, look at the
   screenshots or preview URL.
6. Send review comments to the same branch and commit. Merge and deploy only from DSH or CI.

A workable brief:

```text
You are the implementer for task GROK-123 on your own cloud workstation.

Repository: https://github.com/acme/web.git
Branch: grok/GROK-123
Base SHA: 4f2c1a9
Task brief: docs/tasks/GROK-123.md (already on the branch)
Goal: Fix the mobile navigation regression described in the task brief.

Acceptance:
- npm test
- npm run build
- Verify the fix at the preview URL in the task brief.

Constraints:
- Work only on the named branch and commit there.
- Do not deploy or merge.
- Do not assume access to the DSH machine or its localhost.
- Never include secrets in commits, replies, screenshots, or URLs.

Push the branch when done. Reply with exactly:
STATUS: done | blocked | failed
BRANCH: ...
COMMIT: ...
TESTS: ...
SCREENSHOTS: ...
BLOCKERS: ...
```

The same loop works for research and web page work; only the acceptance checks change.

Ground rules:

- One task, one branch, one main writer.
- `delivery: "accepted"` means submitted, not finished. `delivery: "unknown"` means the
  request may have landed: read the thread before resending.
- Grok's browser and terminal run on its machine, so a DSH-local `localhost` URL is usually
  unreachable. Use a preview deployment or screenshots.
- Never send secrets. Approval cards stay in the Grok UI; this plugin does not answer them.

## Or just ask the model

The bundled skill teaches the model when and how to call the tools. A request like "ask the
web bot whether the nav fix landed" resolves the target, sends with `grok_send`, and reads
back with `grok_thread`. If the target or the message is unclear, the model asks with
`ask_user_question` instead of guessing.

## Authentication

The default path reuses the Grok Bot desktop app's signed-in session. Install Grok Bot, sign
in once, and run DSH as the same OS user, with access to the app's data directory and keychain.

The plugin reads the credentials the installed Grok Bot version exposes:

- `gateway-descriptor.json`: saved gateway routing credentials. Legacy versions 1 and 2 are
  supported, as are version 3 descriptors with per-account entries.
- `sand-secrets.json`: the active account's encrypted access token. When no gateway descriptor
  has been written yet, the plugin decrypts this token and calls `EnsureSandBox` to mint a
  gateway session.
- `desktop-status.json`: the running app version, sent to `EnsureSandBox` so Cursor does not
  reject the request as an unsupported client.

These files live under:

- macOS: `~/Library/Application Support/Grok Bot/`
- Linux: `~/.config/Grok Bot/` or `$XDG_CONFIG_HOME/Grok Bot/`
- Windows: `%APPDATA%\Grok Bot\`

The minted gateway session is cached in-process. If the gateway answers `401`, `403`, or `417`
(an expired session), target and thread reads discard the cached client and retry once with a
fresh session. Sends are never retried automatically. When the status still comes back after
that retry, the error message says the session expired; the bundled skill turns that into a
request for the user to open Grok Bot and sign in again.

For headless or remote deployments, pass a gateway explicitly:

```sh
export GROK_BOT_GATEWAY_URL='https://...'
export GROK_BOT_GATEWAY_TOKEN='...'
```

Alternatively, provide `CURSOR_ACCESS_TOKEN` so the plugin can call `EnsureSandBox`. A Cursor
dashboard API key does not work. If the app version cannot be read, set `SAND_CLIENT_VERSION`
to the installed Grok Bot version.

Credential URLs are checked before use. Gateway credentials are limited to Cursor gateway
hosts; `EnsureSandBox` backend URLs are limited to Cursor API hosts. Loopback gateways require
`GROK_BOT_ALLOW_LOCAL_GATEWAY=1`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `appSession` | `true` | Read signed-in Grok Bot desktop credentials when no explicit gateway env is set. |
| `requestTimeoutMs` | `30000` | Deadline for one gateway HTTP request. |
| `maxResponseBytes` | `2097152` | Maximum buffered gateway response size. |
| `defaultThreadLimit` | `40` | Default trailing-entry count for `grok_thread` and `/grokbot read` (1-200). |
| `locale` | `en` | Copy language for `/grokbot` and its dialogs (`en` or `zh`). |

## Tool reference

The tools are what the model calls. You can also use them directly from a DSH prompt that
can invoke tools.

### `grok_targets`

Lists bots and groups visible to the signed-in account, with stable ids, names, kinds,
titles, descriptions, and group member ids.

| Parameter | Type | Notes |
| --- | --- | --- |
| `kind` | `all` \| `bot` \| `group` | Optional filter, default `all`. |
| `query` | string | Optional case-insensitive id, name, or title filter. |

### `grok_send`

Resolves the target, submits one prompt, and returns a receipt. It does not wait for or
return the reply.

| Parameter | Type | Notes |
| --- | --- | --- |
| `target` | string | Required. Bot or group name or id; use `grok_targets` when ambiguous. |
| `message` | string | Required. Must not be empty. |
| `replyTo` | string | Optional entry id this message replies to. |

`delivery: "accepted"` means the submission was confirmed. The gateway currently does not
return a message id for prompts, so the plugin also checks the latest transcript for the unique
`clientNonce`; a confirmed receipt carries that transcript entry as `messageId`. If neither check
succeeds, `delivery: "unknown"` means the request may have landed without a receipt. The tool never
retries on its own.

### `grok_thread`

Reads the latest bounded tail of a thread.

| Parameter | Type | Notes |
| --- | --- | --- |
| `target` | string | Required. Bot or group name or id. |
| `after` | string | Opaque cursor from a previous call. Returns only newer entries. |
| `limit` | integer | Trailing entries to inspect, 1-200. Defaults to `defaultThreadLimit`. |
| `full` | boolean | Include bounded entry text. Default `false`. |

The response carries `cursor`, `entryCount`, `gapReset`, and `summary`, plus `entries` when
`full` is set. Save `cursor` and pass it back as `after` so the next read returns only what
is new. `entryCount: 0` means nothing new. `gapReset: true` means the cursor expired and the
entries are a fresh bounded snapshot, not a delta. Entry bodies and totals are bounded before
they reach model context.

## Security notes

- The plugin does not expose Grok approval decisions. Approval requests stay in the owning
  Grok Bot UI and must not be auto-approved by an agent.
- Tokens and credential-shaped request values are redacted from gateway errors.
- `grok_thread` and `grok_targets` are registered as concurrency-safe; `grok_send` is not.
- This is an unofficial integration, not affiliated with Cursor or DeepSeek.

## Development

```sh
npm install --include=dev
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The tests cover desktop-session decryption, gateway methods and delivery classification,
transcript cursors, URL policy, redaction, tool registration, the `/grokbot` intent grammar
and its dialog flow, and bundled-skill registration.

## Credits

The Grok Bot desktop-session reader, gateway client, URL policy, and transcript cursor
semantics in `src/grok/` are adapted from
[`grok-bot-cli`](https://github.com/ScriptedAlchemy/grok-bot-cli) by
[ScriptedAlchemy](https://github.com/ScriptedAlchemy), used under the MIT License
(Copyright (c) 2026 ScriptedAlchemy), and rewritten here as a native DSH tool plugin.
See [NOTICE](NOTICE) for the attribution text.

Thanks also to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), whose
plugin, tool, command, and skill seams this plugin is built on.

## License

MIT
