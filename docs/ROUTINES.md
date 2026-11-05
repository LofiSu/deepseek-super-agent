# Routines

A routine is owner-defined recurring work: a prompt the agent receives every
N minutes on a channel you choose. The owner writes the schedule; the model has
no tool to create, edit, or delete one.

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
    "everyMinutes": 1440,
    "prompt": "Summarize what changed in the repo since yesterday. Skip it if nothing changed."
  }
]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable id (`^[a-z][a-z0-9_-]{0,31}$`). Also the persisted last-run key. |
| `everyMinutes` | yes | Integer from 5 to 10080 (7 days). |
| `prompt` | yes | What the owner wants done. Up to 4000 characters. |
| `source` | no | Channel source: `cli` (default), `im`, `imessage`, `github`, or `a2a`. |
| `thread` | no | Thread id in that source. Default `local`. |
| `actor` | no | Actor id on the trigger. Default `you`. Use your allowlisted owner id when `DS_AGENT_ACTOR_ALLOWLIST` is set. |
| `group` | no | Group id set as `channel.address.group`. Required for admission when `DS_AGENT_GROUP_ALLOWLIST` is active. |

Up to 32 routines. A malformed entry fails loudly at startup and in
`ds-agent routines`; a typo must not silently mean the work never runs.

## Scheduling semantics

- The daemon checks routines on its normal tick, in the same process as the
  watchdog. There is no separate scheduler and no second timer.
- The first sight of a routine arms it at the current time; it does not fire
  immediately. A newly added routine starts one full interval from then.
- After that, a due routine fires once. If the process was down for hours, it
  fires once, not once per missed slot. Missed work is not replayed as a burst.
- `lastRunAt` is persisted in SQLite (`routine` documents), so a restart does
  not refire the same slot.
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
when the routine targets that channel). One-shot commands (`approve`, `retry`,
`resume`, `chat`, `emit`) never tick routines. A routine does not wake a
stopped process, and `cli` routines are visible in the runtime and the UI but
are not pushed to a terminal.

## CLI

```bash
ds-agent routines           # id, cadence, channel, prompt
ds-agent routines --json
```

## Current limits

- Interval only. There is no cron expression or "every weekday at 08:00" yet;
  a daily routine is `everyMinutes: 1440`, which drifts with restarts.
- No per-routine tool allowlist. A routine is framed by the normal rules and
  the Worker sandbox, not by a narrower capability set.
- No catch-up policy choice. Firing once for a long gap is fixed behavior.
- No owner-facing editor yet. Editing the file and restarting is the supported
  path; the file is read once at `Runtime.create`.
