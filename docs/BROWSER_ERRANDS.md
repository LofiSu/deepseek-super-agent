# Browser errands

Status: **PR-only** on `feat/instinct-browser-errands`, not merged to `main`.
This is ds-agent's own browser-errand adapter. It is **not** Instinct's leased
cloud browser, it does not replay Instinct prompts or control flow, and it does
not create a hosted browser session. It is one clearly labeled equivalent: an
owner-configured local command or remote HTTP endpoint that speaks ds-agent's
own protocol.

The adapter is **off by default**. Missing configuration registers no browser
tool at all. A malformed `browser-errands.json`, a missing executable, or a
missing token environment name fails at startup instead of leaving a
half-working capability.

## Configure

Create `browser-errands.json` in the agent home (`$DS_AGENT_HOME`, by default
`~/.ds-agent`). The file wins over `DS_AGENT_BROWSER_ERRANDS`; an empty file
also disables the environment seed.

### Local command driver

```json
{
  "enabled": true,
  "driver": {
    "kind": "command",
    "command": "/usr/local/bin/ds-agent-browser-driver",
    "args": [],
    "env": ["BROWSER_PROFILE_DIR"],
    "timeoutMs": 30000
  },
  "allowedHosts": ["example.com", "*.example.org"],
  "maxReadChars": 20000,
  "maxExtractItems": 50
}
```

`command` is an absolute path, a `~/` path, or a bare executable name resolved
on `PATH` when the Runtime starts. It is never a shell string, and the model
never supplies it. Only `ENV_ALLOWLIST` names plus the listed `env` names are
copied into the child process. Each action starts the configured command with
argv, sends one JSON request on stdin, and reads one JSON envelope from stdout.
A stateful driver receives the Worker session id and persists page state
itself; the adapter starts no long-lived browser process.

### Remote HTTP driver

```json
{
  "enabled": true,
  "driver": {
    "kind": "http",
    "url": "https://browser.example.net/errand",
    "tokenEnv": "DS_AGENT_BROWSER_TOKEN",
    "timeoutMs": 30000
  },
  "allowedHosts": ["example.com"]
}
```

The URL must be `https`, or `http` on a loopback host for local development.
Credentials in the URL are rejected; a bearer token is read from `tokenEnv` at
startup. Redirects are not followed, so the endpoint the owner configured
cannot bounce the request elsewhere. The endpoint is still an external service
chosen by the owner; this repository ships no hosted browser.

## Protocol

Request (stdin for `command`, JSON body for `http`):

```json
{
  "protocol": "ds-agent-browser-errand/v1",
  "action": "navigate",
  "session": "worker_ticket_123",
  "url": "https://example.com/page"
}
```

Response:

```json
{ "ok": true, "result": { "url": "https://example.com/page", "title": "Example" } }
```

or

```json
{ "ok": false, "error": "one line" }
```

Actions and required result fields:

| Action | Request fields | Result fields |
|---|---|---|
| `navigate` | `url` | `url` (required, post-action location), optional `title` |
| `read` | — | `url` (required, current location), `text` (bounded by `maxReadChars`) |
| `fill` | `fields`: `[{selector,value}]`, `allowedHosts` (owner-supplied) | `url` (required, current location), `filled` (integer) |
| `extract` | optional `selector` | `url` (required, current location), `items`: strings (bounded by `maxExtractItems`) |

Every action must report its post-action page URL. The adapter checks it against
the owner allowlist, so a missing URL or a redirect to another host fails closed
and blocks that Worker session for the rest of the Runtime. A session accepts
only one in-flight action, preventing concurrent navigation and field entry.
As part of the same `fill` operation, immediately before applying any values,
the driver must check the active page URL against the request's owner-supplied
`allowedHosts`. If it is outside the list, the driver must refuse and leave every
field untouched. This precheck prevents delayed redirects from receiving form
data; the adapter's post-action check is additional.
Driver failures block the session because its page location is then unknown.
The driver may return extra keys on `result`; the adapter ignores them. Invalid
shapes fail the tool call instead of reaching the model.

## Tools and boundaries

When enabled, Workers get exactly four tools:

- `browser_navigate` — open an allowed absolute http(s) URL.
- `browser_read` — bounded visible text of the current page.
- `browser_fill` — fill form fields; it never submits, clicks, or confirms.
- `browser_extract` — bounded text items, optionally under one CSS selector.

The Router and Watchdog never get these tools. Every call needs a live Ticket,
so browser work is not a second agent loop: it runs inside the existing
Worker/Harness path.

- **No irreversible actions.** The adapter refuses `submit`, `purchase`,
  `send`, `delete`, and `change_account_settings` even if a caller casts around
  the typed API. There is no `browser_submit` tool. Such a step remains behind
  the existing `request_approval` hold, and D1 v1 has no execution path for it.
  The model cannot self-approve; only the owner's CLI decision does that.
- **Read-only behind speculation.** A speculative Worker may navigate, read,
  and extract, but `browser_fill` is refused because it changes remote page
  state.
- **Host allowlist.** `allowedHosts` is a pre-navigation check. An exact host
  matches itself; `*.example.org` matches subdomains but not the apex. The
  check is not a network firewall and does not inspect redirects performed
  inside the driver.
- **No saved logins.** ds-agent has no credential vault on this path. The
  adapter does not claim the owner is signed in anywhere. If a driver maintains
  its own browser profile, that store belongs to the driver, not ds-agent.
- **Bounded.** Output is capped, read/extract results are clamped, timeouts
  kill the process group, and at most two driver calls run concurrently.
  Runtime shutdown kills in-flight driver children.

## Enable and verify

```bash
# 1. Write browser-errands.json in the agent home with "enabled": true.
# 2. Start the normal runtime; a bad file or missing executable fails here.
pnpm ds-agent status

# Focused offline suite (uses a fake driver; no real browser):
pnpm vitest run test/browser-errands.test.ts
```

## Limits

- No hosted/leased cloud browser and no real-site acceptance. The command and
  HTTP drivers are exercised with fakes and a loopback test server.
- No navigation state is held by ds-agent; the driver is responsible for
  session-keyed page state.
- No credential vault, saved logins, payment, or approval-card UI is added
  here.
