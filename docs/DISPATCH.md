# GitHub issue dispatch and bounded RSI queue

Production ingress for owner-triggered fixes and evidence-based improvements. This is the **peanut/serve orchestrator** with a shared SQLite job queue — not a public webhook server and not a dedicated GitHub bot account.

## Identity

- Authenticated `gh` user for this deployment is **LofiSu** (default authorized actor).
- Public user [`ds-agent`](https://github.com/ds-agent) is **unrelated** and not owned here. Config **must not** list `ds-agent` as a `mentionHandle` unless a verification probe proves the authenticated login matches (it does not today).
- **`/ds-agent` is a slash command**, not a GitHub account mention. Syntax at the start of a line (outside fences, inline code, blockquotes):
  - `/ds-agent fix` — enqueue a fix job for this issue
  - `/ds-agent status` — local state only
  - `/ds-agent cancel` — cancel queued jobs for this issue (local only)
- **Optional @handle lines** apply only when `mentionHandles` is configured **and** each handle was verified against `gh api user` at config load. Examples (case-insensitive handle): `@LofiSu fix`, `@LofiSu /ds-agent fix`. Still requires an explicit `fix|status|cancel`. An unconfigured `@ds-agent` mention is **not** a command.
- A **dedicated @bot identity is not connected**. Polling is not the same as a GitHub App bot.

## Ingress

- **Polling only** via argv `gh api` (no shell, no token in logs). **No HTTP listener** in `serve`.
- Repo is fixed in `<DS_AGENT_HOME>/github-dispatch.json` (default `LofiSu/deepseek-super-agent`); issue text cannot override repo, actors, or policy.
- Cursor in SQLite: **first start seeds to “now”** — historical issues/comments are not replayed.
- **Issue body** commands are admitted when the issue was created at or after `seededAt`, author is authorized, body contains an allowed command, and it is not a PR. Dedup id: `issue-body:<issue.id>`.
- Comment dedup by GitHub comment id; polls retry with backoff without double-running handled ids.
- Optional `verifyGithubWebhookSignature256()` exists for a future operator-mounted HTTPS endpoint; **webhook ingress is not deployed**.

## Admission (fail closed)

Accept only when: configured repo; **issue** (not PR); authorized actor login; non-bot author; allowed command after strip of fences/quotes/code; no privilege injection from issue body.

## Jobs and publish

- Shared queue: `github_fix`, `rsi_implement`, `rsi_proposal` — **one running job** at a time, lock in SQLite, restart recovery (interrupted run requeued once, then failed).
- **No auto-publish without an implementer.** Default `createJobRunner()` refuses `github_fix` / `rsi_implement` with `implementer not configured; refusing empty publish`. Set `github.implementer` to `"claude"` in owner config to run the host-side path: isolated `git clone --no-hardlinks`, baseline `pnpm typecheck` and targeted vitest, optional Claude Code CLI (`claude -p` with bounded timeout), re-run tests, then **FeaturePrPublisher** only (`peanut/dispatch-issue-<n>` → PR to `main`). Omit `implementer` or set `"none"` to keep fail-closed. `rsi_implement` stays fail-closed even when `claude` is enabled. Publisher-only commits of issue dumps or gap notes are forbidden.
- Injected runs may publish via **FeaturePrPublisher only** (`peanut/*` → PR to `main`, issue link in body). **No** `GithubOutboxAdapter` and **no** issue comments for progress.
- Local CLI: `ds-agent dispatch status`, `ds-agent dispatch cancel <id>`.

## RSI (bounded improvements)

- Same queue and permissions. Not unbounded feature invention; does not weaken trust, admission, sandbox, vault, or eval thresholds.
- Research: host **trusted-fetch** (HTTPS, allowlist, SSRF deny). Homepage snapshots update **research cache / recorded failure** only — they do **not** enqueue implement jobs or auto-PR HTML dumps.
- Structured gaps: explicit `ingestGap` with testable acceptance (low-risk may enqueue one implement). Rows with status `missing` in `docs/INSTINCT_CAPABILITIES.md` are recorded as **proposal-only** gaps (no auto `rsi_implement`); stub-test acceptance text is not enough for WhatsApp/SMS/vault-class product gaps. **Manus cue** product meaning is **unknown** — stored as `unknown`, not invented.
- Gap pool with dedupe, priority, acceptance criteria. High-risk items → `rsi_proposal` only. Low-risk with testable acceptance → one implement at a time when an implementer is configured.
- Scheduler inside `serve` when config `rsi.enabled`; default interval **6h** (minimum floor 30m). Idle when no item or equivalent open `peanut/*` PR exists.
- If coding is delegated to Claude Code externally, that must appear in job records; fixture tests use in-process `JobRunner` without live GitHub writes.

## Configuration

File: `<DS_AGENT_HOME>/github-dispatch.json` (outside worker writable roots).

```json
{
  "github": {
    "enabled": true,
    "repo": "LofiSu/deepseek-super-agent",
    "authorizedActors": ["LofiSu"],
    "pollIntervalMs": 60000,
    "sourceRepo": "https://github.com/LofiSu/deepseek-super-agent.git",
    "implementer": "none"
  },
  "rsi": {
    "enabled": true,
    "intervalMs": 21600000,
    "fetchAllowlist": ["docs.github.com", "github.com"]
  }
}
```

`pollIntervalMs` defaults to **60_000** with a minimum floor of **15_000**.

`serve` loads dispatch when the file enables `github` and/or `rsi`, or when `--github-dispatch` / `DS_AGENT_GITHUB_DISPATCH=1` is set (config must still validate).

Default sandbox `allowNetwork` stays off; research fetch is host-side only.

