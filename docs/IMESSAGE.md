# iMessage channel

Talk to `ds-agent` from iMessage, like texting an assistant. This is a **real
channel** (same pattern as Feishu/GitHub): inbound is read from the macOS
Messages database, outbound is sent through the Messages app. There is no fake
or mock path.

## How it works

```
iMessage (dedicated Apple ID / number)
   │  human texts the agent's handle
   ▼
ChatDbImessageApi.pull()  ── read ~/Library/Messages/chat.db (read-only)
   │  message ROWID cursor; is_from_me = 0 only
   ▼
ImessageSource  ──► imessageTrigger()  ──► Runtime.ingest()
   ▼
ds-agent Engine → Harness (Router/Worker) → reply enqueued to Outbox
   ▼
ImessageOutboxAdapter.send()  ── osascript → Messages.app → same conversation
```

- `is_from_me = 0` only, so the agent never re-ingests its own replies.
- The cursor lives in SQLite (`documents(kind='imessage_cursor', id='cursor')`).
- Message text reaches AppleScript through the environment
  (`DS_AGENT_IMSG_TEXT`), never by string interpolation, so quotes/`$`/newlines
  cannot inject AppleScript.

## Prerequisites (one-time, manual)

1. **A dedicated iMessage identity for the agent.** Use a second Apple ID
   (an email handle can receive iMessage) or a dedicated number. Sign Messages
   into that account on this Mac (Messages allows one iMessage account at a
   time, so use a separate macOS user if you also read your own iMessage here).
2. **Full Disk Access** for the app that runs `node` (Terminal / iTerm / the
   app hosting this process): System Settings → Privacy & Security → Full Disk
   Access. Without it, opening `chat.db` fails with `Operation not permitted`.
3. **Automation** permission for Messages: the first `osascript` send shows a
   prompt ("… wants to control Messages") → Allow.
4. **A live model**: set `DS_AGENT_API_BASE` + `DS_AGENT_API_KEY` (+ optional
   `DS_AGENT_API_MODEL`), or one provider key. MockModel is refused.

## Environment variables

| Variable | Meaning |
|----------|---------|
| `DS_AGENT_IMESSAGE_DB` | chat.db path. Default `~/Library/Messages/chat.db`. |
| `DS_AGENT_IMESSAGE_HANDLE` | Only ingest messages from this sender (safety allowlist). Strongly recommended = your own number/email. |
| `DS_AGENT_IMESSAGE_INTERVAL_MS` | Poll interval, default `2000`. |
| `DS_AGENT_IMESSAGE_SINCE` | Start cursor (message ROWID) for replay. |

## Usage

```bash
# one poll then exit (smoke test; still needs the permissions + model)
pnpm ds-agent imessage --once --handle "+8613800000000"

# continuous two-way channel
DS_AGENT_IMESSAGE_HANDLE="+8613800000000" pnpm ds-agent imessage
```

Flags: `--once`, `--interval <ms>`, `--handle <handle>`, `--since <rowid>`,
`--db <path>`.

On first run the cursor starts at the current max ROWID, so only new messages
are handled. Pass `--since <rowid>` to replay from an explicit point.

## Limitations (MVP)

- **Text only.** Attachments, reactions, stickers, and audio are ignored.
- **`attributedBody` is decoded best-effort.** `message.text` is often NULL on
  macOS 13+; the decoder takes the longest printable run after the `NSString`
  marker. Rich formatting is dropped; some messages may decode imperfectly.
- **Group chats** are not a first-class flow; sending uses `chat id` when a
  `chatGuid` target exists, otherwise `buddy <handle>`.
- **externalId is synthetic** (`imessage_<ts>_<n>`) — osascript does not return
  the provider message GUID, so outbox rows cannot be re-read for acceptance
  the way GitHub comments are.
- Opening a WAL `chat.db` read-only can require the `-wal`/`-shm` sidecars to be
  readable; Full Disk Access covers this. If a read-only open still fails, grant
  access and retry.
