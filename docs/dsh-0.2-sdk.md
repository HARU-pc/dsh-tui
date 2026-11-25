# DSH 0.2 SDK mode

## Why SDK

DSH 0.2.0-rc.2 changed the old web API. The user selected the SDK process boundary rather than a web API migration. The TUI starts one `dsh --profile sdk` child per invocation; no web service, global package, credential file or runtime configuration is edited by this client. See [ADR-0001](adr/0001-sdk-stdio.md).

## Launch and configuration

```
dsh-tui .
dsh-tui /path/to/project
dsh-tui run 'Explain this project' --cwd /path/to/project
DSH_SDK_COMMAND='dsh --profile sdk' dsh-tui .
```

`DSH_SDK_COMMAND` is a trusted shell command, executed through `/bin/sh -c exec …`; shell quoting is supported. This implementation targets Unix (including Linux/macOS). No HTTP URL is used. `DSH_SDK_PROVIDER` defaults to `deepseek-official`; `DSH_SDK_MODEL` defaults to `deepseek-v4-pro` (listed by the installed DeepSeek adapter). The defaults cannot be left to DSH: `InitializeParams.provider` and `.model` are required fields in `dsh-sdk-protocol` `lib/types/types.d.ts` (only `reasoningEffort`/`maxTokens` are optional), so the client always sends a route. Authentication is owned by DSH; this client never reads credential files. The child process cwd and handshake cwd are the resolved directory argument or `--cwd`, falling back to the launch cwd. The directory must exist; a missing path fails before spawn with `ディレクトリが存在しません: <path>` (not a misleading `/bin/sh` ENOENT).

## Contract mapping

| Previous operation | SDK behavior |
|---|---|
| connect | Spawn child; await `initialize {cwd, provider, model}`. An explicit JSON-RPC rejection on a live child may be retried by the caller (no automatic retry). Initialize has its own initializeTimeoutMs (120 s); its timeout is fatal because server state is unknown. Shut down and create a new client to try again; child exit/protocol failure is final. After `shutdown` starts, `initialize` rejects and no child is spawned |
| session.create | Locally mint UUID without waiting for the handshake; SDK creates agent on first prompt |
| session.prompt | `session/prompt {sessionId, contentBlocks:[{type:"text",text}]}` |
| events.mux session/event | `session.event {sessionId,event}` feeds existing fold/UI |
| running flag | `session.status {sessionId,status:"running"\|"idle"}` |
| session.list/history/resume | Unsupported; no startup browser or replay |
| session.cancel | Unsupported; displays notice without killing child |
| subagent.list | Unsupported; no list reconstruction from partial lifecycle notifications |
| approval/question replies, host commands, preset selection | Unsupported; SDK profile owns runtime policy/tools |
| exit | Request `shutdown`; close stdin; always await child exit (see Shutdown) |
| server→client request (`id`+`method`) | Answered `-32601 Method not found` (unused by 0.2.0-rc.2, matches the reference transport) |
| `subagent.started` / `subagent.finished` | `MuxStream` yields them unfiltered (payload has `parentSessionId`); LiveConversation and `converse` ignore them, and child-session events are filtered by session id |

Stdout from the child carries newline-delimited JSON-RPC 2.0 only. Responses are correlated by unique id; errors preserve the JSON-RPC code. Invalid stdout is fatal. This is stricter than the reference `JsonRpcLineTransport` (which ignores malformed lines) on purpose: the server README states stdout carries only JSON-RPC frames and that stdout purity is deployment-enforced, so a non-JSON line means a corrupted channel (e.g. a stdout logger) and continuing could misattribute frames. Stderr is forwarded as diagnostics, never parsed as protocol. Notifications are filtered by current session id, so child/other session events cannot enter the main transcript. The pure legacy SSE/envelope parsers remain exported for compatibility, but there is no web transport.

## UI and completion

The existing Ink composer, message/tool cards, keyboard handling and event folding remain. `/new` creates a local session identity; switching while running is disabled. `/status`, `/help`, `/exit` remain local. History, session browser/resume, host slash commands, remote permission controls, cancellation and subagent listing are explicitly unavailable. The legacy permission badge is display-only in SDK mode; runtime profile controls actual permissions.

SDK `session.event` publishes durable events, including the assembled `assistant/message`. It has no live `assistant/chunk` notification; text appears on message settlement rather than character-by-character. No polling or silent reconnection occurs. The SDK enqueue receipt `{messageId}` is not a response or per-prompt completion. The one-shot CLI owns a single-flight observation interval, subscribing before send and waiting for both this session's durable `turn/end` and `idle`, in either order (120 s conversation timeout). Idle alone never establishes success, even after running, because the final event owns the error outcome and must be folded. If running is never observed, `turn/end` followed by 500 ms without further events also completes when no idle arrives. If running is observed but turn/end is missing, the conversation times out. See [ADR-0002](adr/0002-sdk-completion-handshake.md). Whole-agent idle cannot establish attribution if other producers inject work. The interactive UI tracks agent status and does not promise per-prompt results.

## Startup (interactive)

The Ink UI renders immediately, before `initialize` completes, with a `⏳ DSH SDK 接続中…` line. Reason: Orca starts `dsh-tui .` and pastes the task as soon as the composer is visible; blocking the render on the handshake (which waits for the whole plugin tree, e.g. MCP discovery) would either hide the composer or drop the paste. Input submitted early is echoed as pending, and `Session.prompt → client.request` awaits the shared handshake promise before writing, so prompts reach the SDK in submission order once it is ready (the server rejects `session/prompt` before `initialize`). If the handshake fails, the entry point unmounts Ink and prints the error once to stderr, then exits 1.

## Shutdown and failures

Normal exit, SIGINT/SIGTERM and fatal child errors enter a shared shutdown path. Shutdown is idempotent; SDK flushes its response, disposes the root runtime and exits. Child exit before requested shutdown (even code 0), malformed protocol, RPC error, startup and request timeout are failures; child exit errors carry `code=…, signal=…`.

Shutdown always waits for the child to exit, even if the `shutdown` RPC errors or times out or the client already failed, then decides: earlier failure > RPC error > nonzero exit. Shutdown RPC and exit waiting share one `timeoutMs` (30 s) deadline. A child still alive at that deadline is sent SIGTERM, then SIGKILL after `killGraceMs` (5 s), with at most one further grace period to observe exit, and shutdown reports the forced termination as failure, so no child outlives the client. No child is killed to implement cancellation. In `run`, an error from the conversation is printed and wins; a distinct shutdown failure is additionally printed as `shutdown failed: …`. SIGINT/SIGTERM during `run` shut down the child, suppress the resulting "SDK closed before conversation completed" and exit 130/143. In the interactive UI only the call that starts exiting may report a fatal error, so a pending handshake rejected by a normal `/exit` or Ctrl+C is not reported and the exit code stays 0; a signal during startup prevents rendering and the handshake.

## `run` output

Text mode prints the last assistant text, or `(无回复)` only when there is none (an empty assistant text prints an empty line), and the tool-call count on stderr when nonzero — unchanged from the pre-SDK CLI.

### `--json`

Same schema as the pre-SDK web client, printed with 2-space indentation:

| Field | Type | SDK value |
|---|---|---|
| `sessionId` | string | locally minted session id |
| `agentPreset` | string \| null | always `null` (SDK profile owns the agent; no presets) |
| `reply` | string | last assistant text, `""` if none |
| `turn` | number \| null | folded turn number |
| `toolCalls` | number | tool calls folded from events |
| `usage` | `{input, output}` | sum of `assistant/message` usage tokens; `0` when events carry none |
| `turnEnd` | string \| null | `turn/end` reason kind (e.g. `completed`) or `null` |

## Primary evidence

Read locally on 2026-11-25 using filesystem reads, installed versions `0.2.0-rc.2`:

- `@deepseek-ai/dsh-sdk-protocol/README.md`, `lib/types/types.d.ts`, `lib/types/transport.d.ts`: exact request/notification contracts.
- `@deepseek-ai/dsh-sdk-jsonrpc-server/README.md`, `lib/index.js`, `lib/types/server.d.ts`: readiness, lazy sessions, event forwarding, shutdown disposal, explicit absence of history/list/cancel.
- `@deepseek-ai/dsh-session/lib/types/types.d.ts`: durable event envelope and assembled assistant messages.

These installed artifacts are the source of truth for this port, not an assertion about future SDK versions. Fake-server tests (`test/client.test.js`, `test/sdk.test.js`, `test/fixtures/sdk-server.mjs`) cover transport, cwd, response completion, lifecycle, forced shutdown, server requests, early interactive input (PTY) and explicit limitations; no network is used by these tests. Real DSH verification is limited to the single user-authorized prompt.

## Verification record (2026-11-25)

The single authorized real smoke was `node bin/tui.js run 'OK とだけ返答して' --cwd .`: output `OK`, exit 0 including shutdown. It was not retried. No credential files were read.

## 0.3.0 breaking changes and migration

This SDK port bumps package.json from 0.2.19 to 0.3.0 and aligns the previously stale lockfile root version (0.2.15) to 0.3.0. Use `new DshClient({ cwd })`; the former `new DshClient(url)` throws `sdk-legacy-baseurl` before spawn. DSH_URL and HTTP connections are removed. MuxStream now takes the SDK client. Session list/history/resume, respond, preset selection, cancellation and host commands reject or display an explicit unsupported notice; `Session.create` rejects unsupported overrides. CLI --session/--resume/--preset and unknown options exit 1; non-TTY callers must use `run`. See the contract table for supported replacements. SDK LiveConversation.open calls share the pending handshake and never report connection before it completes; queued MuxStream notifications are delivered before a subsequent failure is thrown.
