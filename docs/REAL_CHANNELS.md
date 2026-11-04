# Real channels: Feishu IM + GitHub

`pnpm demo` must not use a fake IM or fake GitHub event pump. This document
describes the production adapters, the environment they need, and how the three
Session C demos prove the real round trip.

## Architecture

```
real Feishu event / message-list API ─┐
real GitHub issue + comments API ─────┴─► Source adapter ─► Trigger
                                                              │
                                                              ▼
                                           Engine ─► Router/Worker (live model)
                                                              │
                                                              ▼
                                              Replies writes a durable Outbox row
                                                              │
                                                              ▼
                             Feishu message API / GitHub issue-comment API
                                                              │
                                                              ▼
                                          provider message/comment id recorded
```

- `src/channels/feishu.ts` — `FeishuClient`, `FeishuSource`,
  `parseFeishuWebhook`, `decryptFeishuPayload`, `FeishuOutboxAdapter`.
- `src/channels/github-source.ts` — `GhCliApi`, `GithubIssueSource`,
  `GithubOutboxAdapter`, trigger mappers.
- `src/channels/outbox-adapter.ts` — `Outbox`. `Replies` only enqueues; the
  dispatcher calls the real API and records `externalId`. A failed send stays
  visible as `failed` with the provider error.
- `src/core/replies.ts` — writes the reply row and the outbox row in the same
  Engine transaction. No reply is marked `sent` before the channel API accepts it.

`MockModel` and the in-memory `imTrigger()` / `githubTrigger()` helpers still
exist for unit tests, but they are not used by `pnpm demo` or by the acceptance
checks.

## GitHub Source + Outbox

The GitHub adapter uses the authenticated `gh` CLI:

```bash
gh auth login
gh auth status          # needs repo scope
export DS_AGENT_GH_REPO=LofiSu/deepseek-super-agent   # default
pnpm demo
```

Inbound trigger text comes from the GitHub REST API response: the issue
`title`+`body` for the opening trigger, and each comment `body` for follow-ups.
The trigger id is derived from the provider ids (`gh_issue_<id>_body`,
`gh_comment_<id>`), so repeated polls are idempotent. The thread key is
`github:issue:<n>`.

Outbound replies are posted with `POST /repos/{owner}/{repo}/issues/{n}/comments`.
The returned comment id is stored in the outbox and the demos re-read the
comment with `GET /repos/{owner}/{repo}/issues/comments/{id}` as the acceptance
proof.

`DS_AGENT_GH_KEEP=1` keeps demo issues open. By default they are closed after
the scenario; comments and logs remain available.

## Feishu IM Source + Outbox

Set these for a live Feishu/Lark channel:

| Variable | Required | Meaning |
|----------|----------|---------|
| `FEISHU_APP_ID` | yes | Feishu app id |
| `FEISHU_APP_SECRET` | yes | Feishu app secret |
| `FEISHU_CHAT_ID` | for polling/demo | chat the bot has joined (`oc_...`) |
| `FEISHU_BASE_URL` | no | `https://open.feishu.cn` (default) or `https://open.larksuite.com` |
| `FEISHU_VERIFICATION_TOKEN` | no | event-callback token check |
| `FEISHU_ENCRYPT_KEY` | no | decrypt encrypted event envelopes |
| `FEISHU_BOT_OPEN_ID` | no | detect mentions of the bot (`ou_...`) |

Bot permissions: `im:message`, `im:message:send_as_bot`, `im:message:readonly`,
and for group chats the sensitive scope `im:message.group_msg` (list/poll
messages in groups the bot belongs to). Also useful for setup:
`im:chat:readonly` to list chats, and `im:chat:create` only for demo creation.
The bot must be a member of `FEISHU_CHAT_ID`. Publish a new app version after
adding scopes.

One-time setup:

1. Create a custom app in the Feishu Open Platform (or Lark Developer) console.
2. Enable the **Bot** capability.
3. Add the scopes above under Permissions & Scopes, then publish a version and
   wait for approval.
4. Add the bot to the target chat. For a group, add it as a group bot; for a
   one-to-one chat, open the bot conversation.
5. Copy the chat id (`oc_...`) from the chat's settings/API response and set
   `FEISHU_CHAT_ID` or pass `--chat oc_...`.
6. Set `FEISHU_APP_ID` and `FEISHU_APP_SECRET` from the app's Credentials page.
   `FEISHU_BASE_URL` is optional; use `https://open.larksuite.com` for Lark.

`ds-agent channels check --feishu` reports only presence and pairing, never the
secret. Add `--network` for one real `tenant_access_token` call (still no
message); exit 0 means the app credentials authenticate and the chat id is
configured. Chat membership and scope errors surface on the first poll.

Inbound paths:

- **Library parser, not a running listener** — `parseFeishuWebhook` can parse
  `url_verification` (return the challenge), plaintext v2 callbacks, and
  AES-256-CBC encrypted envelopes (`im.message.receive_v1`). Inbound webhooks
  are **not implemented** for the CLI: `serve` does not expose a webhook server,
  and it does not open Feishu's long-connection/WebSocket transport either.
- **Polling Source (the implemented CLI path)** — `FeishuSource` lists
  `/open-apis/im/v1/messages` since a cursor, maps text/post/image messages to
  `Trigger`s, and dedupes by `feishu_<message_id>`. Thread key:
  `im:feishu:<chat_id>[:<thread_id>]`. `serve --feishu` covers **exactly one
  chat per process**.

Outbound: `FeishuOutboxAdapter` replies in-thread with
`/open-apis/im/v1/messages/:message_id/reply` when the source message is known,
otherwise sends to the chat with `/open-apis/im/v1/messages`.

### Inbound poll loop from `serve --feishu`

`ds-agent serve --feishu` runs an inbound Feishu poll loop alongside the daemon
timer. The loop lives in `src/cli/feishu.ts` and mirrors `src/cli/channel-loop.ts`
(the shared iMessage loop): pull, ingest, persist the cursor, await
`jobsSettled()`, flush the durable outbox, then sleep abortably between polls.

Requirements, validated before `Runtime.create` and before any network call:

| Input | Meaning |
|-------|---------|
| `FEISHU_APP_ID` + `FEISHU_APP_SECRET` | Required together by `feishuConfigFromEnv`; missing/half-set refuses to start |
| `--chat <oc_...>` or `FEISHU_CHAT_ID` | Required poll target; `--chat` wins |
| `--interval <ms>` or `FEISHU_INTERVAL_MS` | Poll interval, clamped to at least 1000ms (default 2000ms) |
| `--since <epoch-ms>` or `FEISHU_SINCE` | Optional one-run seed, in milliseconds matching Feishu `create_time` |
| `--once` | One poll then return (smoke/testing) |

A missing credential or chat id throws before SQLite is opened, so the daemon
state directory is not created. `--imessage` and `--feishu` may be combined:
`serve` resolves and validates **both** configurations before `Runtime.create`,
uses one Runtime/SQLite store, and gives each loop its own AbortController,
cursor, and Outbox. If either configuration is absent or invalid, the process
exits before opening SQLite, `chat.db`, or the Feishu network and lists every
missing item. Default `serve` (no flag) is unchanged. A loop failure is logged
and does not kill the other loop or the daemon.

### No-send preflight

Run the preflight before a live serve. It needs no model and opens no SQLite:

```bash
ds-agent channels check                  # iMessage + Feishu, offline
ds-agent channels check --imessage       # one channel
ds-agent channels check --feishu
ds-agent channels check --feishu --network  # real tenant_access_token, no message
```

- iMessage: opens `chat.db` read-only, checks the required schema, prints
  `COUNT(*)` and `MAX(ROWID)` only (never text), reports admission and whether
  `osascript` exists. It prints the manual Automation command but does not run
  it, so it cannot prompt or send.
- Feishu: reports paired credentials, chat presence, base URL, and scopes with
  values hidden. `--network` performs one real `tenant_access_token` call and
  reports success/failure without printing the token or secret. The default is
  fully offline.
- Exit 0 only when every selected channel is ready; otherwise every actionable
  reason is printed and the exit code is 1.

**Cursor semantics.** The loop stores one document, `feishu_cursor/cursor`, as
`{ chatId, lastCreateTimeMs }`, where `lastCreateTimeMs` is the highest message
`create_time` observed by `FeishuSource`. Seed precedence is: explicit
`--since`/`FEISHU_SINCE` (positive finite ms) > stored cursor for this chat >
`FeishuSource` default `now - 5 minutes`. The cursor is written only after a
successful pull and ingest, and only when it advances. On restart the stored
value is passed back to `FeishuSource`, so the previous window is not replayed.
`FeishuSource` queries one second before the cursor to catch messages sharing a
boundary second; any overlap is deduped by Trigger id (`feishu_<message_id>`) in
`Runtime.ingest`, so a message already processed is never processed twice. A
stored cursor whose `chatId` differs from the current chat is ignored.

**Admission semantics.** The loop calls `runtime.ingest(trigger)` with the
Trigger returned by `feishuTriggerFromMessage`; it does not mark anything
`direct` and does not bypass the ingress filter. That mapper sets
`channel.address.group = message.chat_id`, so `DS_AGENT_GROUP_ALLOWLIST=<chat id>`
admits or denies the chat in `src/ingress/filter.ts`. It sets
`addressed='mention'` only when the text or mentions actually name the bot;
otherwise `addressed` is unset and normal keyword/observed admission applies.
`trigger.meta` carries provider ids for outbox routing only and is never read by
admission. A denied message is persisted as a filtered disposition and cannot
become a Ticket.

**Shutdown.** The first SIGINT/SIGTERM aborts every inbound poll loop, waits for
both in-flight polls and their drains (jobs, outbox flush), closes the iMessage
API, and only then runs `Runtime.finish()` to stop the daemon and close SQLite.
The loops never close the Runtime or the clients; `serve` owns them. A failed
pull is logged and retried with bounded exponential backoff (cap 30s);
stream/ingest errors are logged and skipped like the iMessage loop. A TCC/Full
Disk Access denial is terminal for the iMessage loop (not retried forever), names
the exact System Settings path, and leaves a combined Feishu loop and the daemon
running.

**Safe no-send smoke.** Check permissions and configuration without a model or
message:

```bash
ds-agent channels check
ds-agent channels check --feishu --network   # token only; does not send
osascript -e 'tell application "Messages" to get name'  # manual Automation check
```

`serve` is not a send test: the first Router reply is the first real outbound
message. Use a dedicated Apple ID / bot and keep default-deny admission while
testing.

**No live run was performed** for this loop: the tests use a fake source and a
`FeishuClient` whose fetch throws, so CI never calls Feishu. Live verification is
the same as the adapter check above (`pnpm demo:feishu`) once credentials exist.

Verify the wiring when credentials exist:

```bash
pnpm demo:feishu
```

It sends a bot message, polls it back through `FeishuSource`, sends a reply
through the outbox adapter, and polls the reply back. Output is written to
`/tmp/ds-agent-live-e2e-logs/demos/04-feishu-smoke.log`.

### Feishu status in this environment

The Session C machine had **no** `FEISHU_APP_ID` / `FEISHU_APP_SECRET`.
The Feishu adapter, webhook parser, encryption, Source, and Outbox are
implemented and unit-tested; the three acceptance demos ran against the real
GitHub channel instead. Once the env vars above are set, `pnpm demo:feishu`
runs the same production code path.

A bot cannot impersonate a human sender, so a fully human-driven Feishu dialog
needs a real person (or a user-token app) posting into `FEISHU_CHAT_ID`; the
polling Source will ingest those messages. The GitHub issue thread is the
human-driven acceptance channel used by `pnpm demo` here.

## Three acceptance scenarios

| Scenario | Input | Proof |
|----------|-------|-------|
| `01-parallel-github` | 3 real issues | 3 tickets, 3 distinct WorkerSessions, same-burst start, `parallel workers=3`, live assistant turns, real comment per issue re-read from the API |
| `02-spill-github` | 1 real issue + 2 real comments | 1 ticket, `bypass=subscription` twice, 2 spill bodies equal to the API payloads, page-wise `read_object` reassembly, live worker read the known-good commit, real comment |
| `03-watchdog-github` | 1 real issue with a blocking reproduction | `[watchdog] nudge` then `[watchdog] fail`, `ticket.ended.by=watchdog`, durable `watchdog.nudge`/`watchdog.fail` events, real acknowledgement comment |

Run:

```bash
pnpm demo
pnpm demo -- --only parallel,spill
DS_AGENT_GH_KEEP=1 pnpm demo
```

Logs and JSON proofs: `/tmp/ds-agent-live-e2e-logs/demos/<scenario>.{log,json}`.
The aggregate run summary is `run-<timestamp>.json` in the same directory.

## Offline CI

The GitHub Actions `demo` job runs `pnpm demo:local`, the in-memory fixture
baseline, because CI does not have the operator's `gh` login and should not
create issues. This is a smoke check, not the real-channel acceptance path.
`pnpm demo` and `pnpm test:demo:real` are the real-channel paths.
