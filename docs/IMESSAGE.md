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

## Preflight (no model, no send)

Run this before `serve` or `imessage`:

```bash
ds-agent channels check --imessage
# or, on macOS, the same check under pnpm in this checkout:
pnpm ds-agent channels check --imessage
```

It opens `chat.db` read-only, reports whether the required tables/columns exist,
prints `COUNT(*)` and `MAX(ROWID)` only (never message text), reports the
admission decision (`handle`, allow-any, allow-groups), and checks that
`osascript` is on `PATH`. It exits 0 only when the channel is ready.

The check does **not** run AppleScript, because that can raise the macOS
Automation prompt. It prints the exact manual, read-only command instead:

```bash
osascript -e 'tell application "Messages" to get name'
```

If macOS asks whether your terminal may control Messages, choose Allow. This
command does not send a message. A denied Automation permission only affects
outbound; it is separate from Full Disk Access.

If opening `chat.db` fails with `authorization denied` / `Operation not
permitted`, the preflight says to grant Full Disk Access and names the exact
path: **System Settings → Privacy & Security → Full Disk Access**. Enable the
terminal (or whichever app launches `ds-agent`), then **quit and reopen that
app**; changing the setting does not apply to a running process.

## Safety defaults

Admission is **closed by default**. `ds-agent imessage` and
`ds-agent serve --imessage` refuse to start when neither a sender allowlist
(`--handle` / `DS_AGENT_IMESSAGE_HANDLE` or `DS_AGENT_ACTOR_ALLOWLIST`) nor an
explicit opt-out (`--allow-any`) is set. The error is shown before `chat.db` is
opened (and, for `serve`, before SQLite is opened).

- **Only 1:1 messages are `addressed: 'direct'`.** A message in a group chat is
  never direct, even when group ingestion is enabled; it still has to pass the
  normal admission rules.
- **Group chats are skipped by default.** Group detection reads `chat.style`
  (`43` = group) and `chat.room_name`, never message text. Enable ingestion with
  `--allow-groups` / `DS_AGENT_IMESSAGE_ALLOW_GROUPS=1`. A message joined to
  both a 1:1 and a group chat is a group. A message with no chat row, or with
  chat metadata that is neither a known 1:1 nor a known group, is treated as a
  group/unknown and skipped by default. For group messages, only a positive
  group row's (`chat.style = 43` or a non-empty room name) chat id is exposed
  as `channel.address.group`; ambiguous/unknown groups leave it unset, so
  `DS_AGENT_GROUP_ALLOWLIST` and outbound fail closed instead of reusing a 1:1
  chat id. When a message joins several positive group rows, the first non-empty
  chat guid, the first non-empty identifier, and the first safe positive
  `chat.ROWID` are aggregated independently, so an identifier-only row cannot
  hide a usable guid from a later row.
- **Group and 1:1 conversations use separate thread keys.** Thread-key
  precedence is strict:

  1. a chat guid yields `chat:<chatGuid>`;
  2. otherwise a group with a positive chat identifier yields
     `group:<chatIdentifier>`;
  3. otherwise a group with a positive `chat.ROWID` yields
     `group-rowid:<rowid>`;
  4. any other group (no usable positive group row identity) yields
     `group-unknown:<handle>`.

  A 1:1 message always yields `handle:<handle>` and never uses `chat.ROWID`.
  An ambiguous group can never share a thread, and therefore ticket context,
  with a 1:1 message from the same sender.

  `chatRowId` is selected from a **positive group row only** (`chat.style = 43`
  or a non-empty `room_name`), never from a joined 1:1 or ambiguous chat, and
  only when it is a safe positive integer. `chat.ROWID` is a per-database
  SQLite identity, not a stable global id: it can change across a restore,
  `VACUUM`, or on a different machine. That is why it is used only when neither
  a guid nor an identifier exists, and why `group-rowid:<rowid>` is **never**
  used for outbound routing — outbound stays fail-closed when `chatGuid` is
  missing, exactly as before.

  Continuity note: after upgrading, existing tickets/threads keyed
  `group-unknown:<handle>` will not match the new `group-rowid:<rowid>` key, so
  those conversations start a new thread rather than silently continuing the
  old one.
- **Missing schema fails closed.** If `chat.style` or `chat.room_name` is absent,
  the channel reports a compatibility error instead of treating every row as
  1:1; it does not retry the incompatible query on every poll.
- **`--allow-any` is an explicit opt-out.** It logs a prominent warning at
  startup. Prefer a sender allowlist.
- **`--handle` is trimmed once.** The same trimmed value is used for the startup
  admission decision and the SQL sender filter. Missing, whitespace-only, or
  flag-like values are rejected rather than silently idling.

## Prerequisites (one-time, manual)

1. **A dedicated iMessage identity for the agent.** Use a second Apple ID
   (an email handle can receive iMessage) or a dedicated number. Sign Messages
   into that account on this Mac (Messages allows one iMessage account at a
   time, so use a separate macOS user if you also read your own iMessage here).
2. **Full Disk Access** for the app that runs `node` (Terminal / iTerm / the
   app hosting this process): **System Settings → Privacy & Security → Full
   Disk Access**, enable that app, then quit and reopen it. Without it, opening
   `chat.db` fails with `authorization denied` or `Operation not permitted`.
   The CLI maps that to an explicit Full Disk Access message and does not retry
   the permission denial forever.
3. **Automation** permission for Messages: the first `osascript` send shows a
   prompt ("… wants to control Messages") → Allow. You can check this without
   sending by running the manual command in [Preflight](#preflight-no-model-no-send);
   **System Settings → Privacy & Security → Automation** shows or repairs it.
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

## Running the loop from `serve`

`ds-agent serve --imessage` runs the same inbound poll loop alongside the
watchdog/daemon timer in one process (the loop is shared code, not a second
implementation). Without `--imessage`, `serve` behavior is unchanged and opens
no channel.

```bash
# daemon + inbound iMessage channel in one process
DS_AGENT_IMESSAGE_HANDLE="+8613800000000" pnpm ds-agent serve --imessage

# explicit opt-outs still apply
pnpm ds-agent serve --imessage --allow-any

# include group messages (never marked direct)
pnpm ds-agent serve --imessage --handle "+8613800000000" --allow-groups

# both primary channels over one Runtime/SQLite store
DS_AGENT_IMESSAGE_HANDLE="+8613800000000" \
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx FEISHU_CHAT_ID=oc_xxx \
pnpm ds-agent serve --imessage --feishu
```

`serve --imessage --feishu` resolves and validates both configurations before
`Runtime.create`. If the iMessage allowlist or Feishu credentials/chat are
missing, it fails before opening SQLite, `chat.db`, or the Feishu network and
lists every missing item. Both loops then run over the same Runtime/SQLite
store with independent abort controllers, cursors, and outboxes. A loop failure
is logged and does not kill the other loop or the daemon.

`serve --imessage` accepts the same admission flags and environment variables as
`ds-agent imessage`: `--handle`, `--allow-any`, `--allow-groups`, `--interval`,
`--since`, and `--db` (plus `--once` for a single poll; the daemon keeps
running). Admission is checked before `Runtime.create` opens SQLite and before
`chat.db` is opened, so a missing allowlist fails closed. The cursor is the same
SQLite document, so `imessage` and `serve --imessage` resume from the same
point.

The first SIGINT/SIGTERM aborts polling, drains the loop and Runtime, and exits
0; a second signal force-exits 1 if the drain hangs. Pull errors are logged and
retried with bounded backoff; ingest errors are logged and skipped (the cursor
still advances), so a transient `chat.db`/io failure does not kill the loop or
the daemon. A **permission denial is terminal**, not retried forever: the loop
stops and the log/error names Full Disk Access and the exact System Settings
path. In a combined `serve`, that stops only the iMessage loop; Feishu and the
daemon keep running.

## Limitations (MVP)

- **Text only.** Attachments, reactions, stickers, and audio are ignored.
- **`attributedBody` is decoded best-effort.** `message.text` is often NULL on
  macOS 13+; the decoder takes the longest printable run after the `NSString`
  marker. Rich formatting is dropped; some messages may decode imperfectly.
- **Group chats are closed by default.** `--allow-groups` /
  `DS_AGENT_IMESSAGE_ALLOW_GROUPS=1` opens ingestion, but group triggers are
  never `addressed: 'direct'`; they pass the normal admission filter (keyword,
  noise, semantic). A group reply is sent with `chat id` only when a positive
  group row supplied a `chatGuid`; a group target without a `chatGuid` fails
  closed and is never sent as `buddy <handle>`. 1:1 replies still use
  `buddy <handle>` when no `chatGuid` is present.
- **externalId is synthetic** (`imessage_<ts>_<n>`) — osascript does not return
  the provider message GUID, so outbox rows cannot be re-read for acceptance
  the way GitHub comments are.
- Opening a WAL `chat.db` read-only can require the `-wal`/`-shm` sidecars to be
  readable; Full Disk Access covers this. If a read-only open still fails, grant
  access and retry.

## Safe no-send smoke

This sequence exercises permissions and configuration without sending any
iMessage and without a model:

```bash
# 1. read-only database/schema/admission/osascript report
pnpm ds-agent channels check --imessage

# 2. check the Automation prompt/decision; this command only reads the app name
osascript -e 'tell application "Messages" to get name'

# 3. inspect the exact serve command without starting it
pnpm ds-agent --help
```

There is no fake send path. The first real reply is the first actual send; use
a dedicated Apple ID and keep the default-deny admission while testing.
