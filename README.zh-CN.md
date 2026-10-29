# dsh-plugin-grok-bot

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里直接和
[Grok Bot](https://cursor.com/help/grok-bot/plans) 对话：列出你的机器人，把任务派给其中一个，
之后回到会话里读它的回复，全程不离开终端。

[English](README.md) · 简体中文

## 这个项目是做什么的

Grok Bot 是一个远程智能体，它运行在自己的云工作站上，看不到你的笔记本、你打开的编辑器，
也连不上你本机的 `localhost`。DeepSeek Harness（下称 DSH）是你干活的地方。这个插件把两头接上：

- 三个原生 DSH 工具，让模型能列出机器人、发一条消息、读取线程；
- `/grokbot` 命令，在输入框里直接完成同样的操作，不消耗模型回合；
- 一个随插件附带的 `grokbot` 技能，让「问问 web bot 导航问题修好没」这类自然语言请求落到正确的工具上。

Grok Bot 的回复是异步的：发一次，继续干别的，过一会儿再读线程。

## 环境要求

- 一个能加载插件并提供 `tools` 服务的 DSH 版本（dsh-TUI 是主要目标宿主）。
- Node `^22.19` 或 `>=24`。
- 已安装并登录 Grok Bot 桌面端，且与 DSH 以同一个操作系统用户运行。这是默认的凭据来源；
  无头环境可以改用网关凭据，见[身份认证](#身份认证)。

支持 macOS、Linux、Windows。

## 安装

从 Git 安装，不需要 npm 发布版：

```sh
dsh plugin --profile dsh-tui add github:quafulz/dsh-plugin-grok-bot
```

从 npm 安装：

```sh
dsh plugin --profile dsh-tui add dsh-plugin-grok-bot
```

从本地克隆安装，适合边改边试：

```sh
git clone https://github.com/quafulz/dsh-plugin-grok-bot.git
cd dsh-plugin-grok-bot
npm install --include=dev && npm run build

dsh plugin --profile dsh-tui add /absolute/path/to/dsh-plugin-grok-bot
```

需要固定版本就写 `dsh-plugin-grok-bot@0.1.0`。卸载用
`dsh plugin --profile dsh-tui remove dsh-plugin-grok-bot`。

手动往配置里加一行，效果相同：

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

## 快速上手

1. 按上面的方式装好插件，重启 DSH。
2. 在 Grok Bot 桌面端登录一次，插件会复用这个会话。
3. 在 DSH 里输入 `/grokbot`。

```
> /grokbot
2 Grok Bot targets
- [bot] web-worker (wrk_01H8…) — Frontend worker
- [group] release-crew (grp_01H9…) — Ship coordination

Usage: /grokbot <message> · /grokbot send <bot> <message> · /grokbot read <bot> [limit] · /grokbot list [query]
```

发一条，再读回复：

```
> /grokbot send web-worker fix the mobile nav regression on branch grok/GROK-123
Sent to web-worker (message msg_01H…). Read the reply with /grokbot read web-worker.

> /grokbot read web-worker
web-worker: 2 entries
user: fix the mobile nav regression on branch grok/GROK-123
assistant: On it. I'll push the branch and reply with STATUS: done.
```

## `/grokbot` 命令

语法故意做得很宽松。你可以写完整一行，也可以只写够用的部分，剩下的由命令弹窗来问。

| 输入 | 行为 |
| --- | --- |
| `/grokbot` | 列出所有可见的机器人和群组，并附上用法提示。 |
| `/grokbot list [关键词]` | 列出名单，可按名称、标题或 id 过滤。 |
| `/grokbot <消息>` | 把文本当作消息。用你上次的机器人，没有则询问发给谁。 |
| `/grokbot send <消息>` | 同上，`send` 只是可选的形状词。 |
| `/grokbot send <机器人>` | 解析出机器人，再询问要发什么。 |
| `/grokbot send <机器人> <消息>` | 直接发送。多词名称可加引号：`send "Chief of Staff" <消息>`。 |
| `/grokbot send -- <文本>` | 原样发送文本，跳过目标匹配。 |
| `/grokbot read [机器人] [条数]` | 读取线程尾部。省略机器人时沿用上一次的目标，条数范围 1-200。 |

缺的参数通过宿主自带的弹窗来补，你从列表里选，不用记格式。没有这层能力的环境（比如官方
DSH 前端或无头嵌入器）仍然支持写全的整行命令，遇到信息不全的输入会回一句用法提示。

目标按名称、标题、id 的长前缀匹配当前名单，所以 `release crew` 这样的多词名字不加引号也能写。
引号会把目标定为精确名称：`send "Chief of Staff" <消息>` 不会再把引号里的名字并进消息。引号是
目标专用语法；如果消息本身就以某个机器人名或引号内容开头，用 `--` 形式。

想把命令和弹窗换成中文，把插件配置里的 `locale` 设为 `zh`。

## 把任务交给 Grok Bot

Grok Bot **不是**在 DSH 里启动的 Codex 或 Claude Code 那类本地编码智能体。那些跑在本机工作区上。
Grok Bot 有自己的一台云电脑：没有共享文件系统，看不到你的本地目录，通常也访问不到 DSH 本机的
`localhost`。

把它当成一位机器在别处的同事：写一份自包含的任务说明，用 Git 作为共享工作区，结果自己验收。

流程如下：

1. 推一个 `grok/<task-id>` 分支，附一个简短的任务文件：base SHA、范围、设计参考、验收命令、约束。
2. 用 `grok_targets` 确认机器人，然后调一次 `grok_thread` 并保存返回的 `cursor`。
3. 调一次 `grok_send`，把任务 id、仓库、分支、base SHA、任务文件路径都写进消息，并要求固定格式的
   回复。不要在工具调用里等结果。
4. 继续做别的事。用 `after: "<cursor>"` 和 `full: true` 轮询 `grok_thread`。
5. 把返回的分支取到独立 worktree，跑构建和测试，看截图或预览地址。
6. 评审意见发到同一分支并提交。合并和部署只在 DSH 或 CI 里做。

一份可直接用的任务说明：

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

调研和网页任务用的是同一套流程，只是验收项不同。

几条基本规则：

- 一个任务一个分支，只有一个主写手。
- `delivery: "accepted"` 只代表已提交，不代表已完成。`delivery: "unknown"` 表示请求可能已经送达，
  重发之前先读线程。
- Grok 的浏览器和终端跑在它那台机器上，DSH 本机的 `localhost` 地址一般连不上，改用预览部署或截图。
- 不要发密钥。审批卡片留在 Grok 界面里，这个插件不会替你点。

## 或者直接问模型

随插件附带的技能会告诉模型什么时候、怎么调用这些工具。像「问问 web bot 导航修复合进去了吗」
这样的请求，会先解析目标，用 `grok_send` 发出，再用 `grok_thread` 读回。如果目标或内容不清楚，
模型会用 `ask_user_question` 问你，而不是自己猜。

## 身份认证

默认路径复用 Grok Bot 桌面端已登录的会话。装好 Grok Bot、登录一次，并让 DSH 以同一个操作系统
用户运行，能访问应用的数据目录和钥匙串。

插件读取当前安装版本暴露的凭据：

- `gateway-descriptor.json`：已保存的网关路由凭据。支持旧的版本 1 和版本 2，也支持带分账号条目的版本 3。
- `sand-secrets.json`：当前账号的加密访问令牌。还没写入网关描述文件时，插件解密该令牌并调用
  `EnsureSandBox` 换取网关会话。
- `desktop-status.json`：正在运行的应用版本，随 `EnsureSandBox` 一起发送，避免 Cursor 以客户端版本
  不受支持为由拒绝请求。

这些文件位于：

- macOS：`~/Library/Application Support/Grok Bot/`
- Linux：`~/.config/Grok Bot/` 或 `$XDG_CONFIG_HOME/Grok Bot/`
- Windows：`%APPDATA%\Grok Bot\`

换到的网关会话会缓存在进程内。如果网关返回 `401`、`403` 或 `417`（会话过期），目标列表和线程
读取会丢弃缓存客户端并用新会话重试一次。发送操作不会自动重试。

无头或远程部署可以显式提供网关：

```sh
export GROK_BOT_GATEWAY_URL='https://...'
export GROK_BOT_GATEWAY_TOKEN='...'
```

也可以提供 `CURSOR_ACCESS_TOKEN`，让插件去调 `EnsureSandBox`。Cursor 控制台的 API key 不行。
如果读不到应用版本，把 `SAND_CLIENT_VERSION` 设成已安装的 Grok Bot 版本号。

凭据 URL 在使用前会做校验：网关凭据只允许发往 Cursor 网关域名，`EnsureSandBox` 的后端地址只允许
Cursor API 域名。回环地址网关需要设置 `GROK_BOT_ALLOW_LOCAL_GATEWAY=1`。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `appSession` | `true` | 未显式设置网关环境变量时，读取已登录的 Grok Bot 桌面端凭据。 |
| `requestTimeoutMs` | `30000` | 单次网关 HTTP 请求的超时时间。 |
| `maxResponseBytes` | `2097152` | 网关响应的最大缓冲字节数。 |
| `defaultThreadLimit` | `40` | `grok_thread` 和 `/grokbot read` 默认读取的末尾条数（1-200）。 |
| `locale` | `en` | `/grokbot` 及其弹窗的文案语言（`en` 或 `zh`）。 |

## 工具参考

这些工具是给模型调用的，你也可以在能调用工具的 DSH 会话里直接使用。

### `grok_targets`

列出当前账号可见的机器人和群组，返回稳定的 id、名称、类型、标题、描述和群组成员 id。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `all` \| `bot` \| `group` | 可选过滤，默认 `all`。 |
| `query` | string | 可选的 id、名称或标题过滤，不区分大小写。 |

### `grok_send`

解析目标，提交一条消息，返回投递回执。它不会等待，也不会返回回复内容。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `target` | string | 必填。机器人或群组的名称或 id；名字有歧义时先用 `grok_targets`。 |
| `message` | string | 必填，不能为空。 |
| `replyTo` | string | 可选，本条消息回复的条目 id。 |

`delivery: "accepted"` 表示提交已确认。当前网关发送 prompt 时不返回 message id，所以插件还会
在最新会话中查找本次提交的唯一 `clientNonce`；从会话确认时会把对应条目作为 `messageId` 返回。
两种确认都没有结果时返回 `delivery: "unknown"`，表示请求可能已经送达但没有拿到回执。工具不会
自动重试。

### `grok_thread`

读取线程末尾的一段内容。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `target` | string | 必填。机器人或群组的名称或 id。 |
| `after` | string | 上一次调用返回的不透明游标，只返回更新的条目。 |
| `limit` | integer | 读取的末尾条数，1-200。默认取 `defaultThreadLimit`。 |
| `full` | boolean | 是否包含有长度限制的条目正文。默认 `false`。 |

响应里有 `cursor`、`entryCount`、`gapReset`、`summary`，传了 `full` 时还有 `entries`。
保存 `cursor` 并在下次作为 `after` 传回，就只会拿到新增内容。`entryCount: 0` 表示没有新内容。
`gapReset: true` 表示游标已失效，返回的是一份新的有界快照，而不是增量。条目正文和总量在进入模型
上下文之前都会被截断和限制。

## 安全说明

- 插件不提供 Grok 的审批决策能力。审批请求留在所属的 Grok Bot 界面里，智能体不应替你批准。
- 网关错误里的令牌和类似凭据的请求值会被脱敏。
- `grok_thread` 和 `grok_targets` 注册为并发安全，`grok_send` 不是。
- 这是非官方集成，与 Cursor、DeepSeek 均无隶属关系。

## 开发

```sh
npm install --include=dev
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试覆盖桌面端会话解密、网关方法与投递判定、会话游标、URL 策略、脱敏、工具注册、`/grokbot`
的意图解析与弹窗流程，以及附带技能的注册。

## 致谢

`src/grok/` 下的 Grok Bot 桌面端会话读取、网关客户端、URL 策略和会话游标语义移植自
[`grok-bot-cli`](https://github.com/ScriptedAlchemy/grok-bot-cli)，作者
[ScriptedAlchemy](https://github.com/ScriptedAlchemy)，MIT 许可（Copyright (c) 2026 ScriptedAlchemy），
本项目将其改写为原生 DSH 工具插件。署名文本见 [NOTICE](NOTICE)。

同时感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本插件建立在它的插件、
工具、命令和技能接口之上。

## 许可证

MIT
