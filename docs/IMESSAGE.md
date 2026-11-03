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

## Safety defaults

Admission is **closed by default**. `ds-agent imessage` refuses to start when
neither a sender allowlist (`--handle` / `DS_AGENT_IMESSAGE_HANDLE` or
`DS_AGENT_ACTOR_ALLOWLIST`) nor an explicit opt-out (`--allow-any`) is set.
The error is shown before `chat.db` is opened.

- **Only 1:1 messages are `addressed: 'direct'`.** A message in a group chat is
  never direct, even when group ingestion is enabled; it still has to pass the
  normal admission rules.
- **Group chats are skipped by default.** Group detection reads `chat.style`
  (`43` = group) and `chat.room_name`, never message text. Enable ingestion with
  `--allow-groups` / `DS_AGENT_IMESSAGE_ALLOW_GROUPS=1`.
- **`--allow-any` is an explicit opt-out.** It logs a prominent warning at
  startup. Prefer a sender allowlist.

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
| `DS_AGENT_IMESSAGE_HANDLE` | Sender allowlist (same as `--handle`). Required unless `DS_AGENT_ACTOR_ALLOWLIST` is non-empty or `DS_AGENT_IMESSAGE_ALLOW_ANY=1`. |
| `DS_AGENT_ACTOR_ALLOWLIST` | Comma-separated sender ids. A non-empty list satisfies the startup allowlist and is enforced by runtime admission. |
| `DS_AGENT_IMESSAGE_ALLOW_ANY` | `1` = intentionally accept messages from any sender. Logs a prominent warning. |
| `DS_AGENT_IMESSAGE_ALLOW_GROUPS` | `1` = ingest group-chat messages. Closed by default; group messages are never marked direct. |
| `DS_AGENT_IMESSAGE_INTERVAL_MS` | Poll interval, default `2000`. |
| `DS_AGENT_IMESSAGE_SINCE` | Start cursor (message ROWID) for replay. |

## Usage

```bash
# one poll then exit (smoke test; still needs the permissions + model)
pnpm ds-agent imessage --once --handle "+8613800000000"

# continuous two-way channel
DS_AGENT_IMESSAGE_HANDLE="+8613800000000" pnpm ds-agent imessage

# accept any 1:1 sender (explicit opt-out; logs a warning)
pnpm ds-agent imessage --allow-any

# include group messages (they are not marked direct)
pnpm ds-agent imessage --handle "+8613800000000" --allow-groups
```

Flags: `--once`, `--interval <ms>`, `--handle <handle>`, `--allow-any`,
`--allow-groups`, `--since <rowid>`, `--db <path>`.

Without `--handle` (or `DS_AGENT_IMESSAGE_HANDLE`) and a non-empty
`DS_AGENT_ACTOR_ALLOWLIST`, the command refuses to start with an error that
names the safe example `--handle "+..."`. Opt into open use with `--allow-any`
/ `DS_AGENT_IMESSAGE_ALLOW_ANY=1` only when that is intentional.

On first run the cursor starts at the current max ROWID, so only new messages
are handled. Pass `--since <rowid>` to replay from an explicit point.

## Limitations (MVP)

- **Text only.** Attachments, reactions, stickers, and audio are ignored.
- **`attributedBody` is decoded best-effort.** `message.text` is often NULL on
  macOS 13+; the decoder takes the longest printable run after the `NSString`
  marker. Rich formatting is dropped; some messages may decode imperfectly.
- **Group chats are closed by default.** `--allow-groups` /
  `DS_AGENT_IMESSAGE_ALLOW_GROUPS=1` opens ingestion, but group triggers are
  never `addressed: 'direct'`; they pass the normal admission filter (keyword,
  noise, semantic). Sending uses `chat id` when a `chatGuid` target exists,
  otherwise `buddy <handle>`.
- **externalId is synthetic** (`imessage_<ts>_<n>`) — osascript does not return
  the provider message GUID, so outbox rows cannot be re-read for acceptance
  the way GitHub comments are.
- Opening a WAL `chat.db` read-only can require the `-wal`/`-shm` sidecars to be
  readable; Full Disk Access covers this. If a read-only open still fails, grant
  access and retry.
