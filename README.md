# dsh-plugin-grok-bot

Unofficial native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) tools for
[Grok Bot](https://cursor.com/help/grok-bot/plans).

The plugin exposes a small, focused tool surface:

| Tool | Purpose |
| --- | --- |
| `grok_targets` | List the Grok Bot bots and groups visible to the signed-in account. |
| `grok_send` | Send one asynchronous message to a bot or group and return a delivery receipt. |
| `grok_thread` | Read a bounded thread tail, optionally returning only entries after a cursor. |

It does **not** register a subagent provider, an MCP server, or automatic approval handling.
Grok Bot replies are asynchronous: send once, continue useful work, then read the thread.

## Install

### From Git

No npm release required:

```sh
dsh plugin --profile dsh-tui add github:quafulz/dsh-plugin-grok-bot
```

### From a local clone

Best while developing the plugin. Build once, then point the profile at the directory:

```sh
git clone https://github.com/quafulz/dsh-plugin-grok-bot.git
cd dsh-plugin-grok-bot
npm install --include=dev && npm run build

dsh plugin --profile dsh-tui add /absolute/path/to/dsh-plugin-grok-bot
```

### From npm

```sh
dsh plugin --profile dsh-tui add dsh-plugin-grok-bot
```

Pin a release with `dsh-plugin-grok-bot@0.1.0`. Maintainers publish with `npm publish`.
Remove any route with `dsh plugin --profile dsh-tui remove dsh-plugin-grok-bot`.

Or add the row manually:

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

## Authentication

The default path reuses the Grok Bot desktop app's signed-in session. Install Grok Bot,
sign in once, and make sure the DSH process runs as the same OS user with access to the
app's data directory and keychain.

The plugin reads the credentials exposed by the installed Grok Bot version:

- `gateway-descriptor.json`: saved gateway routing credentials. Legacy versions 1 and 2
  are supported, as are version 3 descriptors with per-account entries.
- `sand-secrets.json`: the active account's encrypted access token. When a gateway
  descriptor has not been written yet, the plugin decrypts this token and calls
  `EnsureSandBox` to mint a gateway session.
- `desktop-status.json`: the running app version, sent to `EnsureSandBox` so Cursor does
  not reject the request as an unsupported client.

These files live under:

- macOS: `~/Library/Application Support/Grok Bot/`
- Linux: `~/.config/Grok Bot/` or `$XDG_CONFIG_HOME/Grok Bot/`
- Windows: `%APPDATA%\Grok Bot\`

For headless or remote deployments, provide an explicit gateway override:

```sh
export GROK_BOT_GATEWAY_URL='https://...'
export GROK_BOT_GATEWAY_TOKEN='...'
```

Alternatively, provide `CURSOR_ACCESS_TOKEN` so the plugin can call `EnsureSandBox`.
A Cursor dashboard API key does not work. If the app version cannot be read, set
`SAND_CLIENT_VERSION` to the installed Grok Bot version.

Credential URLs are checked before use. Gateway credentials are limited to Cursor
gateway hosts; EnsureSandBox backend URLs are limited to Cursor API hosts. Loopback
gateways require `GROK_BOT_ALLOW_LOCAL_GATEWAY=1`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `appSession` | `true` | Read signed-in Grok Bot desktop credentials when no explicit gateway env is set. |
| `requestTimeoutMs` | `30000` | Deadline for one gateway HTTP request. |
| `maxResponseBytes` | `2097152` | Maximum buffered gateway response size. |
| `defaultThreadLimit` | `40` | Default trailing-entry count for `grok_thread` (1-200). |

## Usage

Use the tools directly; the plugin does not expose a subagent or block waiting for replies.

### Treat Grok Bot as a digital employee

Grok Bot is **not** a local coding agent such as Codex or Claude Code launched inside DSH.
Those agents run against the workspace on the current computer. Grok Bot works on its own
cloud workstation: it cannot see or modify files on your local machine, and it normally
cannot reach a service bound to DSH's `localhost`.

Treat it as a real employee and give it a self-contained assignment. Do not ask it to edit
files in the local working tree; there is no shared filesystem. State the goal, repository,
branch, base SHA, scope, design references, constraints, and acceptance checks. Use Git as
the shared workspace and handoff protocol: push a branch and task brief, let the employee
work from them, then fetch its branch, review and test it in DSH, and merge it from DSH or
CI.

The exchange is asynchronous. `grok_send` only delivers the assignment; it does not wait
for the work to finish. Continue other DSH work and read the thread later.

### Recommended workflow

The same loop applies to research, coding, and web page work:

1. Create and push a dedicated branch named `grok/<task-id>`. Add a short task file with the
   base SHA, scope, design references, acceptance commands, and constraints.
2. Call `grok_targets` to resolve the bot, then call `grok_thread` once and keep its `cursor`.
3. Call `grok_send` once with the task ID, repo, branch, base SHA, and task-file path or link.
   Ask for a final reply with `STATUS`, `BRANCH`, `COMMIT`, `TESTS`, `SCREENSHOTS`, and
   `BLOCKERS`. Do not wait in the tool call.
4. Continue other DSH work. Poll with `grok_thread` using the saved `after` cursor and
   `full: true`.
5. Fetch the returned branch into a separate worktree. Run build/tests and inspect
   screenshots or a preview URL. Send review comments against the same branch and commit.
6. Merge and deploy only from DSH or CI.

Keep one task to one branch and one main writer. Grok Bot's browser and terminal run on its
cloud computer, so a DSH-local `localhost` URL is normally unreachable; use a preview
deployment or screenshots. Never send secrets. Grok approval requests stay in the Grok UI;
this plugin does not answer them.

### Example: delegate a web page task

First resolve the bot:

```json
{ "kind": "bot", "query": "web-worker" }
```

Pass those arguments to `grok_targets`. If the name is ambiguous, use the target's `id`
instead of its name. Then read the current thread tail to capture a starting cursor:

```json
{ "target": "web-worker", "limit": 20 }
```

Pass those arguments to `grok_thread` and keep the `cursor` from the response.

Send the assignment once. The `message` should be self-contained because the bot cannot
inspect your DSH session or local files:

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

Pass that text as `message` to `grok_send`, with the same resolved target:

```json
{
  "target": "web-worker",
  "message": "<task brief above>"
}
```

`delivery: "accepted"` means the message was submitted; it does not mean the work is done.
If delivery is `unknown`, read the thread before resending.

Continue other DSH work, then poll with the saved cursor:

```json
{
  "target": "web-worker",
  "after": "<cursor from the previous grok_thread response>",
  "full": true
}
```

Pass these arguments to `grok_thread`. Save the new `cursor` from each response and use it
as `after` on the next call; entries already seen will not be returned again.
`entryCount: 0` means there is nothing new. `gapReset: true` means the cursor expired, so
treat the returned entries as a fresh snapshot. Poll periodically (for example, every
1–5 minutes) or after finishing your current DSH task. Stop when the thread contains a
reply with `STATUS: done`, `STATUS: blocked`, or `STATUS: failed`.

If the bot asks a question, answer with `grok_send` and set `replyTo` to the relevant entry
id from `grok_thread`. When the status is `done`, fetch `BRANCH` and `COMMIT` and continue
with review and tests in DSH.

## Tool behavior

### `grok_targets`

Returns a flat list of bots and groups with stable ids, names, kinds, titles, descriptions,
and group member ids. Optional `kind` and `query` filters are available.

### `grok_send`

Resolves the target, submits one prompt, and returns:

- `delivery: "accepted"` when the gateway returned a message id
- `delivery: "unknown"` when the request may have landed but no receipt was returned

On `unknown`, inspect the thread before resending. The tool never retries a submission
automatically.

### `grok_thread`

Reads the latest bounded tail. Use the returned opaque `cursor` as `after` to get only new
entries. An unknown or expired cursor returns a bounded snapshot with `gapReset: true`.
Pass `full: true` to include entry text; entry bodies and totals are bounded before they
reach model context.

## Security notes

- The plugin does not expose Grok approval decisions. Approval requests remain in the
  owning Grok Bot UI and must not be auto-approved by an agent.
- Tokens and credential-shaped request values are redacted from gateway errors.
- `grok_thread` is registered as concurrency-safe; `grok_send` is not.
- This is an unofficial integration and is not affiliated with Cursor or DeepSeek.

## Development

```sh
npm install --include=dev
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The tests cover desktop-session decryption, gateway methods and delivery classification,
transcript cursors, URL policy, redaction, and tool registration.

## Attribution

The Grok Bot desktop-session reader, gateway client, URL policy, and transcript cursor
semantics are adapted from [`grok-bot-cli`](https://github.com/ScriptedAlchemy/grok-bot-cli)
(MIT). See [NOTICE](NOTICE).

## License

MIT
