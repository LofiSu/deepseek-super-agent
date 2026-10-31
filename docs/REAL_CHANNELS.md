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

Bot permissions: `im:message`, `im:message.send_as_bot`, and message read
access for the chat. The bot must be a member of `FEISHU_CHAT_ID`.

Inbound paths:

- **Webhook** — `parseFeishuWebhook` handles `url_verification` (return the
  challenge), plaintext v2 callbacks, and AES-256-CBC encrypted envelopes
  (`im.message.receive_v1`).
- **Polling Source** — `FeishuSource` lists `/open-apis/im/v1/messages` since a
  cursor, maps text/post/image messages to `Trigger`s, and dedupes by
  `feishu_<message_id>`. Thread key: `im:feishu:<chat_id>[:<thread_id>]`.

Outbound: `FeishuOutboxAdapter` replies in-thread with
`/open-apis/im/v1/messages/:message_id/reply` when the source message is known,
otherwise sends to the chat with `/open-apis/im/v1/messages`.

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
