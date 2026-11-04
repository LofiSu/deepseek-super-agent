# Competitive gap: Instinct, Muse, and Grok Bot

> Living document. Last audited 2026-11-05 against `main` after #144, #145,
> #146, and #147. This is a structural comparison, not a claim about production prompts:
> none of the three products publishes its full prompt or internals. Muse is
> known from its leaked agent workspace, Instinct from the Open Instinct
> implementation, and Grok Bot from its public instruction and approval model.

The goal is not to copy wording. It is to close the capability and feel gaps
that make a personal agent worth talking to and worth delegating work to.

## Scorecard

| Dimension | Instinct / Open Instinct | Muse | Grok Bot | ds-agent now | Verdict |
|---|---|---|---|---|---|
| **Prompt stack** | Rebuilt each run: identity, instructions, owner, principal, channel, reach, setup, rules, memory, skills, approvals, long tasks, now | One long prompt plus injected workspace files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, `TOOLS.md`, `HEARTBEAT.md`, `PROACTIVE_PREFERENCES.md`) | Persistent Bot instructions plus skills, routines, integrations, memory | 11 stable layers + 5 turn layers; owner files `PERSONA.md` / `AGENTS.md` / `USER.md`; `ds-agent prompt --layers` | **Parity on structure**, still behind on per-principal and skills layers |
| **Voice / personality** | `PERSONA.md`, owner-owned, about 30 lines | `SOUL.md` + `IDENTITY.md`, written and refined by the agent and owner | Bot instructions, editable | Warm identity + `PERSONA.md` + concrete voice examples (v2) | **Parity on intent**; needs real conversation evaluation, not just prompt shape |
| **Owner model** | Principal tiers: owner, staff, partner, family, friend, contact, stranger | Single owner; other people are not principals | One owner | Single owner; ingress trust separates owner from group/other | **Behind** on tiers; ahead on a strict default-deny ingress |
| **Local specialist agents** | Skills and subagents; MCP tools | Subagents and tools | Skills, routines, integrations | `delegate_agent` to owner-configured local CLIs; Workers only; no shell; bounded | **Newly at parity**, with a narrower trust surface than Muse/Instinct connectors |
| **Subagents / team** | Subagent prompts get the shared frame plus a role | Subagents | Routines and skills | Router/Worker split, Worker-internal teams, persisted jobs, aggregate report | **Parity** for execution topology |
| **Memory** | `MEMORY.md` + daily journal; bounded digest every turn | `MEMORY.md` + memory search/explain tools; strict write rules | Bot memory | Typed refs, `read_object` chain of recall, lexical recall, hot/cold retention, cold Thread digests, per-hop ACL | **Ahead on safety and provenance**, **behind on semantic recall and an owner-editable daily journal** |
| **Skills** | `skills/` with `SKILL.md`; loaded on demand | Tools and workspace files | Skills | `skills/<id>/SKILL.md` index in the prompt; `read_skill` loads the body | **Parity on the core loop**; no bundled starter set yet |
| **Proactivity / routines** | Scheduled etiquette and routines | `HEARTBEAT.md`, `PROACTIVE_PREFERENCES.md`, scheduling | Routines | Watchdog timer and speculative assignments; no owner-defined recurring routines | **Partial**; the proactive loop exists, the owner-facing scheduler does not |
| **Channels** | Texting, email, A2A, chat | App / channel surfaces | Bot connectors | CLI, iMessage, Feishu, GitHub, A2A, OpenAI-compatible gateway, loopback UI | **Ahead in one runtime**, **behind on email, browser, calendar, payments** |
| **Approvals** | Dedicated approvals layer | Safety policy | Approval before send, publish, delete, spend | Prompt boundary plus Engine pause/intervene/resume; no interactive approval card or token | **Partial**; the state machine exists, the owner-facing approval flow does not |
| **Observability** | Layer inspection, logs | Workspace files are visible | Bot editor | Lifecycle bus, read-only token-gated UI, metrics, health, session journals, offline CLI inspection | **Ahead** |
| **Safety / sandbox** | Rules layer, approvals | Safety and security policy last | Approval gates | Default-on fail-closed OS sandbox for bash, env allowlist, secret redaction sentinel, spill ACL, opt-in strict read isolation | **Ahead for its scope**; specialist CLIs and host reads remain trust boundaries |
| **Self-improvement** | Editable persona, skills, memory, policy | Agent rewrites its workspace files | Instructions editor | Deterministic eval suite, metrics, review-driven fixes; no built-in reflection loop | **Behind on productized RSI**; ahead on repeatable offline verification |

Legend: **Ahead** means a concrete capability the others do not document;
**Parity** means the same job with a different design; **Partial** means the
foundation exists but the owner-facing surface is missing; **Missing** means no
implementation.

## Where ds-agent is already ahead

- **One runtime, many channels.** The same Engine, Store, Threads, Tickets, and
  Router serve IM, GitHub, A2A, CLI, and the gateway. Muse and Grok Bot are
  product surfaces; Instinct is closer, but ds-agent keeps the channel adapters
  behind one domain model.
- **Deterministic offline verification.** The full suite runs without a live
  model. That makes every gap fix testable in CI, which is the precondition for
  fast self-iteration.
- **Memory with provenance and ACL.** Every recalled object has a typed handle,
  and every hop re-checks the reader's Thread. A handle is not a capability.
  This is stronger than a flat `MEMORY.md` injection.
- **A real sandbox for Worker bash.** `sandbox-exec` / `bwrap` default-on and
  fail-closed, an environment allowlist, and a credential sentinel test.
- **Operator controls.** Pause, intervene, resume, handback, watchdog fail, and
  backup/restore are implemented, not just described.
- **Delegation without shell interpolation.** `delegate_agent` takes a task as
  one argv entry; command, cwd, env, timeout, and output cap are owner-owned.

## Where the gap is real

1. **Skills.** The core loop now exists: an owner adds
   `skills/<id>/SKILL.md`, the prompt carries a bounded index, and `read_skill`
   loads the body. What is still missing is a bundled starter set, an
   owner-facing editor, and any way for a skill to declare which existing tool
   it expects. A skill still cannot grant a tool.
2. **Owner-defined routines.** The daemon can watch and speculate, but the owner
   cannot say "every weekday at 8, check the deploy and tell me only if it is
   red." This is Muse's `HEARTBEAT.md` and Grok Bot's routines.
3. **Interactive approvals.** The rules layer says what needs approval and the
   Engine can pause a ticket, but there is no first-class "ask the owner, wait,
   approve/deny, resume with an audit trail" flow for a specific action.
4. **Semantic memory.** Recall is lexical plus one tag hop. Instinct and Muse
   have richer memory surfaces. An `EmbeddingPort` with a deterministic mock
   keeps CI offline while allowing a provider at runtime.
5. **Principal tiers.** ds-agent is owner-only by design. Group participants are
   not principals. Instinct's tier model is the reference if ds-agent ever
   supports staff or family.
6. **Connectors.** No email, browser, calendar, or payment adapters. These are
   the difference between "can operate a repo" and "can run errands."
7. **Self-improvement as a product.** Tests and review catch regressions, but
   the agent does not maintain a living gap list, evaluate its own recent
   conversations, or propose the next improvement. This document is the first
   step; the next is a repeatable review-and-score loop.

## Next sequence

| Priority | Work | Acceptance evidence |
|---|---|---|
| ~~P0~~ | ~~Skills loader and `read_skill`~~ — shipped in #149 | ✅ index injection, size caps, symlink/path rejection, role guards, `ds-agent skills`, docs |
| P0 | Owner-defined routines / heartbeat | Persisted schedule rows, fake-clock daemon tests, owner-only creation, no outward action without approval |
| P1 | Interactive approval flow | Worker requests approval, ticket pauses, Router asks, owner approves/denies, resume is audited |
| P1 | Semantic memory behind `EmbeddingPort` | Deterministic mock, hybrid ranking, recall eval stays green, no CI provider call |
| P2 | Email and browser connectors | Adapter contract, approval gate, offline fakes, real-channel acceptance remains operator-gated |
| P2 | Principal tiers | Trigger trust tiers, prompt `principal` layer, tests that a group member cannot become the owner |
| P3 | Reflection loop | A scheduled review that reads recent tickets/decisions, proposes lessons, and updates a bounded memory/lesson file with owner approval |

## Rules for closing the gap

- **No capability claims without a test.** A README bullet without an offline
  test is a wish, not a feature.
- **One concern per PR.** A prompt change and a capability change ship
  separately, even when they are designed together.
- **Do not copy unsafe surfaces.** A local CLI agent is not a reason to add a
  shell string, an unbounded loop, or an unapproved outward action.
- **Measure the feel, not only the structure.** Prompt tests can prove layer
  order and boundary wording; they cannot prove the agent is pleasant. Real
  conversation transcripts and owner feedback are the only evidence for that.
