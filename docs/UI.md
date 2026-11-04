# Local UI (read-only)

`ds-agent ui` is a read-only window into persisted agent state. It lets a person
see what the agent is doing without holding a Session, opening a model, or
starting the daemon.

The UI is currently a library plus a command implementation:

- `src/ui/server.ts` — `startUiServer()`, `buildSnapshot()`, Host/method/path
  guards, and the SSE stream.
- `src/ui/render.ts` — the server-rendered HTML page and escaping.
- `src/cli/ui.ts` — `runUi()` (process lifecycle and signals) and `registerUi()`
  (the hook for CLI wiring).

## Status and command wiring

Command registration in `src/cli/main.ts` is intentionally a follow-up wiring PR
after the MODEL-SLOW-PATH branch (which owns that file) merges. Until then, the
behavior is available through `runUi()` directly and is fully covered by
`test/cli-ui.test.ts`. The intended command is:

```text
ds-agent ui [--port 4318] [--home <dir>]
```

`runUi` reads `--port` from the process arguments when no explicit port is
passed, and the caller supplies the state home. The follow-up PR only needs to
dispatch `ui` to `runUi(home)` (or call `registerUi`) and add a help line.

## Read model

One function, `buildSnapshot()`, produces every view:

```text
GET /                 server-rendered HTML (inline CSS only)
GET /api/snapshot     JSON read model
GET /api/events       text/event-stream; one snapshot immediately, then every 2 s
```

The snapshot contains:

| Section | Fields |
|---------|--------|
| `tickets` | `id`, `title`, canonical `stage`, `ended`, `paused`, `createdAt` |
| `threads` | `key`, `subscriptions`, `pending` count, `deferred`, `lastAt` |
| `outbox` | `id`, `ticketId`, `status`, `channel`, `thread`, `attempts`, `createdAt`, `text` |
| `health` | `healthProbe()` output: store health, vault mode, machines online, watchdog idle |
| `metrics` | the persisted Section 7 counters and model-latency summary |
| `events` | the newest lifecycle events in publish order |

Threads are the union of persisted Thread documents and the subscription table,
so a subscription is visible even before a Thread document exists. Tickets use
the canonical `ticketStage()` derivation, not a stale display field.

## Lifecycle

`runUi()` opens exactly one `Store` and one `Metrics`, starts the HTTP server,
and stays alive until `SIGINT` or `SIGTERM`. On a signal it closes the server and
the Store; a second signal force-exits 1 if the graceful close is stuck. A
Store that cannot be opened produces a clear error and exit status 1 through the
CLI error path. The UI never constructs a model, never starts the daemon, and
never writes ticket/thread/outbox domain documents.

## Security model

- **Loopback only.** The server binds `127.0.0.1`; `startUiServer()` refuses a
  non-loopback host and `runUi()` rejects one before opening state.
- **Host guard.** Every request must carry a `Host` of `127.0.0.1`,
  `localhost`, or `::1` (optionally with a port). Anything else gets `403`.
  This blocks DNS-rebinding attempts; it is not authentication.
- **Read-only.** Only `GET` is accepted. Other methods get `405` with
  `allow: GET`. Unknown paths get `404`.
- **No external assets.** The page uses inline CSS and one inline SSE
  bootstrap. There are no CDN, font, image, or script URLs.
- **Headers.** Every response carries `cache-control: no-store` and
  `x-content-type-options: nosniff`. HTML adds:
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
  connect-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'`.
- **Escaping.** All user-controlled text (ticket titles, outbox text, thread
  keys, lifecycle payloads) is HTML-escaped before rendering.

There is no login and no remote access. Do not put this server behind a proxy or
expose the port beyond the host; that would be a new security decision.

## Tests

`test/cli-ui.test.ts` seeds a temporary home with one ticket, one thread
subscription, one outbox row, and one lifecycle event, then starts the server on
`127.0.0.1:0`. It checks the rendered page (escaped title, ticket/outbox rows,
no `http://` or `https://` references), the JSON read model, `404`, `405` with
`allow: GET`, the evil-Host `403`, the SSE first frame and clean abort, and the
loopback-only refusal. No model and no network are used.
