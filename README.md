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

```sh
dsh plugin --profile tui add dsh-plugin-grok-bot
```

The package is a standard DSH bundle: its `package.json` points `dsh.bundle.patch` at
`cordis.patch.yml`, which inserts the `tool-grok-bot` row into the profile.

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

The default path reuses the Grok Bot desktop app's encrypted gateway session. Install
Grok Bot, sign in once, and make sure the DSH process runs as the same OS user with access
to the app's data directory and keychain.

The desktop session locations are:

- macOS: `~/Library/Application Support/Grok Bot/gateway-descriptor.json`
- Linux: `~/.config/Grok Bot/gateway-descriptor.json` or `$XDG_CONFIG_HOME/Grok Bot/`
- Windows: `%APPDATA%\Grok Bot\gateway-descriptor.json`

For headless or remote deployments, provide an explicit gateway override:

```sh
export GROK_BOT_GATEWAY_URL='https://...'
export GROK_BOT_GATEWAY_TOKEN='...'
```

Alternatively, provide `CURSOR_ACCESS_TOKEN` so the plugin can call `EnsureSandBox`.
A Cursor dashboard API key does not work.

Credential URLs are checked before use. Gateway credentials are limited to Cursor
gateway hosts; EnsureSandBox backend URLs are limited to Cursor API hosts. Loopback
gateways require `GROK_BOT_ALLOW_LOCAL_GATEWAY=1`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `appSession` | `true` | Read the signed-in Grok Bot desktop app session when no explicit gateway env is set. |
| `requestTimeoutMs` | `30000` | Deadline for one gateway HTTP request. |
| `maxResponseBytes` | `2097152` | Maximum buffered gateway response size. |
| `defaultThreadLimit` | `40` | Default trailing-entry count for `grok_thread` (1-200). |

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
