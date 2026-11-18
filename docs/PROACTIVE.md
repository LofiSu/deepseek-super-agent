# Proactive idle self-wake

A built-in, owner-gated idle check. Once enabled, the daemon may look at open
work on its normal pulse and, only when there is a concrete useful fact, send
one short follow-up in an existing private thread. It is not a second agent
loop, not a scheduler, and not a notification service.

The feature is **off by default**. A missing or blank `proactive.json` means
disabled. Without an explicit `"enabled": true`, the scheduler evaluates
nothing and sends nothing.

## Configuration

`proactive.json` in the agent home (`$DS_AGENT_HOME`, default `~/.ds-agent`).
It is read once at `Runtime.create`; restart `serve` after editing it.

```json
{
  "enabled": true,
  "intervalMinutes": 30,
  "timezone": "Asia/Shanghai",
  "quietStart": "23:00",
  "quietEnd": "08:00",
  "minIntervalMinutes": 180,
  "maxPerDay": 2,
  "activeThreadCooldownMinutes": 30,
  "thread": "chat_42",
  "chatId": "oc_xxx"
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Must be a boolean. |
| `intervalMinutes` | `30` | Evaluation cadence, 5–1440 minutes. This is not a send cadence. |
| `timezone` | `Asia/Shanghai` | Quiet hours and the daily cap use this zone. This batch supports `Asia/Shanghai` and `UTC` only (fixed offsets, no timezone database). |
| `quietStart` | `23:00` | Inclusive start of quiet hours. |
| `quietEnd` | `08:00` | Exclusive end of quiet hours. May cross midnight. |
| `minIntervalMinutes` | `180` | Minimum gap between successful contacts, 15–10080 minutes. |
| `maxPerDay` | `2` | Maximum contacts per local calendar day, 0–24. |
| `activeThreadCooldownMinutes` | `30` | Do not interrupt a thread the owner used within this window, 0–1440. |
| `thread` | unset | Optional private thread id. Restricts candidates to that thread. |
| `chatId` | unset | Optional Feishu chat id treated as the owner's private chat. Falls back to `FEISHU_CHAT_ID`. |

Unknown keys, wrong types, malformed JSON, or out-of-range values fail loudly
at startup. A typo must not silently become a live schedule.

The model has no tool that writes `proactive.json`, in the same way it has no
tool that writes `routines.json`. The file is owner-controlled. It is not a
sandbox boundary: a trusted specialist agent or an embedding with the sandbox
disabled and a writable `DS_AGENT_HOME` could still edit it. Keep those agents
trusted, or enable strict read isolation.

## Scheduling semantics

- The existing `Daemon` pulse calls `ProactiveScheduler.tick()`. There is no
  separate timer, worker, or subprocess, and no model call merely because the
  interval elapsed.
- The first tick only arms: it stores `lastCheckAt` and does not evaluate.
- After a long stop or restart, at most the latest due round runs. Missed rounds
  are not replayed as a burst.
- Each due round runs one deterministic policy pass. It sends at most one
  candidate trigger into `Runtime.ingest`, or stays silent.
- Duplicate suppression uses the persisted `lastCheckAt`, `lastContactAt`, and
  a seven-day contact list in SQLite (`proactive/state`). The trigger id is
  stable per ticket, local day, and reason, so ingress can deduplicate a retry.
- A large backward clock jump re-arms instead of stalling. A small NTP-sized
  step is ignored.

## What can trigger a message

The policy only considers open Tickets that already have a real, admitted human
conversation and a concrete signal:

1. `report-question` — an assignment report contains a question for the owner.
2. `pending-approval` — the collaboration state has a pending approval.
3. `report-blocked` — a report is `blocked`, `waiting`, or `failed` and carries
   text explaining why.

There must also be a private channel with recent human activity:

- iMessage requires an `address.handle` and no `address.group`.
- Feishu requires the `chat_id` to match `chatId` or `FEISHU_CHAT_ID`.
- Generic IM channels must not be marked as group chats.

Related long-term memory for the Ticket is included as context when available.
If no candidate, private thread, or useful fact exists, the result is silence.

The Router sees the trigger with `proactive=true`. Its prompt requires at most
one short message, forbids an acknowledgement, a ticket inventory, a request
for a reply, and any mention of a scheduled check. It may call
`assess_trigger kind=stop` and say nothing. The canned `Acknowledged ...`
message is suppressed for proactive tickets.

## Delivery and safety

The path is the normal one:

```text
Daemon pulse -> ProactiveScheduler.tick -> Runtime.ingest
             -> Router -> Replies -> durable Outbox -> channel adapter
```

- No Worker starts for a proactive ticket. The Router turn is the whole
  message; the envelope ends after it.
- The trigger is `human: true` and direct, with a reserved
  `address.proactive=1`. It strips stale `message_id`, `root_id`, `parent_id`,
  and `thread_id`, so a reply cannot be threaded onto an old message.
- It fires only into an existing admitted private thread. It never invents a
  recipient and never posts to a group.
- The normal admission rules still apply (`DS_AGENT_ACTOR_ALLOWLIST`,
  `DS_AGENT_GROUP_ALLOWLIST`, `DS_AGENT_DROP_SELF`). `DROP_SELF` is what stops
  the agent from ingesting its own proactive output as a fresh instruction.
- Quota state is written before the trigger is handed to ingress. A crash
  cannot reset the daily cap or the minimum interval and produce a burst.
- Irreversible work still needs the existing approval hold. A proactive message
  does not approve anything and does not bypass the Worker sandbox.
- Transient outbox failures for proactive rows use a reserved per-row retry
  base of 10 minutes (2× backoff, capped at 80 minutes, five attempts). A
  failed send is not forgotten, and a restart cannot turn it into a tight retry
  loop. Successful sends keep their idempotency key.

## Enabling and operating

1. Write `proactive.json` with `"enabled": true` and the desired limits.
2. Restart the long-lived process (`ds-agent serve --feishu ...`). A one-shot
   command never ticks the scheduler.
3. Watch the log for `[proactive] enabled=true ...` and the per-tick action
   (`armed`, `not-due`, `quiet-hours`, `min-interval`, `daily-cap`, `silent`,
   or `contact`).

To disable, set `"enabled": false` or remove the file, then restart. Disabling
stops future evaluation; it does not retract an already-queued outbox row.

## Current limits

- The policy is deterministic and conservative. It does not call a model to
  decide whether to wake; the Router only decides how to phrase an already
  selected fact.
- Supported wake signals are report questions, pending approvals, and blocked
  reports. There is no connector-event wake (mail, calendar, documents,
  location) in this batch.
- No WhatsApp, SMS, email, or phone ingress. Real channel acceptance exists only
  for the adapters already in `main`; this change adds no live sends.
- Feishu private-chat detection needs `chatId` or `FEISHU_CHAT_ID`. Group chats
  are explicitly out of scope.
- The timezone list is intentionally small (`Asia/Shanghai`, `UTC`). A full
  timezone database is a later change.
- `proactive.json` is read at startup. There is no hot reload and no CLI editor.
- This PR ships code and offline tests only. Real Feishu/iMessage/email
  acceptance waits for the owner.

## Tests

`test/proactive.test.ts` uses a fake clock and fake transport. It covers:

- default disabled, file overrides, malformed config rejection, and no model
  write path;
- first-tick arming, due ticks, silence, and no real conversation;
- quiet hours, minimum interval, daily cap, and active-thread cooldown;
- restart without burst or replay;
- one useful follow-up through the outbox, with no Worker;
- no auto-approval of an irreversible action;
- group and new-recipient isolation, including an explicit thread;
- `DROP_SELF` and no self-reingest loop;
- a failed proactive send retrying after at least 15 minutes, not immediately.

No test sends to a real Feishu, iMessage, or email endpoint.
