# Local model gateway

`src/gateway/` is a TypeScript re-implementation of the "Magpie" gateway role:
**one local endpoint that fronts several upstream providers**, for any client
that speaks OpenAI / Anthropic / Gemini style APIs. `ds-agent` (or any SDK) can
point at it and never talk to a provider directly.

It is a **router / protocol adapter**, not a credential harvester. Every
credential is one you legitimately own and configure yourself (env or the
project vault). It does **not** scrape tokens from other apps, log into
accounts, or bypass provider quotas.

## What it does

- **Multi-dialect endpoints**:
  - `GET  /v1/models` — model catalog + routing aliases
  - `POST /v1/chat/completions` — OpenAI chat (JSON + SSE streaming)
  - `POST /v1/responses` — OpenAI Responses (pass-through)
  - `POST /v1/messages` — Anthropic Messages (translated to chat and back)
  - `POST /v1/embeddings` — embeddings (pass-through)
  - `GET  /v1/gateway/quotas` — usage/quota snapshot
  - `GET  /health` — provider status + cooldowns + metrics (no auth)
- **Multi-provider routing** by model, priority, `provider/model` prefix, and
  named **routing aliases** (`auto` etc.).
- **Failover**: dead/5xx/429 upstream → next provider, with an exponential
  cooldown so a dead provider stops being hammered.
- **Multiple credentials per provider**, rotated round-robin, to spread rate
  limits.
- **Credential styles**: `bearer` (default), `x-api-key`, or a custom header —
  so subscription-style upstreams that accept a token you supply work too.
- **Local bearer token**: auto-generated (`gw_<random>`) and persisted
  `<stateDir>/gateway.token` with mode `0600`, so the agent reads it itself.
  The file is re-checked on every read and forced back to `0600`; if that fails
  the token is not used (fail closed). Symlinks, directories, and multiply
  hard-linked files are rejected instead of followed, so a writable state
  directory cannot redirect the token or `chmod` another file. The token is
  never printed or embedded in the dashboard.
- **Metering**: per-provider requests / errors / latency / tokens.

## Configure providers

JSON array via `DS_AGENT_GATEWAY_PROVIDERS`. Each entry can reference a built-in
`preset` (`deepseek`, `openai`, `openrouter`, `xai`, `moonshot`, `zhipu`,
`gemini`, `anthropic`) and pull the key from an env var — never committed:

```bash
export DS_AGENT_GATEWAY_PROVIDERS='[
  {"id":"deepseek","preset":"deepseek","apiKeyEnv":"DEEPSEEK_API_KEY","priority":10},
  {"id":"magpie","baseUrl":"http://127.0.0.1:3425/v1","apiKey":"magpie","models":["workbuddy/deepseek-v4.1-flash"],"priority":1},
  {"id":"acct","baseUrl":"https://some-subscription.example/v1","apiKeyEnv":"MY_SESSION_TOKEN","auth":"x-api-key","models":["their-model"]}
]'
```

Full entry fields: `id`, `preset`, `baseUrl`, `apiKey` / `apiKeyEnv` / `apiKeys`
(rotation), `auth` (`bearer` | `x-api-key` | `header` | `none`), `authHeader`,
`models`, `priority`, `headers`, `timeoutMs`.

With no JSON it falls back to a single provider from
`DS_AGENT_API_BASE` + `DS_AGENT_API_KEY` (+ optional `DS_AGENT_API_MODEL`), so it
can wrap the current upstream unchanged.

### Routing aliases

```bash
export DS_AGENT_GATEWAY_ALIASES='{"auto":["deepseek/deepseek-flash","magpie/workbuddy/deepseek-v4.1-flash"]}'
```

A request with `model: "auto"` tries the alias entries in order (with failover).
Aliases also show up in `GET /v1/models`.

## Bring your own subscription token (no scraping)

For an upstream that authenticates with a session token / cookie you already
hold, configure it explicitly — the gateway just forwards your credential:

```bash
export MY_SESSION_TOKEN='paste-your-own-token-here'   # or store it in the vault
export DS_AGENT_GATEWAY_PROVIDERS='[
  {"id":"acct","baseUrl":"https://provider.example/v1","apiKeyEnv":"MY_SESSION_TOKEN","auth":"header","authHeader":"cookie","models":["m"]}
]'
```

The gateway will **not** read browser cookies/keychain, auto-login, or claim
daily credits. You obtain and supply the token; you are responsible for
complying with each provider's terms.

## Run it

```bash
DS_AGENT_GATEWAY_PROVIDERS=... pnpm ds-agent gateway --port 4319
# prints the URL; saves <stateDir>/gateway.json and <stateDir>/gateway.token (mode 0600)
```

## Point ds-agent at it

```bash
export DS_AGENT_GATEWAY_URL=http://127.0.0.1:4319
# token auto-read from DS_AGENT_GATEWAY_TOKEN or <stateDir>/gateway.token
# model from DS_AGENT_GATEWAY_MODEL or DS_AGENT_API_MODEL (default "auto")
pnpm ds-agent chat "fix the login timeout"
```

`createModelFromEnv()` / `requireLiveModelFromEnv()` prefer the gateway whenever
`DS_AGENT_GATEWAY_URL` is set, and read the self-issued token automatically — no
manual key juggling.

If `<stateDir>/gateway.config.json` exists and `DS_AGENT_GATEWAY_URL` is unset,
`ds-agent chat` and `ds-agent imessage` start the gateway **in-process** on an
ephemeral port for the duration of the command — no separate `ds-agent gateway`
process is needed.

## Wiring agents and profiles

- `ds-agent wire <file> --set KEY=VALUE [--set ...] [--env]` merges gateway
  settings into any agent's config file (JSON, or `KEY=VALUE` env style), keeping
  unrelated keys and writing atomically. `--env` puts JSON values under `env`
  (Claude Code's `settings.json` shape).
- `ds-agent profile save <name>` snapshots `gateway.config.json`;
  `ds-agent profile use <name>` applies it; `profile list` / `profile rm` manage
  them (stored in `<stateDir>/gateway.profiles.json`).

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | no | provider status + cooldowns + metrics |
| GET | `/v1/models` | yes | model catalog + aliases |
| GET | `/v1/gateway/quotas` | yes | usage/quota snapshot |
| GET | `/v1/gateway/usage` | yes | per-call usage ledger (summary + recent) |
| GET | `/v1/gateway/sessions` | yes | usage aggregated by conversation id |
| GET | `/` or `/ui` | no | minimal read-only HTML dashboard |
| POST | `/v1/chat/completions` | yes | OpenAI chat, with failover |
| POST | `/v1/responses` | yes | OpenAI Responses (pass-through) |
| POST | `/v1/messages` | yes | Anthropic Messages (translated) |
| POST | `/v1/embeddings` | yes | embeddings (pass-through) |
| POST | `/v1beta/models/{model}:generateContent` | yes | Gemini, translated to chat |

## Security boundaries

- **Authentication**: every endpoint except `GET /health`, `GET /`, and
  `GET /ui` requires `Authorization: Bearer <token>`. The comparison is
  constant-time (`crypto.timingSafeEqual` after a length check), and a missing,
  malformed, or wrong header always gets the same `401` body — it never reaches
  an upstream provider.
- **Empty token**: the server refuses to start with an empty or whitespace-only
  token. Use the generated `<stateDir>/gateway.token` or pass `--token` /
  `DS_AGENT_GATEWAY_TOKEN`. A *stale* empty token file is a separate failing
  case; see [Token rotation and stale-token troubleshooting](#token-rotation-and-stale-token-troubleshooting).
- **Token file**: `<stateDir>/gateway.token` is re-checked on every read and
  re-applied as mode `0600` if it was loosened. If the file cannot be secured,
  the gateway fails closed instead of using it. The path must be a plain,
  singly-linked file opened with `O_NOFOLLOW`; symlinks and non-regular files
  are refused. Mode enforcement is POSIX-only — Windows has no POSIX mode bits,
  so the `0600` check is skipped there, while the plain-file checks still run.
- **Bind exposure**: the gateway listens on `127.0.0.1` by default. Passing a
  non-loopback `--host` / `DS_AGENT_GATEWAY_HOST` (for example `0.0.0.0`) prints
  an explicit warning: `/health` and the dashboard are **unauthenticated** in
  that mode, so only bind beyond loopback on a trusted, firewalled network.
- **Headers**: every response carries `X-Content-Type-Options: nosniff`;
  authenticated responses (including streaming replies) carry
  `Cache-Control: no-store`.
- **Dashboard**: `GET /` and `GET /ui` are read-only, fetch only `/health`, and
  never embed the bearer token or any credential.

## Token rotation and stale-token troubleshooting

The bearer token is generated once and persisted as `<stateDir>/gateway.token`
(mode `0600`). It is reused on every start; there is no automatic rotation.

### Current behavior when the token file is empty (fail closed)

A zero-length or whitespace-only token file is read as "no token", but the
exclusive create then refuses to overwrite the existing path. Startup aborts
before binding, with:

```
GatewayTokenFileError: gateway token file <stateDir>/gateway.token was created concurrently and is empty; refusing to use it
```

This is deliberate. The same shape can be a crashed first create, another
process still writing the file, or an attacker truncating it. Overwriting it
would erase evidence, could destroy a concurrent creator's token, and would
mint a valid-looking credential in place of a tamper signal
(`src/gateway/token.ts:110-116,140-146`). The file is not deleted, renamed,
truncated, or recreated, and its content and inode stay unchanged. The existing
mode check may tighten a loosened file to `0600` on POSIX before the empty
result is rejected; that is the standing security invariant, not recovery. The
server's empty-token guard (`src/gateway/server.ts:250-251`) is a second line of
defense.

The client read path also sees no token. An agent started with
`DS_AGENT_GATEWAY_URL` set can therefore fall back silently to another model
source (`src/harness/model.ts:264-265`), so recovery must include restarting
clients, not just the gateway.

### Recommended operator action (ADR-009)

[ADR-009](ARCHITECTURE_DECISIONS.md#adr-009--a-stale-empty-gateway-token-file-fails-closed-and-is-recovered-only-by-explicit-operator-action)
keeps this fail-closed and makes recovery an explicit decision:

1. Stop the gateway and every agent using it.
2. Inspect, do not overwrite:
   `ls -l <stateDir>/gateway.token` and `stat <stateDir>/gateway.token`.
   Confirm it is a regular, singly-linked file owned by the intended user with
   mode `0600`, and that the state directory is not group/world-writable.
3. If the empty file is expected (for example, a crash during first create, with
   no tamper indicators), remove it explicitly:
   `rm -- <stateDir>/gateway.token`, then restart the gateway (or let `chat` /
   `imessage` start the embedded gateway). A new `gw_<random>` token is written
   with mode `0600`.
4. If the truncation is unexpected, treat it as a tamper signal: preserve a
   copy, investigate, and rotate any upstream credentials before minting a new
   local token. Do not script unconditional deletion of empty token files.
5. To start without touching the file, pass `--token` or set
   `DS_AGENT_GATEWAY_TOKEN`. An explicit token wins and is not persisted
   (`src/gateway/token.ts:162-163`); every client must then be configured with
   it explicitly.

After recovery or rotation, restart clients (or update
`DS_AGENT_GATEWAY_TOKEN`): a running gateway and a client holding the old token
will get `401`.

### Rotation

Today rotation is the same manual operation: stop the processes, remove
`<stateDir>/gateway.token` deliberately, restart, and restart clients with the
new token. A future `--rotate-token` flag would be an explicit opt-in, not a
default (ADR-009 follow-up).

## Plugins (gateway extension points)

Mirrors Magpie's gateway middleware + router-strategy plugins.

- **Privacy masking** (built-in `redact` plugin): set `DS_AGENT_GATEWAY_MASKING=1` or `"masking": true` in `gateway.config.json`. Secrets/personal data are replaced with stable `{{KIND_hash}}` placeholders before the request leaves this machine, and restored in the reply. Streaming replies are unmasked per SSE event; whole replies are restored as-is.
- **Your own plugins**: drop `.mjs`/`.js` modules in `<stateDir>/gateway-plugins/`; `<stateDir>/gateway.plugins.json` (`{ "plugins": [{ "id": "x", "enabled": true, "options": {} }] }`) selects them.
- A plugin exports a default object: `{ id, onRequest?, onResponse?, strategies? }`. Hooks fail open (250 ms limit): a throw, a non-object return, or a timeout leaves the body as it was.
- `strategies` are router orders: `(seats, options) => number[]`. Select one per request with header `X-Gateway-Routing: <name>`. The built-in `rotation` plugin provides `priority` / `smart` / `usage` (least-used first) / `free` (cheapest by provider `cost`) / `fast` (lowest observed latency) / `pace` (most allowance headroom first).

```js
// <stateDir>/gateway-plugins/example.mjs
export default {
  id: 'example',
  onRequest(body) { return body },                 // transform the agent's request
  onResponse(body) { return body },                // transform a whole reply
  strategies: { reverse: seats => seats.map(s => s.index).reverse() },
}
```

## Notes / limits

- Metering is in-memory (per process); it is not persisted across restarts.
- Streaming is passed through byte-for-byte; failover only applies before the
  first byte is sent (a mid-stream failure cannot switch providers).
- `/v1/messages` translation covers text messages + system + basic params; tools,
  images, and thinking blocks are not translated yet.
- `/v1/responses` is a pass-through to the upstream's `/responses`; it does not
  translate to chat for providers that only speak chat.
- Per-provider `maxConcurrency`, `maxRpm` and `dailyTokens` enforce concurrency lanes, a rolling 60s RPM window and a soft daily token budget; a saturated provider is skipped and the request gets `429` with `Retry-After`. `/v1/gateway/quotas` reports in-flight / rpm used / tokens today / exhausted per provider.
- A provider answering `429` or `402` (quota/balance) is rested for 60s in-process, then retried; a spent `dailyTokens` budget rests it until the next UTC midnight.
- The gateway does not implement provider-specific subscription protocols
  (Cursor/Codex/Kiro). For those, supply your own token as above.
