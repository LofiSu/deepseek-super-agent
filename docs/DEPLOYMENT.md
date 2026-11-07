# Deployment configuration (offline / loopback)

This document describes **supported** resident paths without exposing public listeners by
default. Real Feishu/GitHub accounts are operator-gated; CI uses simulated loopback HTTP only.

## Process models

| Command | Inbound | Outbound | Shutdown |
|---------|---------|----------|----------|
| `ds-agent serve` | Optional `--imessage` / `--feishu` poll loops (opt-in) | Outbox drain | SIGINT/SIGTERM → `Runtime.finish()` then exit 0; second signal force-exits 1 if drain hangs |
| `ds-agent chat` / `emit` | None | CLI only | Process exit after command |
| `ds-agent ui` | Loopback HTTP + token | None | Process exit |
| A2A HTTP mesh | **Not started** unless operator mounts `createA2AHttpHandler` or `createRemoteMeshHandler` on `127.0.0.1` | Client transport only | Close server; in-flight requests fail closed |

## Environment (secret-free summary)

| Variable | Purpose |
|----------|---------|
| `DS_AGENT_HOME` | SQLite state directory |
| `DS_AGENT_INSTANCE_ID` | Local mesh / A2A id |
| `DS_AGENT_MESH_CAPACITY` | In-process worker slots |
| `DS_AGENT_MESH_QUEUE` | Bounded wait queue |
| `DS_AGENT_REMOTE_MESH` | JSON array of remote peers (HTTPS or loopback HTTP); secrets in env only |
| `DS_AGENT_UI_TOKEN` | Required for `ds-agent ui` (≥16 chars) |
| `DS_AGENT_SANDBOX_READ_ISOLATION` | Opt-in `1`/`true`/`strict` strict read roots |
| `DS_AGENT_ALLOW_MOCK_FIXTURE` | Offline CI only; must be `1` with `CI=true` in automation |

## Unsupported resident inbound adapters

| Adapter | Resident poll/webhook in `serve` | Notes |
|---------|----------------------------------|-------|
| Feishu | `--feishu` (opt-in poll) | SQLite cursor; loopback-tested dedupe |
| iMessage | `--imessage` (opt-in poll) | Local `chat.db` only |
| GitHub | **Unsupported** | No daemon poll/webhook; use `github-source` tooling |
| Generic webhook listener | **Unsupported** | No public HTTP listener by default |

## Channel loops (M11)

- **Feishu (`--feishu`)**: poll one chat; cursor in SQLite (`feishu_cursor`); transient poll errors use capped exponential backoff (`maxBackoffMs`, default 30s); does not open a webhook listener.
- **iMessage (`--imessage`)**: polls `chat.db`; admission errors fail closed; `AbortSignal` stops the loop and `outbox.stop()` ends the flush timer.
- **GitHub**: no resident inbound poll loop in `serve` — only `github-source` tooling and demo paths; do not assume webhook or poll ingestion on the daemon.
- **Combined serve**: independent `AbortController` per loop; one loop failure is logged, not fatal to the other.
- **Dedupe / backpressure**: Feishu/iMessage cursors prevent re-ingest of the same row; ingress dedupe on triggers; outbox retries with cap (5 attempts); mesh queue bounded by `DS_AGENT_MESH_QUEUE` (`mesh.queue-full` rejects).

## Simulated acceptance (CI)

```bash
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 pnpm exec vitest run test/deployment-loopback-integration.test.ts
```

Uses `127.0.0.1` ephemeral ports only. No real credentials.

## Longitudinal LTM measurement (parent cron)

```bash
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 pnpm t48:long
```

(See `docs/T48_MONTH_SCALE_PROTOCOL.md` when `t48:long` is on `main` via PR #166.)

## Sandbox honesty

Worker bash uses OS wrappers (`sandbox-exec` / `bwrap`) when present. **PATH presence alone is not enforcement.**
Use `probeSandboxConfinement()` (`src/env/sandbox-probe.ts`) for a host-safe positive exec + negative write-outside-workspace check;
outcomes are `enforced`, `not_enforced`, `unsupported`, or `probe_failed` — never implied kernel guarantees beyond what the probe observed.
PR #163 remains the dedicated health/sandbox track; this PR does not claim full seccomp coverage. Opt-in read isolation is in `docs/CONTAINER.md`.
