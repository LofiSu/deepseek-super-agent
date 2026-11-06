# Local UI (read-only)

`ds-agent ui` is a read-only, token-gated window into persisted agent state. It
lets a person see what the agent is doing without holding a Session, opening a
model, or starting the daemon.

The UI is a library plus a wired command:

- `src/ui/server.ts` — `startUiServer()`, `buildSnapshot()`, token auth,
  Host/method/path guards, and the SSE stream.
- `src/ui/render.ts` — the server-rendered HTML page and escaping.
- `src/cli/ui.ts` — `runUi()` (process lifecycle and signals).
- `src/cli/main.ts` — dispatches `ds-agent ui` to `runUi(home, options)`.

## Status and command wiring

`ds-agent ui` is registered in `src/cli/main.ts` (PR #136) and covered by
`test/cli-ui.test.ts` plus `test/cli-command-wiring.test.ts`. The command is:

```text
DS_AGENT_UI_TOKEN=... ds-agent ui [--host 127.0.0.1] [--port 4318] [--token ...]
```

Prefer the environment variable over `--token`: argv is visible in process
listings. The token is required and must be at least 16 characters; startup
fails closed when neither `DS_AGENT_UI_TOKEN` nor `--token` supplies one. The
state home is resolved by the CLI from `DS_AGENT_HOME`, falling back to
`./.ds-agent`; there is no `--home` flag. The command forwards `--host`, `--port`
(validated), and `--token`; `runUi` keeps the loopback and token enforcement.

## Endpoints and auth

```text
GET /                 server-rendered HTML (inline CSS only)      auth required
GET /api/snapshot     JSON read model                             auth required
GET /api/events       text/event-stream, snapshot then every 2 s  auth required
GET /health           200 JSON {"ok":true}, no state              no auth
```

Every route except `GET /health` requires either
`Authorization: Bearer <token>` or the `ds_ui_token` cookie. The token is
compared in constant time over SHA-256 digests, and a missing or wrong token
gets a uniform `401 unauthorized` (including unknown paths, because auth runs
before routing).

For a browser, open the bootstrap URL once:

```text
http://127.0.0.1:4318/?token=<token>
```

It validates the token, sets
`Set-Cookie: ds_ui_token=<token>; HttpOnly; SameSite=Strict; Path=/`, and
`303`-redirects to `/`. The token is then gone from the address bar; the page
never contains it, and SSE uses the cookie. It does not appear in HTML, the SSE
URL, snapshots, or logs. A `GET /?token=` with a wrong token is a `401` and sets
no cookie; query tokens are accepted only for this bootstrap.

Command-line use:

```text
curl -H "Authorization: Bearer $DS_AGENT_UI_TOKEN" http://127.0.0.1:4318/api/snapshot
curl -H "Authorization: Bearer $DS_AGENT_UI_TOKEN" http://127.0.0.1:4318/api/events
```

## Read model

One function, `buildSnapshot()`, produces every view. It only includes visible
tickets (`speculative !== true`), and outbox rows whose `ticketId` is not in that
visible set are dropped. Outbox message bodies are never exposed; only routing
and delivery metadata is shown.

| Section | Fields |
|---------|--------|
| `tickets` | `id`, `title`, canonical `stage`, `ended`, `paused`, `createdAt` |
| `threads` | `key`, `subscriptions`, `pending` count, `deferred`, `lastAt` |
| `outbox` | visible tickets only: `id`, `ticketId`, `status`, `channel`, `thread`, `attempts`, `createdAt` |
| `health` | `healthProbe()` output: store health, vault mode, machines online, watchdog idle |
| `metrics` | the persisted Section 7 counters and model-latency summary |
| `events` | sanitized lifecycle events, whitelisted per kind (below) |

Lifecycle payloads are rebuilt instead of passed through: `ticket.created` →
`{ ticketId, speculative }`; `ticket.ended` → `{ ticketId, outcome, by, memoryId }`;
`ticket.paused` → `{ ticketId, at, by }`; `ticket.guidance` →
`{ ticketId, guidanceId, paused }`; `ticket.resumed` → `{ ticketId, pausedAt }`.
Unknown kinds are dropped, as is any event for a ticket outside the visible set
(including a speculative `ticket.created`). Raw titles, thread keys, and guidance
text in persisted payloads are never exposed.

Threads are the union of persisted Thread documents and the subscription table,
so a subscription is visible even before a Thread document exists. Tickets use
the canonical `ticketStage()` derivation, not a stale display field.

## Lifecycle

`runUi()` opens exactly one `Store` and one `Metrics`, starts the HTTP server,
and stays alive until `SIGINT` or `SIGTERM`. On the first signal it closes the
server and the Store. The signal handler is removed before shutdown, so a second
`SIGINT`/`SIGTERM` uses the process default termination (exit 130 for `SIGINT`,
143 for `SIGTERM`), not a forced exit 1. A Store that cannot be opened produces a
clear error and exit status 1 through the CLI error path. The UI never constructs
a model, never starts the daemon, and never writes ticket/thread/outbox domain
documents.

## Security model

- **Token required.** `startUiServer()` fails closed without a token of at least
  16 characters; `runUi()` resolves `DS_AGENT_UI_TOKEN` or `--token` before
  opening state.
- **Loopback only.** The server binds `127.0.0.1`; `startUiServer()` refuses a
  non-loopback host and `runUi()` rejects one before opening state.
- **Host guard.** Every request must carry a `Host` of `127.0.0.1` or
  `localhost` with no port or a numeric port, or a bracketed `[::1]` with no
  suffix or exactly `:<digits>`. Anything else (including `[::1]evil`) gets
  `403`. This blocks DNS-rebinding attempts; it is not authentication.
- **Read-only.** After auth, only `GET` is accepted. Other methods get `405`
  with `allow: GET`; unknown paths get `404`.
- **No external assets.** The page uses inline CSS and one inline SSE
  bootstrap. There are no CDN, font, image, or script URLs.
- **Headers.** Every response carries `cache-control: no-store` and
  `x-content-type-options: nosniff`. HTML adds:
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
  connect-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'`.
- **Escaping.** All user-controlled text (ticket titles, thread keys, lifecycle
  payloads) is HTML-escaped before rendering.
- **Timeouts and backpressure.** `headersTimeout` is 10 s, `requestTimeout`
  30 s, and `keepAliveTimeout` 5 s. If an SSE `write()` returns false, frame
  writes pause until the response emits `drain`; a client that stays blocked
  for more than five interval ticks is cleaned up and destroyed, so frames are
  never buffered without bound. A closed response is cleaned up immediately.

Access is gated by a shared token; there is no user account system and no remote
access. Do not put this server behind a proxy or expose the port beyond the
host, and do not log the token.

## Tests

`test/cli-ui.test.ts` seeds a temporary home with one visible ticket, one
speculative ticket, one thread subscription, a visible outbox row (with a secret
body) plus a speculative outbox row, and lifecycle events carrying secret
titles/reasons/guidance, then starts the server on `127.0.0.1:0`. It checks the
rendered page (escaped title, ticket/outbox metadata, no message body, no
speculative ticket, no speculative outbox row, no event secrets, no token, no
`http://`/`https://` references), the JSON read model with its whitelisted event
payloads, missing/wrong token `401`, `GET /health` without auth and with the
Store closed, the query-token → HttpOnly cookie → `303` flow (including
`referrer-policy: no-referrer`), `404`/`405` after auth, evil and malformed Host
values (`[::1]evil`, `[::1]:80x`, non-numeric ports) versus valid `[::1]:port`,
the SSE first frame and clean abort with no sentinels, SSE close on a throwing
read model, short/missing token rejection, loopback-only refusal, and a
child-process run proving the token is never logged and SIGTERM shuts down. No
model and no network are used.
