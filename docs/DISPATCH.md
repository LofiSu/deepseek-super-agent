# GitHub issue dispatch and bounded RSI queue

Production ingress for owner-triggered fixes and evidence-based improvements. This is the **peanut/serve orchestrator** with a shared SQLite job queue — not a public webhook server and not a dedicated GitHub bot account.

## Identity

- **Authorized actors** (who may issue commands): **LofiSu** by default, plus any configured `authorizedActors`. **Poll/publish authentication** is the owner’s **`gh`** CLI when `github.auth` is omitted; with `github.auth.mode` `github-app`, the installed GitHub App mints short-lived installation tokens (see **`github.auth`** below).
- Public user [`ds-agent`](https://github.com/ds-agent) is **unrelated** to this harness and **must not** be used as a `mentionHandle` (verification does not match today).
- **`/ds-agent` slash commands** are the **reliable** dispatch interface (not a GitHub account mention). Syntax at the start of a line (outside fences, inline code, blockquotes):
  - `/ds-agent fix` — enqueue a fix job for this issue
  - `/ds-agent status` — local state only
  - `/ds-agent cancel` — cancel queued jobs for this issue (local only)
- **Optional @handle lines** are **local text triggers** parsed by the poller only — not a guarantee of native GitHub @notification or autocomplete for a generic App. In **owner-gh** mode, configured handles must verify against `gh api user` at load (e.g. `@LofiSu fix`). In **github-app** mode, only the verified `GET /app` **slug** and `{slug}[bot]` are allowed (e.g. `@lofisu-peanut-agent fix`, `@lofisu-peanut-agent[bot] fix`). Each line still requires an explicit `fix|status|cancel`. An unconfigured `@ds-agent` mention is **not** a command. **Do not claim** a generic GitHub App is natively notified by @mention; **webhook ingress is not deployed**.

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
- **No auto-publish without an implementer.** Default `createJobRunner()` refuses `github_fix` / `rsi_implement` with `implementer not configured; refusing empty publish`. Set `github.implementer` to `"claude"` in owner config to run the host-side path for **both** `github_fix` and `rsi_implement`: isolated `git clone --no-hardlinks`, baseline and post-change **holdout** (`pnpm typecheck` plus offline `vitest run` with the same exclusions as `pnpm test:coverage`), optional Claude Code CLI (`claude -p` with bounded timeout), **diff path policy** enforced at publish (see below), then **FeaturePrPublisher** only (`peanut/dispatch-issue-<n>` or `peanut/rsi-<gapId>` → PR to `main`). Omit `implementer` or set `"none"` to keep fail-closed for both job types. Publisher-only commits of issue dumps or gap notes are forbidden.
- **Prompt text is not the control plane.** Claude instructions are guidance; publish-time checks are `git diff --name-only` against the pre-change `baseHead`, forbidden paths (admission, dispatch trust config, ingress filter, sandbox/vault/credential/bash network policy, publish intermediary, `.github/workflows`, eval threshold tests, dispatch implementer modules), no deleted baseline test files, and holdout re-run. RSI mode is stricter: also blocks `package.json` / `pnpm-lock.yaml` and diffs that touch only docs/prompts.
- Injected runs may publish via **FeaturePrPublisher only** (`peanut/*` → PR to `main`, issue or gap metadata in body). **No** `GithubOutboxAdapter`, **no** auto issue comments, **no** merge/force-push/main tags. RSI candidate PRs require human merge before deploy.
- Local CLI: `ds-agent dispatch status`, `ds-agent dispatch cancel <id>`.

## RSI (bounded improvements)

- Same queue and permissions. Not unbounded feature invention; does not weaken trust, admission, sandbox, vault, or eval thresholds.
- Research: host **trusted-fetch** (HTTPS, allowlist, SSRF on every hop; up to 3 HTTPS redirects re-validated per hop). Optional `rsi.sourceUrls` for explicit documentation URLs (default includes `https://docs.github.com/en`). Homepage fetches under `fetchAllowlist` update **research cache / recorded failure** only — they do **not** enqueue implement jobs or auto-PR HTML dumps.
- Structured gaps: explicit `ingestGap` with testable acceptance (low-risk may enqueue one implement). Rows in `docs/INSTINCT_CAPABILITIES.md` with status `missing` or `environment-blocked` are classified by content: WhatsApp/SMS/vault/connector-class items stay **proposal**; **low** only when not high-risk and acceptance is drawn from the 验收/依据 column (not stub filler). `docs/COMPETITIVE_GAP.md` Missing/Partial scorecard rows ingest as proposals with source path + `fetchedAt`. **Manus cue** product meaning is **unknown** — stored as `unknown`, not invented.
- Gap pool with dedupe, priority, acceptance criteria. High-risk items → `rsi_proposal` only (recorded, **implementer not called**). Low-risk with testable acceptance → one `rsi_implement` at a time when `github.implementer` is `claude` and no equivalent open `peanut/rsi-*` PR exists.
- Scheduler inside `serve` when config `rsi.enabled`; default interval **6h** (minimum floor 30m). Idle when no safe low-risk gap or implement already queued/running/completed for that gap.
- If coding is delegated to Claude Code externally, that appears in job/PR records; fixture tests use in-process `JobRunner` with mocked coder/holdout without live GitHub writes.

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
    "fetchAllowlist": ["docs.github.com", "github.com"],
    "sourceUrls": ["https://docs.github.com/en"]
  }
}
```

`pollIntervalMs` defaults to **60_000** with a minimum floor of **15_000**.

### `github.auth` (host-only)

When omitted, dispatch uses the owner’s authenticated **`gh`** CLI (`mode: owner-gh`). Optional GitHub App mode avoids putting installation tokens in `~/.config/gh` and mints short-lived tokens in process memory only.

| Key | Notes |
|-----|--------|
| `mode` | `"github-app"` or omit / `"owner-gh"` |
| `appId` | GitHub App numeric id (JSON string or number) |
| `clientId` | OAuth Client ID (JWT `iss`; string) |
| `installationId` | Installation id for the configured repo (string or number) |
| `privateKeyFile` | **Absolute** path to the App private key PEM (string) |
| `expectedSlug` | Verified slug from `GET /app` (string) |

JWT signing follows GitHub’s [App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) (RS256, `iat` up to 60s in the past, `exp` ≤ 10 minutes, `iss` = Client ID). Installation tokens use [Create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).

**Fail-closed:** invalid, incomplete, or unverifiable `github-app` auth **throws at load** — there is **no** fallback to owner `gh`. Only omission of `github.auth` keeps owner `gh`.

**Key material:** PEM lives **outside** the git repo and outside `/workspace` checkouts; file mode **0600** or **0400** only. Do not store PEM, client secret, or tokens in JSON, git, or worker sandboxes. Tokens stay in memory; each `gh`/`git` host call refreshes the installation token as needed (in-memory cache with refresh skew).

**Example identifiers (this deployment):** App “LofiSu Peanut Agent”, slug `lofisu-peanut-agent`, App ID **5772121**, installation **182274751**, PEM path `/home/box/ds-agent-credentials/github-app/lofisu-peanut-agent.pem` (no PEM body or client secret in repo).

### @mentions vs slash commands

GitHub’s writing docs describe @mentions as notifying **people** and org teams; autocomplete is documented for collaborators and thread participants. There is **no official guarantee** that a generic GitHub App is notified by `@slug` or `@slug[bot]`, or that it appears in `@` autocomplete. Copilot agent apps are a different product. **Webhook ingress is not deployed**, so GitHub will not deliver comment webhooks to this App. The poller may treat a **verified** App slug and `{slug}[bot]` in `mentionHandles` as a **local text trigger** only (after `GET /app` slug match). The reliable interface remains `/ds-agent fix`, `/ds-agent status`, and `/ds-agent cancel` — do not claim native App notification.

### Permissions warning

GitHub’s permission model treats **Pull requests: write as including merge**. The installation token is not “PR-only”; **`main` branch protection** and review requirements remain the merge barrier. `FeaturePrPublisher` opens PRs only; it does not merge.

`serve` loads dispatch when the file enables `github` and/or `rsi`, or when `--github-dispatch` / `DS_AGENT_GITHUB_DISPATCH=1` is set (config must still validate).

Default sandbox `allowNetwork` stays off; research fetch is host-side only.
