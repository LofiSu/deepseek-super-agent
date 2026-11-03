#!/usr/bin/env python3
"""Stop guard for the Super Agent orchestrator.

Claude Code runs this on Stop. It fails open (allows the stop) unless the
project state says the orchestrator is running, has an active next action,
still has work, and has made real progress recently.

The hook never schedules work and never starts a loop: it only answers
"is stopping now premature?".
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

TERMINAL_STATUSES = {
    "completed",
    "complete",
    "failed",
    "cancelled",
    "canceled",
    "stopped",
    "removed",
    "skipped",
}

ACTIVE_ACTIONS = {"plan", "execute", "review", "integrate", "checkpoint"}
RELEASE_ACTIONS = {"idle", "owner_input", "paused", "done", "stopped"}
DEFAULT_MAX_IDLE_MINUTES = 20


def output_block(reason: str) -> None:
    print(json.dumps({"decision": "block", "reason": reason}))


def parse_time(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def as_count(value) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def active_background_tasks(event) -> int:
    tasks = event.get("background_tasks") or []
    if not isinstance(tasks, list):
        return 0
    return sum(
        1
        for task in tasks
        if isinstance(task, dict)
        and str(task.get("status", "")).lower() not in TERMINAL_STATUSES
    )


def main() -> None:
    # Any malformed input means "do not interfere with the user's session".
    try:
        event = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(event, dict):
        return

    cwd = event.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        return

    state_file = Path(cwd).resolve() / ".super-agent" / "state.json"
    if not state_file.is_file():
        return

    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(state, dict):
        return

    # An explicit owner stop or any non-running mode always wins.
    if state.get("stop_requested") is True:
        return
    if state.get("mode") != "running":
        return

    action = str(state.get("next_action") or "idle")
    if action in RELEASE_ACTIONS or action not in ACTIVE_ACTIONS:
        return

    queue = state.get("queue") if isinstance(state.get("queue"), dict) else {}
    ready = as_count(queue.get("ready"))
    in_progress = as_count(queue.get("in_progress"))
    background = active_background_tasks(event)

    # An active next_action alone is not work: it must be backed by a queue or
    # a real background task, otherwise a stale action would block forever.
    if ready == 0 and in_progress == 0 and background == 0:
        return

    last_progress = parse_time(state.get("last_progress_at"))
    if last_progress is None:
        return

    max_idle_minutes = as_count(state.get("max_idle_minutes")) or DEFAULT_MAX_IDLE_MINUTES
    if datetime.now(timezone.utc) - last_progress > timedelta(minutes=max_idle_minutes):
        return

    # stop_hook_active is deliberately not an unconditional bypass: the queue
    # and progress state decide. Claude Code also caps consecutive blocks.
    reason = (
        "SUPER AGENT HAS UNFINISHED PROJECT WORK. "
        f"Current action: {action}. Ready: {ready}. In progress: {in_progress}. "
        f"Active background tasks: {background}. "
        "Resume the EXISTING orchestrator cycle. Do not start another scheduler "
        "or nested loop. Collect completed agent results, review PRs, run the "
        "required tests, update project state, and continue the current batch. "
        "If blocked, persist the blocker and set next_action to owner_input. "
        "If the session budget is reached, checkpoint and set mode to paused."
    )
    output_block(reason)


if __name__ == "__main__":
    main()
