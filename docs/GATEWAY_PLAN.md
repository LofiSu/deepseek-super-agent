# Gateway parity plan

Goal: bring the in-repo gateway (`src/gateway/`) to functional parity with
[magpie](https://github.com/yetone/magpie) (MIT, Go, ~984k LOC, 83 packages),
as TypeScript — so users don't need to install Magpie.

**Non-goal:** the subscription-account relays Magpie itself retired
(cursor / kiro / workbuddy / …). Those were moved to community OpenCode plugins
because using them can break vendors' terms. We do not reimplement credential
scraping or quota bypass.

## Subsystem map (Magpie → this repo)

| Magpie subsystem | This repo | Status |
|---|---|---|
| Gateway HTTP surface (Chat/Responses/Messages/Gemini) | `server.ts` | chat / responses / messages / embeddings / **Gemini** done |
| Protocol translation | `server.ts` (anthropic↔chat, gemini↔chat) | text + basic params done; tools/vision/thinking pending |
| Provider presets + custom URL | `config.ts`, `config-file.ts`, `harness/providers.ts` | done (presets, apiKeyEnv, auth styles, multi-key) |
| Model catalog + routing aliases (`auto/*`) | `router.ts`, `config.ts` | done |
| Routing strategies (smart/order/rotate/usage/pace/weight/free/fast/drain/cheap) | `builtin-plugins.ts`, `plugins.ts` | `priority`/`smart` done; others via plugins — usage/pace/free/fast pending core data |
| Failover on failure/429 + cooldown | `router.ts`, `server.ts` | done |
| Allowance-aware failover (quota/balance/402) | `server.ts`, `limits.ts` | done |
| Concurrency lanes + RPM limits | `limits.ts` | done |
| Privacy masking | `mask.ts` (plugin `redact`) | done (buffered and streaming) |
| Gateway middleware / strategies as plugins | `plugins.ts` (`gateway-plugins/*.mjs`) | done (onRequest/onResponse/strategies) |
| Usage/price ledger | `usage.ts` | usage done; price/cost pending |
| Session aggregation + affinity | `usage.ts`, `affinity.ts` | done |
| Agent config wiring (write model back to each agent) | `wiring.ts`, `profiles.ts` | done |
| Profiles, Library, MCP router, GUI/TUI/web | `profiles.ts`, `web.ts` | profiles + web done; Library/MCP/TUI out of near-term scope |
| Subscription account brokers (Cursor/Kiro/WorkBuddy) | — | **non-goal** |

## Milestones

### HTTP parity and controls
- [x] Plugin runtime: `onRequest` / `onResponse` / `strategies`; fail-open + 250ms.
- [x] Privacy masking plugin (`redact`), `DS_AGENT_GATEWAY_MASKING=1`.
- [x] Router strategies as plugins (`rotation`: `priority` / `smart`); `X-Gateway-Routing`.
- [x] Gemini `generateContent` dialect.
- [x] Allowance-aware failover: 402/429 rest a provider; `dailyTokens` budget exhaustion rests it.
- [x] Concurrency lanes (`maxConcurrency`) + RPM (`maxRpm`); saturated → 429 with Retry-After.
- [x] `/v1/gateway/quotas` reports in-flight, rpm used, tokens today, exhausted.
- [x] Streaming masking (SSE events unmasked per line; no longer buffered).

### Usage ledger and session affinity
- [x] Per-call usage ledger (provider/model, status, latency, tokens) + `onUsage` plugin hook + `/v1/gateway/usage`. (Price/cost still pending.)
- [x] Session aggregation by conversation id (`/v1/gateway/sessions`; id from `X-Gateway-Session` / `X-Conversation-ID`, else hash of the first user message).
- [x] Affinity: a conversation stays on the provider that answered it (in-process, bounded).
- [x] Routing strategies `usage` / `free` / `fast` / `pace` over real data (requests, cost, latency, tokens).

### Wiring and shell
- [x] Agent config wiring (generic JSON/env merge via `ds-agent wire`) + profiles (`ds-agent profile`). Per-agent presets are a future nicety.
- [x] `ds-agent gateway` embedded mode (auto-start in-process for chat/imessage when a config file exists).
- [x] Minimal web dashboard at `GET /`; TUI deferred (optional).

## Definition of done
`pnpm typecheck` clean; gateway tests green; a request with `X-Gateway-Routing`
selects a plugin strategy; masking round-trips; Gemini works; concurrency/RPM
limits return 429 with `Retry-After` when a provider is saturated; quota data
visible at `/v1/gateway/quotas`.

## Verification
```bash
pnpm typecheck
pnpm exec vitest run test/gateway*.test.ts test/channels-imessage.test.ts
```
