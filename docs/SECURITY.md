# Security threat model — A2A, mesh, and local UI

- **Date:** 2026-11-04; **base:** `origin/main` at `e700730`.
- **Scope:** W4 networked A2A/mesh surfaces and the W3 local UI, plus the
  worker/host boundary they depend on.
- **Status:** *implemented* = on `main`; *planned* = design requirement, no
  code on `main`. A2A HTTP is implemented on `main` (PR #123, merge `7a1d732`);
  the local UI and the cross-host mesh transport remain planned.

Citations to `src/channels/a2a-auth.ts` and `src/channels/a2a-http.ts` follow
the merged files at `7a1d732` (PR #123 final head `9130d4c`). The adapter is
merged, but it opens no listener and wires no CLI surface, so exposing it remains
an operator decision. The local UI still has no `src/ui/*` and no `ds-agent ui`
command on `main`; its requirements come from `docs/PRODUCTION_PROGRAM.md:61`.

## 1. Assets and trust boundaries

| Asset | Where it lives | Boundary | Notes |
|---|---|---|---|
| Gateway bearer token | `<stateDir>/gateway.token`, mode `0600` (POSIX), plain single-link file | local filesystem | Symlinks, hard links, and non-regular files are refused; `O_NOFOLLOW` is used (`src/gateway/token.ts:7,49-53,99-120`). Never printed (`src/cli/gateway.ts:79-80`). |
| Provider API keys | env, `gateway.config.json`, or `FileVault` | process env / local file | The gateway forwards keys and does not scrape them (`src/gateway/config.ts:5-8,107-108`). `gateway.config.json` is read without a mode check (`src/gateway/config-file.ts:36-44`); `FileVault` writes `0600` (`src/env/vault.ts:63-72`). |
| A2A per-peer secrets | caller-supplied `resolveSecret` callback; no adapter storage | network peer (no default listener) | Secrets/signatures are excluded from errors and results, and secrets shorter than 32 bytes are refused (`a2a-auth.ts:4-13,38-42,66-75,268-278`). |
| A2A envelopes | in-memory history plus SQLite `documents` kind `a2a` | untrusted wire ingress | 64 KiB UTF-8 body cap (`src/channels/a2a.ts:24,119-126`); identity/timestamps are re-assigned by `send` (`a2a.ts:64-79`). |
| Memory spills and grants | SQLite `spills` + `spill_grants` | process / SQLite file | Grants are ticket/session scoped; a spill id alone is not a capability (`src/memory/acl.ts:22-41`). Reads are paged to 200 bytes (`acl.ts:4-5`). |
| Lifecycle/UI read model | in-memory `LifecycleBus` plus durable SQLite `lifecycle_events` (schema v3) | process / SQLite file | Bounded keep-newest ring; restart replay hydrates from the durable log (`src/core/lifecycle.ts:8-27,78-84,119-121`; `src/store/schema.ts:97,138-148`; `src/store/sqlite.ts:128-163`). No UI consumes it yet on `main`. |
| Worker filesystem | per-worker directory under `<stateDir>/workspaces` | process → child shell | Path escapes are rejected (`src/env/local-env.ts:224-231`); writes are bounded by the sandbox policy (`src/env/seccomp.ts:86-110,112-131`). |
| Outbound channel credentials | Feishu env (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`); GitHub uses the host `gh` login | process → external channel | Feishu refuses a half-configured app (`src/channels/feishu.ts:12-20,38-52`); GitHub writes use the machine login (`docs/safety.md:38`). Replies are queued durably in SQLite `outbox` (`src/store/sqlite.ts:192-212`; `src/channels/outbox-adapter.ts:30-72`). |

Data planes: **model context** is rebuilt from the session journal after ingress
and tool-result redaction (`src/harness/session.ts:52-65,72-79`;
`src/runtime.ts:659`; `src/env/local-env.ts:181-185,195-198`). **Tool results**
are allowlisted-env child output/file reads, redacted before they enter the
journal or a model request (`local-env.ts:57,181-185,195-198`;
`src/env/sanitize.ts:66-89`). **Logs** pass through `RedactingLogger`
(`src/runtime.ts:170-178,252-255`). The **journal** is append-only JSONL plus a
SQLite `messages` copy and is not itself a redaction boundary
(`src/harness/session.ts:24-50`). **SQLite** stores documents, spills, messages,
replies, outbox text, and lifecycle payloads in plaintext; this repo provides no
database encryption (`src/store/sqlite.ts:15-32,86-218,281-315,400-413`).

Trust boundaries: process → worker shell; listener → network (gateway and A2A
HTTP, but no A2A listener is wired by default); peer → authenticated peer id;
process → model provider; local OS user → state directory; browser → planned UI
loopback.

## 2. Adversaries and non-goals

| Adversary | Capability and goal |
|---|---|
| Passive/active network attacker | Reads or alters traffic to an exposed listener; wants gateway/A2A credentials, message bodies, or a forged delivery result. |
| Rogue/compromised peer with a valid secret | Authenticates correctly, then sends hostile bodies, probes routing, or replays a captured request against another verifier node. |
| Replayed request | Resends a valid signed request inside the clock window to duplicate a side effect. |
| Malicious trigger text (prompt injection) | Steers the Router/Worker through issue, chat, or A2A text; wants tool misuse, data exfiltration, or an unauthorized reply. |
| Local unprivileged user | Reads the state directory, SQLite, journals, or environment left by the operator. |
| Compromised worker/tool | Runs in the child shell and tries to escape the workspace, reach the network, read host files, or leak injected credentials. |
| Curious model provider | Receives every prompt and tool result sent upstream; may retain or inspect it. |

**Non-goals:** protection from root, a hostile same-uid process, or a compromised
host; container/VM hardening; key distribution or TLS termination; multi-tenant
authorization; guaranteed prompt-injection detection; model alignment; DDoS;
supply-chain integrity; provider availability. A2A authentication does not
authorize *what* an authenticated peer may ask for.

## 3. A2A HTTP transport (implemented in #123)

The envelope contract leaves network I/O and peer authentication outside the
adapter: `A2ATransport` only moves envelopes and `LocalA2ATransport` is not an
authentication boundary (`src/channels/a2a-transport.ts:1-45`). PR #123
implemented the HTTP half and merged as `7a1d732`; it adds the handler and
client below, but opens no listener and wires no CLI command. Exposure is still
operator-gated: bind loopback by default, require TLS for a remote endpoint, and
fail closed (`docs/PRODUCTION_PROGRAM.md:100`).

Implemented controls:

- **Canonical HMAC-SHA256 v1.** The canonical string
  `v1\n<peer>\n<timestamp>\n<nonce>\n<sha256(body)>` binds the peer and request
  bytes but deliberately not the host, path, or method (`a2a-auth.ts:15-25,280-292,294-323`).
  Headers are `x-ds-peer`, `x-ds-timestamp`, `x-ds-nonce`, `x-ds-signature`;
  peer ids exclude whitespace/control characters, timestamps are digits, nonces
  are 32–256 hex characters, and signatures are 64 hex characters
  (`a2a-auth.ts:28-33,47-51`). Secrets shorter than 32 UTF-8 bytes are refused
  (`a2a-auth.ts:38-42,260-278; a2a-http.ts:318-321`).
- **Pre-body freshness and replay.** `inspectA2ARequest` validates header,
  timestamp, nonce, and signature shape plus the ±60 s window before any body
  bytes are buffered (`a2a-auth.ts:325-364`; call at `a2a-http.ts:293-308`). The
  replay cache is atomically keyed by `(peer id, nonce)`, pruned with the
  boundary retained, and bounded to 10,000 entries (`a2a-auth.ts:154-192`); a
  failed signature does not consume the nonce (`a2a-auth.ts:396-405`). Callers
  may inject a shared cache (`a2a-auth.ts:22-25`; `a2a-http.ts:66-67,243-246`).
- **Body cap and authenticated `from`.** `content-length` over 64 KiB is rejected
  and a streamed body is cut off at 64 KiB (`a2a-http.ts:45,175-179,181-229,323-335`);
  shape and secret checks run before the body is read. The peer id comes from the
  verified header, never the JSON body: a body `from` must be absent or equal to
  it, other keys are dropped, and the router re-assigns `id`/`at` and copies only
  `from`/`to`/`body` (`a2a-http.ts:352-378`; `src/channels/a2a.ts:24,64-79,119-126`).
- **Constant-time comparison, generic errors, no listener.** Signature hex is
  length-checked then compared with `crypto.timingSafeEqual`
  (`a2a-auth.ts:396-400`). Statuses are 401 for authentication/unknown
  peer/skew/replay, 400 for parse/envelope problems, 404 for unroutable, and 502
  for delivery failure; bodies are static and never echo input
  (`a2a-http.ts:232-242,346-349,401-407`), with `no-store`/`nosniff` headers
  (`a2a-http.ts:144-159`). The module exposes a handler and client only; the
  owner must create the listener and supply secrets (`a2a-auth.ts:12-13`;
  `a2a-http.ts:14-21,243-246`).
- **Client endpoint, response bounds, and deadlines.** The outbound transport
  requires `https:`, or `http:` only for a loopback host, and refuses redirects
  (`a2a-http.ts:123-142,488-497,548-551`). Responses must be JSON, are capped at
  128 KiB, and the body read shares the request deadline
  (`a2a-http.ts:46-47,435-470,563-568`); a response is trusted only when status,
  strict `isDelivery` shape, and envelope `from`/`to` agree
  (`a2a-http.ts:411-433,588-605`). The handler has an absolute deadline in
  addition to socket inactivity, racing `resolveSecret` and the body read
  (`a2a-http.ts:48-49,248-272,310-335`); the outbound request uses the same 30 s
  default (`a2a-http.ts:525-585`).

### Residual risks (implemented surface)

- **Replay state is process-local and may be shared unsafely.** The module and
  per-handler caches live in one process (`a2a-auth.ts:194`;
  `a2a-http.ts:244-245`), so a restart forgets nonces inside the ±60 s window.
  Because the canonical string does not bind the target host/path/method
  (`a2a-auth.ts:15-25`), sharing one secret across verifier nodes lets a captured
  request replay at each node. The unique-secret/shared-cache requirement is
  documented (`a2a-auth.ts:15-25`) but not enforced by code.
- **Responses are not signed.** The client validates HTTP status, delivery
  shape, and envelope `from`/`to`, and requires TLS off-loopback
  (`a2a-http.ts:411-433,555-605`), but the response is not cryptographically
  bound to the request or key. An authenticated peer can still report a false
  `delivered`, and loopback plain HTTP trusts a local process. Sign responses or
  bind them to a request nonce if delivery status drives side effects.
- **TLS termination and key distribution remain deployment concerns.** The
  client refuses non-loopback plain HTTP (`a2a-http.ts:123-142,488-497`), but
  the handler opens no listener and cannot enforce inbound TLS; plain HTTP to a
  loopback host is allowed (`a2a-http.ts:139-140`). Secret distribution and
  rotation are explicitly operator work (`a2a-auth.ts:12-13`).
- **No key id and bounded eviction.** v1 has one secret per peer, so rotation has
  no dual-secret grace period; when the cache is full, the oldest insertions are
  dropped (`a2a-auth.ts:182-186`), which can forget a nonce still inside its
  window. `resolveSecret` also runs before the HMAC check (`a2a-http.ts:310-321`),
  so arbitrary peer ids can trigger lookups; the deadline bounds a hanging one.

Recommendations before exposure: use a unique secret per verifier node and/or a
shared, durable replay store with atomic nonce claims (the documented
requirement); add a key id/version for overlap rotation; terminate TLS at the
listener or a reverse proxy for every non-loopback endpoint; sign responses or
bind them to the request nonce if the caller acts on delivery status; keep
replay tests and the deployment checks.

## 4. Local UI (planned; not shipped)

There is no UI implementation on `main`. The planned `ds-agent ui` must bind
`127.0.0.1`, expose read-only ticket/thread/outbox/health views, accept an
optional local token, and load no remote code (`docs/PRODUCTION_PROGRAM.md:61`).

Planned requirements, so the eventual PR can be reviewed against them:

- Loopback-only bind by default; remote binding is explicit opt-in with TLS and
  a required credential, matching the network gate (`docs/PRODUCTION_PROGRAM.md:100`).
- Optional bearer token validated in constant time, following the gateway
  pattern (`src/gateway/server.ts:96-115`).
- `GET`-only, no mutation endpoints; state comes from the lifecycle read model,
  whose in-memory snapshot is bounded (`src/core/lifecycle.ts:119-121`). The
  durable `lifecycle_events` log now backfills that snapshot after restart
  (`src/core/lifecycle.ts:78-84`; `src/store/sqlite.ts:128-163`), so the UI must
  treat persisted payloads as data to redact, not as a trusted display model.
- Response headers: `Content-Security-Policy` with no remote origins,
  `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. The gateway
  already sets the last two for authenticated responses (`src/gateway/server.ts:566,616-618`),
  but the UI is a separate listener and must set them itself.
- The snapshot must omit message bodies, spill bodies, outbox text, tokens,
  API keys, and peer secrets. The lifecycle bus is not an authorization
  boundary; it publishes whatever payload a caller supplies (`src/runtime.ts:714-716`).

Until that PR lands, no UI control above is shipped. The UI token being absent
by default is a residual risk, not a current implementation detail.

## 5. Worker/host isolation and credentials

- **Sandbox default-on and fail-closed.** Unless embedding explicitly disables
  it, worker bash is wrapped by `sandbox-exec` (Darwin) or `bwrap` (Linux); a
  missing wrapper is a hard error, never plain bash (`src/env/seccomp.ts:146-190,193-196`).
- **Write and network confinement.** Writes are limited to the worker workspace
  and temp roots; network is denied unless the policy allows it, and speculative
  commands always pass `allowNetwork: false` (`seccomp.ts:86-110,112-131,174-187`;
  `src/env/local-env.ts:107-122`).
- **Read isolation is opt-in.** `DS_AGENT_SANDBOX_READ_ISOLATION` accepts only
  `0/1/false/true/strict` and fails closed on any other value; the default keeps
  host-wide reads (`seccomp.ts:102-105,133-144,176-184`; `local-env.ts:22-27,62-68`).
  The project documents read confinement as an external/container boundary
  (`docs/safety.md:30-32`).
- **Time and environment bounds.** A timeout kills the whole process group, and
  stdout/stderr are capped and truncated (`local-env.ts:124-180`). The child gets
  a fixed allowlist; names matching key/token/secret/password/credential are
  dropped even if listed (`src/env/sanitize.ts:1,6-21,78-89`).
- **Redaction.** Exact parent-env secret values of at least 8 characters and
  known credential shapes are replaced before tool results, journal entries, or
  model requests (`sanitize.ts:4,27-35,43-76`; `local-env.ts:181-185,195-198`;
  `runtime.ts:252-255,659`). The credential-sentinel test is the offline evidence
  that a `DS_AGENT_API_KEY` value does not reach messages, tool results, spills,
  events, replies, outbox, logs, or model requests
  (`test/credential-sentinel.test.ts:97-152`). This is best-effort: an unknown
  secret shape, a value shorter than 8 characters, or a secret never present in
  the environment can still leak (`sanitize.ts:4,38-56`).
- **Vault boundary.** The vault exposes names only; values are injected into a
  child environment only and are never returned to context-building callers
  (`src/env/vault.ts:4-12,91-93`; `local-env.ts:69-74,200-213`). `FileVault`
  writes mode `0600` (`vault.ts:63-72`).
- **Worker tool scope.** Executor tools exclude `reply_user`, `decide`, and
  `receive`; only the Router can speak or terminate (`src/harness/tools.ts:299`).

External to this repo: host vault policy, seccomp/container policy, and the
decision to make read isolation the default (`docs/safety.md:32`;
`docs/PRODUCTION_PROGRAM.md:79,102`).

## 6. Mesh

- **Placement only.** `WorkerMeshRegistry` tracks node id, capacity, online
  state, and ticket assignment. It has no transport, identity proof, or
  authorization (`src/harness/mesh.ts:1-12,21-27,42-59`).
- **Identity and capacity.** The local node id is `DS_AGENT_INSTANCE_ID` or
  `local`; capacity defaults to 4; a duplicate node id is rejected
  (`src/runtime.ts:261-266`; `src/harness/mesh.ts:21-27`).
- **Fail-closed placement.** Unknown, offline, or full nodes yield no
  `pickNode` result, so the worker is queued; the in-process queue is bounded
  (default 100) and overflow is logged and rejected (`src/harness/mesh.ts:42-59`;
  `src/harness/loop.ts:48-56,68-72,169-172,209-214`; `src/runtime.ts:90,265-266`).
- **Unknown A2A target.** Local `route` is a no-op for an unregistered target,
  and `send` returns `unroutable` when no handler exists (`src/channels/a2a.ts:54-59,80-85`).
  An authenticated inbound A2A body becomes a non-human Trigger and passes the
  same ingress filter (`src/runtime.ts:506-515,857-876`).
- **Cross-host transport is not implemented.** The mesh comment states remote
  transport is outside this repo (`mesh.ts:8-12`), and the A2A transport contract
  leaves authentication to the HTTP adapter (`src/channels/a2a-transport.ts:1-45`).
  Cross-host mesh therefore depends on the now-merged A2A primitive but has no
  transport or listener of its own; do not advertise or expose it yet.

## 7. Residual risk register

Critical: none exposed by default. A2A HTTP is merged but no default listener is
wired, so exposure is operator-gated; the UI is not on `main`. Severity reflects
the risk once a listener or UI is enabled.

| Severity | Surface | Risk | Current mitigation | Owner/deployment action | Type |
|---|---|---|---|---|---|
| High | A2A HTTP | Cross-node replay when a peer secret is shared by verifier nodes | HMAC + ±60 s + per-process nonce cache; documented requirement to use unique per-node secrets or a shared cache (`a2a-auth.ts:15-25`) | Unique secret per verifier node and/or a shared durable replay store; never share one peer secret across nodes | Code + deployment |
| Medium | A2A HTTP | Unsigned response status/body; the peer is authenticated but the response is not bound to the request | Client requires TLS off-loopback, checks status, strict delivery shape, and envelope `from`/`to` (`a2a-http.ts:123-142,411-433,588-605`) | Keep TLS; sign responses or bind them to the request nonce if delivery status drives side effects | Code + deployment |
| High | Ingress/model | Prompt injection; deterministic fast/slow filters do not model malice, and model-backed slow-path admission is not shipped | Deterministic admission (`src/ingress/filter.ts:27-89`), non-human A2A identity (`src/runtime.ts:874`), redaction, sandbox, executor tool scope | Treat all trigger text as untrusted; design injection handling in the slow-path ADR before model admission; owner review | Code + operator |
| High | Model provider | Prompts and tool results leave the host; the provider may inspect or retain them | Best-effort redaction; optional gateway masking plugin (`src/gateway/server.ts:8,256-257`) | Choose a trusted provider and terms, minimize context, keep secrets out of prompts | Operator |
| Medium | Local state at rest | Same-uid/disk reader can read SQLite, journals, spills, outbox text, and durable lifecycle payloads; no DB encryption | `gateway.token`/vault `0600`; ACLs are in-process only (`src/gateway/token.ts:44-46`; `src/env/vault.ts:63-72`; `src/memory/acl.ts:22-41`) | `0700` state directory, full-disk encryption, separate OS user | Operator |
| Medium | A2A HTTP | Cache eviction or restart forgets a nonce inside the window | Bounded 10,000-entry cache with pruning | Shared/durable replay store; rate-limit unauthenticated traffic | Code |
| Medium | A2A HTTP | Plain-HTTP loopback trusts local processes; the handler opens no listener and cannot enforce inbound TLS | Client requires https off-loopback and refuses redirects (`a2a-http.ts:123-142,548-551`); loopback http is allowed (`a2a-http.ts:139-140`) | Bind loopback; terminate TLS at the listener or reverse proxy for any remote endpoint | Operator |
| Medium | Gateway | `/health` and dashboard are unauthenticated; non-loopback binding only warns | Loopback default and explicit warning (`src/cli/gateway.ts:13-27,39-40`; `src/gateway/server.ts:550-560`) | Bind loopback, firewall the port, never expose it directly | Operator |
| Medium | Gateway (plain HTTP loopback) | Bearer token and payloads cross plain HTTP if bound beyond loopback | Loopback default; no TLS in the server (`src/gateway/server.ts:616-627`) | TLS reverse proxy for any non-loopback bind | Operator |
| Medium | Worker | Read isolation is off by default, so a worker can read host files and the state DB | Write/network sandbox; opt-in strict reads (`src/env/seccomp.ts:133-144`; `docs/safety.md:30`) | Enable strict reads or a container profile; make the default flip a separate reviewed change | Operator + code |
| Medium | Planned UI | Token absent by default; read-only state is visible to local users/processes | Planned loopback-only, read-only, token-optional design (`docs/PRODUCTION_PROGRAM.md:61`) | Require a token when state is sensitive; loopback + OS permissions; review before merge | Code (UI PR) |
| Low | Redaction | Unknown secret shapes or values under 8 characters reach tool text/model context | Exact env values ≥8 chars plus known credential patterns (`src/env/sanitize.ts:4,43-76`) | Prefer vault injection, avoid pasting secrets, rotate on suspected exposure | Operator |
| Low | A2A HTTP | Secret lookup runs before signature verification, so arbitrary peer ids can trigger resolver calls | Shape/skew checked first; absolute deadline bounds a hanging lookup (`a2a-http.ts:256-263,293-321`) | Rate-limit at the reverse proxy | Operator |
| Low | A2A rotation | No key id means no dual-secret grace period | Small v1 protocol | Add `kid`/key version before fleet use | Code |

## 8. Incident and rotation runbook (sketch)

**Evidence rules.** Never log or attach secrets, signatures, or `Authorization`
headers; A2A errors are static by design (`a2a-auth.ts:66-75`;
`a2a-http.ts:401-407`). Preserve timestamps, redacted logs, and state copies;
record who changed which secret and when. Treat suspected exposure as compromise
first, investigate second.

**Rotate an A2A peer secret.** Generate a high-entropy replacement of at least
32 bytes (`a2a-auth.ts:38-42`). Because v1 has no key id, the peer and every
verifier node using that secret must cut over together: quiesce or accept a
brief 401 window, update `resolveSecret` on each verifier and the client,
restart/reload, verify new requests succeed and old ones fail, then destroy the
old secret. In a multi-node mesh, change every node before re-enabling the peer.

**Revoke a peer.** Remove it from `resolveSecret`; requests then fail 401 as an
unknown peer (`a2a-http.ts:310-321`). Confirm no new deliveries, preserve the
persisted `a2a` documents and event log, and rotate any secret it shared. Do not
delete evidence before review.

**Rotate the gateway token.** `gateway.token` is not auto-rotated; a stale empty
file fails closed and is an explicit operator action
(`docs/ARCHITECTURE_DECISIONS.md:191-246`; `src/gateway/token.ts:189-202`). Stop
the gateway and clients, inspect the file and metadata, deliberately remove it
(or start with a new explicit `--token`), restart to mint, update clients, and
verify the old token gets 401 (`src/gateway/server.ts:561-563`). Never script an
unconditional "if empty, delete" recovery.

**Planned UI token.** The UI is not shipped. When it lands, rotate its bearer
independently of the gateway token, keep the bind on loopback, and re-issue
rather than reuse a token copied into shell history or logs.

**Evidence to preserve.** Redacted logs (A2A delivery, ingress verdicts, outbox
failures), SQLite `events`, `documents`, `spills`/`spill_grants`, `messages`,
`replies`, `outbox`, and durable `lifecycle_events`
(`src/store/sqlite.ts:86-413`), any in-memory lifecycle snapshot, the
gateway usage ledger, and file metadata (path, owner, mode, inode/nlink) for
`gateway.token` and the vault — not their contents. If a provider may have
received data, preserve the exact redacted request context and notify the
provider/owner per policy.
