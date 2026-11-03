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
# prints the URL + token; saves <stateDir>/gateway.json and <stateDir>/gateway.token
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

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | no | provider status + cooldowns + metrics |
| GET | `/v1/models` | yes | model catalog + aliases |
| GET | `/v1/gateway/quotas` | yes | usage/quota snapshot |
| POST | `/v1/chat/completions` | yes | OpenAI chat, with failover |
| POST | `/v1/responses` | yes | OpenAI Responses (pass-through) |
| POST | `/v1/messages` | yes | Anthropic Messages (translated) |
| POST | `/v1/embeddings` | yes | embeddings (pass-through) |
| POST | `/v1beta/models/{model}:generateContent` | yes | Gemini, translated to chat |

## Plugins (gateway extension points)

Mirrors Magpie's gateway middleware + router-strategy plugins.

- **Privacy masking** (built-in `redact` plugin): set `DS_AGENT_GATEWAY_MASKING=1`. Secrets/personal data are replaced with stable `{{KIND_hash}}` placeholders before the request leaves this machine, and restored in the reply. While on, requests are buffered (stream replies become whole JSON) so nothing unmasked slips through.
- **Your own plugins**: drop `.mjs`/`.js` modules in `<stateDir>/gateway-plugins/`; `<stateDir>/gateway.plugins.json` (`{ "plugins": [{ "id": "x", "enabled": true, "options": {} }] }`) selects them.
- A plugin exports a default object: `{ id, onRequest?, onResponse?, strategies? }`. Hooks fail open (250 ms limit): a throw, a non-object return, or a timeout leaves the body as it was.
- `strategies` are router orders: `(seats, options) => number[]`. Select one per request with header `X-Gateway-Routing: <name>`. The built-in `rotation` plugin provides `priority` / `smart`.

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
- The gateway does not implement provider-specific subscription protocols
  (Cursor/Codex/Kiro). For those, supply your own token as above.
