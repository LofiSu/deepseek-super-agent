# Routines

A routine is owner-defined recurring work: a prompt the agent receives every
N minutes, or once per day at a UTC time on days you choose, on a channel you
choose. The owner writes the schedule; the model has no tool to create, edit,
or delete one.

The file is owner-controlled, not a sandbox boundary. A Worker that runs
outside the normal write sandbox — a configured local specialist agent, an
embedding with the sandbox disabled, or `bash` with `DS_AGENT_HOME` under a
writable root such as `/tmp` — can modify it. Keep such agents trusted, or
turn on strict read isolation. Symlinked writes from `write_file` are refused
by `LocalEnv`, so the ordinary workspace cannot reach the file through a link.

This is the product shape behind Muse's `HEARTBEAT.md` and Grok Bot's routines,
implemented as an owner file plus the normal ingress path rather than a second
execution loop.

## Configuration

`routines.json` in the agent home, or `DS_AGENT_ROUTINES` as a JSON seed. A
file wins over the seed; a blank file means "no routines" and also suppresses
the seed.

```json
[
  {
    "id": "deploy-check",
    "everyMinutes": 60,
    "prompt": "Check production health. Report only failures, with the failing check and commit.",
    "source": "imessage",
    "thread": "chat_42",
    "actor": "owner"
  },
  {
    "id": "morning-brief",
    "at": "08:00",
    "days": [1, 2, 3, 4, 5],
    "prompt": "Summarize what changed in the repo since yesterday. Skip it if nothing changed."
  }
]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable id (`^[a-z][a-z0-9_-]{0,31}$`). Also the persisted last-run key. |
| `everyMinutes` | one of | Integer from 5 to 10080 (7 days). Mutually exclusive with `at`. |
| `at` | one of | UTC `HH:MM`. Mutually exclusive with `everyMinutes`. |
| `days` | no | Days for `at`: `0` Sunday through `6` Saturday. Default every day. |
| `prompt` | yes | What the owner wants done. Up to 4000 characters. |
| `source` | no | Channel source: `cli` (default), `im`, `imessage`, `github`, or `a2a`. |
| `thread` | no | Thread id in that source. Default `local`. |
| `actor` | no | Actor id on the trigger. Default `you`. Use your allowlisted owner id when `DS_AGENT_ACTOR_ALLOWLIST` is set. |
| `group` | no | Group id set as `channel.address.group`. Required for admission when `DS_AGENT_GROUP_ALLOWLIST` is active. |

A routine has exactly one schedule: `everyMinutes` or `at`. Times are UTC, so
the schedule does not depend on the host's local zone or DST rules.

Up to 32 routines. A malformed entry fails loudly at startup and in
`ds-agent routines`; a typo must not silently mean the work never runs.

## Scheduling semantics

- The daemon checks routines on its normal tick, in the same process as the
  watchdog. There is no separate scheduler and no second timer.
- The first sight of a routine arms it without firing. An interval routine
  starts one full interval from then; a daily routine arms at the most recent
  due slot, so a first tick just after 08:00 waits until the next selected day
  and a first tick just before 08:00 still fires at 08:00.
- After that, a due routine fires once. If the process was down for hours or
  days, it fires once at the latest due slot, not once per missed slot. Missed
  work is not replayed as a burst.
- `lastRunAt` is persisted in SQLite (`routine` documents), so a restart does
  not refire the same slot. Interval routines save the tick time (so a long gap
  is not replayed); daily routines save the slot time.
- The trigger id is derived from the due slot
  (`trg_routine_<id>_<epochMs>`), so a crash between firing and saving is
  deduplicated by ingress on retry.
- A routine that throws while ingesting is logged and retried on the next tick;
  it does not block the other routines, and a scheduler exception is caught by
  the daemon pulse instead of terminating the process.
- A large backward clock jump (bad RTC, restored snapshot) re-arms the routine
  at the corrected time instead of stalling it until wall time catches up. A
  small NTP-sized step keeps the existing schedule.

## Delivery and safety

A routine enters through `Runtime.ingest`, exactly like a message:

- it is an owner-authored, direct trigger on the configured channel and thread;
- the normal admission rules still apply (`DS_AGENT_ACTOR_ALLOWLIST`,
  `DS_AGENT_GROUP_ALLOWLIST`, and `DS_AGENT_DROP_SELF`, if set);
- the rules layer, sandbox, and approval boundaries are unchanged: a routine
  is a standing instruction to do the work, not permission to do anything the
  owner could not ask for in chat;
- replies go through the Router and the Outbox for that channel, like any other
  turn.

The process must be running (`ds-agent serve`, plus `--imessage` or `--feishu`
when the routine targets that channel, or the long-lived `ds-agent imessage`
loop). One-shot commands (`approve`, `retry`, `resume`, `chat`, `emit`) never
tick routines. A routine does not wake a
stopped process, and `cli` routines are visible in the runtime and the UI but
are not pushed to a terminal.

## CLI

```bash
ds-agent routines           # id, cadence, channel, prompt
ds-agent routines --json
```

## Current limits

- Daily schedules are a UTC time plus weekdays, not a cron expression. Multiple
  times per day need multiple routines. There is no per-routine timezone yet;
  a UTC time is deliberate so the host zone cannot change the schedule.
- No per-routine tool allowlist. A routine is framed by the normal rules and
  the Worker sandbox, not by a narrower capability set.
- No catch-up policy choice. Firing once for a long gap is fixed behavior.
- No owner-facing editor yet. Editing the file and restarting is the supported
  path; the file is read once at `Runtime.create`.
