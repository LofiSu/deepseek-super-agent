# Google Workspace connectors and the connector index

Status: **code implemented, offline tests passing, real Google account not
accepted.** This document describes the M6/M10 boundary this repository added
for the seven Google Workspace products that the public Instinct privacy policy
names. It is not a claim of parity with Instinct's private internals, and it
does not include Slack, Notion, or any other connector.

## What is implemented

- Read-only mappings for `calendar`, `gmail`, `drive`, `docs`, `sheets`,
  `slides`, and `tasks` in `src/connectors/google.ts`.
- An owner-gated `connectors.json` in the agent home. A missing or blank file
  means the whole feature is off. A malformed file fails at startup.
- A separate connector index (`src/connectors/index-store.ts`) stored under the
  `connector` document kind. Indexing never writes an `ltm` row and never
  requires a reader ticket.
- Connector/event wake (`src/connectors/wake.ts`) driven by the existing Daemon
  pulse. It calls `Runtime.ingest`; it does not add a timer, a second agent
  loop, or a Worker. A connector wake ticket is a one-turn Router envelope.
- An offline query surface: `pnpm ds-agent connectors status` and
  `pnpm ds-agent connectors query "text"`.

## Enable

Create `connectors.json` in the agent home (for the default CLI home,
`.ds-agent/connectors.json`):

```json
{
  "enabled": true,
  "google": {
    "services": ["calendar", "gmail", "drive", "docs", "sheets", "slides", "tasks"],
    "credentialsEnv": "GOOGLE_WORKSPACE_CREDENTIALS"
  },
  "poll": {
    "intervalMinutes": 15,
    "maxRecordsPerPoll": 25
  },
  "index": {
    "maxRecords": 5000,
    "maxAgeDays": 180
  },
  "wake": {
    "enabled": true,
    "services": ["gmail", "calendar", "docs"],
    "source": "im",
    "thread": "oc_your_private_chat",
    "chatId": "oc_your_private_chat",
    "minIntervalMinutes": 120,
    "maxPerDay": 3,
    "lookbackMinutes": 120,
    "calendarLookaheadMinutes": 120
  }
}
```

`wake.source` is one of `cli`, `im`, or `imessage`. `wake.thread` must name an
existing private thread that already admitted a human message. For Feishu,
`wake.chatId` (or `FEISHU_CHAT_ID`) must match the chat. The feature never
invents a new recipient.

The credential value is JSON in the environment variable named by
`credentialsEnv`, or in the file named by `credentialsFile` (relative paths
resolve against the agent home):

```json
{
  "clientId": "…",
  "clientSecret": "…",
  "refreshToken": "…"
}
```

The refresh token must carry read-only scopes for the services you enable. The
adapter exchanges it at the public OAuth token endpoint and never writes to
Google. Do not put credentials in `connectors.json`.

Missing credentials with `"enabled": true` fail at startup. A disabled config
does not read the credential source at all.

## Query the index

```bash
pnpm ds-agent connectors status
pnpm ds-agent connectors status --json
pnpm ds-agent connectors query "invoice"
pnpm ds-agent connectors query "design review" --service calendar --limit 5
pnpm ds-agent connectors query --wake-only --json
```

Queries are lexical and deterministic. They do not call a model or the network.
The index is bounded by `index.maxRecords` and `index.maxAgeDays`; `0` disables
that dimension, matching the long-term-memory retention convention.

## Wake behavior

The first poll after startup is a backfill: it indexes records and never wakes.
Later rounds may turn at most one record into a normal Trigger when:

1. the provider marked the record useful (unread important mail, an imminent
   calendar event, a shared document changed by someone else, or a task due
   soon);
2. the service is listed in `wake.services`;
3. the existing `proactive.json` quiet-hours window is not active;
4. `minIntervalMinutes` and `maxPerDay` allow it;
5. an already-admitted private target thread exists;
6. `DS_AGENT_DROP_SELF`, `DS_AGENT_ACTOR_ALLOWLIST`, and
   `DS_AGENT_GROUP_ALLOWLIST` do not deny the trigger.

The Trigger text contains one concrete fact and an explicit instruction to stay
silent if it is not useful. The Router prompt and reply path also suppress the
canned acknowledgement. Irreversible actions still go through the existing
approval state machine; this feature adds no bypass.

The wake state (cursors, last wake, notified revisions, and unresolved original
pending payloads) is persisted under the `connector_wake` document kind. For an
imminent Calendar event, `calendarLookaheadMinutes` is checked again as the
current admission window after restart or configuration change, together with
the inclusive 15-minute grace after the event starts. A pending event outside
the current lookahead remains stored with its original identity and provider
facts; each pulse rechecks it, and widening the lookahead can admit it sooner.
The expiry policy retires it only after the 15-minute grace has passed. Such a
future event does not block other eligible connector sources or count as a
successful wake.

Each retry also rechecks current wake/service enablement, quiet hours, actor and
group admission, wake caps, minimum interval, and the existing private target.
An explicitly changed or revoked private target retains the existing retirement
behavior. Uncertain Calendar provenance and incomplete Intake recovery remain
isolated until trusted repair; the lookahead change does not infer facts or
routing from the mutable index or current subscriptions. Recovery is supported
for one scheduler/runtime using the Store's durable state; concurrent
multi-runtime writers are not covered by this contract.

## Boundaries

- No Slack, Notion, WhatsApp, SMS, hosted email, cloud browser, vault, payment,
  or booking action is added here.
- No OAuth consent flow is implemented in this repository. The owner supplies a
  refresh token. Real Google account acceptance, including consent-screen and
  scope review, remains with the owner.
- The first real send after a connector wake still uses the existing channel
  and outbox, and has not been accepted against a live Google account in this
  change.
