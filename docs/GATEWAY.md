# Local model gateway

`src/gateway/` is a small TypeScript re-implementation of the "Magpie" role:
**one local OpenAI-compatible endpoint fronting several upstream providers**.
`ds-agent` (or any OpenAI SDK) can point at it and never talk to each provider
directly.

It is a **router**, not a credential harvester: every upstream key is one you
legitimately own and configure yourself (env or the project vault). It does not
scrape tokens from other apps, log into accounts, or bypass provider quotas.

## What it does

- OpenAI-compatible endpoints: `GET /v1/models`, `POST /v1/chat/completions`
  (JSON and SSE streaming), plus `GET /health`.
- **Multi-provider routing** by model, priority, and optional `provider/model`
  prefix.
- **Failover**: dead/5xx/429 upstream → next provider, with an exponential
  cooldown so a dead provider stops being hammered.
- **Local bearer token**: auto-generated (`gw_<random>`) and persisted
  `<stateDir>/gateway.token` with mode `0600`, so the agent can read it itself.
- **Metering**: per-provider requests / errors / latency / tokens.

## Configure providers

JSON array via `DS_AGENT_GATEWAY_PROVIDERS` (key can be inline or via an env var
name, never committed):

```bash
export DS_AGENT_GATEWAY_PROVIDERS='[
  {"id":"deepseek","baseUrl":"https://api.deepseek.com","apiKeyEnv":"DEEPSEEK_API_KEY","models":["deepseek-flash"],"priority":10},
  {"id":"magpie","baseUrl":"http://127.0.0.1:3425/v1","apiKey":"magpie","models":["workbuddy/deepseek-v4.1-flash"],"priority":1}
]'
```

With no JSON it falls back to a single provider from
`DS_AGENT_API_BASE` + `DS_AGENT_API_KEY` (+ optional `DS_AGENT_API_MODEL`), so it
can wrap the current upstream unchanged.

## Run it

```bash
DS_AGENT_GATEWAY_PROVIDERS=... pnpm ds-agent gateway --port 4319
# prints the URL + token; saves <stateDir>/gateway.json and <stateDir>/gateway.token
```

## Point ds-agent at it

```bash
export DS_AGENT_GATEWAY_URL=http://127.0.0.1:4319
# token is auto-read from DS_AGENT_GATEWAY_TOKEN or <stateDir>/gateway.token
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
| GET | `/v1/models` | yes | aggregated model catalog |
| POST | `/v1/chat/completions` | yes | routed upstream call with fallback |

## Notes / limits

- Metering is in-memory (per process); it is not persisted across restarts.
- Streaming is passed through byte-for-byte; failover only applies before the
  first byte is sent (a mid-stream failure cannot switch providers).
- Only `chat/completions` and `models` are implemented; embeddings/images are out
  of scope for now.
