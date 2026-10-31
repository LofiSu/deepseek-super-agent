# deepseek-super-agent

English | [简体中文](README.zh-CN.md)

CLI: `ds-agent` · MIT

A thin TypeScript runtime in the spirit of the public Super-agent article: a custom Harness underneath, a domain engine on top.

Inspired by DeepSeek's public article and prototype; implemented independently. No DeepSeek Harness / Cordis, and no `@deepseek-ai/dsh*`.

LofiSu × Grokbot (CoderBot).

[Inspiration](#inspiration) · [Features](#features) · [Architecture](#architecture) · [Quick start](#quick-start) · [Demo](#demo) · [Models](#models) · [Credits](#credits) · [License](#license)

## What this is

`ds-agent` has two layers:

- **Harness** — session event log, async ReAct loop, OpenAI-compatible calls, tools registered by role, daemon.
- **Engine** — Intake → Eval → Ticket → Assignment → Reply. Domain state is written only here.

## Inspiration

| Source | Link | Used for |
|--------|------|----------|
| WeChat article | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | §2–§6: dual Router/Worker, Trigger, async tools, multi-channel, state vs environment, Watchdog |
| Official prototype | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Trigger → Eval → Ticket → Assignment; the Harness is ours |

## Features

Mapped **point by point** to [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg). Status follows this repo plus `pnpm demo` / `pnpm test`. Full task matrix: [PLAN.md](./PLAN.md) (T01–T51). Where that plan and the running code diverge: [docs/REVIEW.md](./docs/REVIEW.md).

Legend: `[x]` implemented and covered by the demo or tests · `[~]` skeleton or partial · `[ ]` not done (including Phase-2)

### §1 Four traits

- [x] **Continuous** — one domain state across IM / GitHub-style channels; the user does not manage Sessions (Harness Session + Engine Thread/Ticket)
- [x] **Efficient** — parallel Workers; the Router batches Triggers queued on the same Thread (`evals` + harness inbox)
- [x] **Proactive** — Trigger-driven; speculative Assignment + deliver gate (`speculate/`)
- [x] **Persistent** — SQLite; recoverable after process restart (`store/` + demo restart assertion)

### §2 Dual Router / Worker

- [x] **Continuity vs throughput → dual split** — Router owns interaction and dispatch; Workers execute in isolation (`SessionRole`)
- [x] **Router = global sequence point / coordination / memory entry** — inbound through the Engine; outbound through Router/Outbox
- [x] **Router does not do the heavy work** — Workers hold execution tools; the Router tool set is narrower
- [x] **Router can use a lightweight model** — `roleModels.router` / Mock; Workers can use a stronger model
- [x] **Trigger batching (folded into the next turn under load)** — same-Thread Eval batch; covered by demo/tests
- [ ] **Router horizontal split / multi-layer filter** — article §2/§8; Phase-2 (PLAN T09)
- [x] **Worker context isolation + full execution tools** — separate Worker Session
- [x] **Workers do not reply to people directly** — via `report` → Router, then outbound
- [x] **Worker ↔ Thread subscription (many-to-many)** — `subscribe` + fan-out
- [~] **In-Worker Subagent / Team opaque to the Router** — async jobs exist; not a full Team topology (T14)
- [~] **One UI, many topics → many Workers** — multiple Tickets can coexist; no product shell yet (T15)

### §3 Event-driven

- [x] **Semi-structured environment events = Triggers** — IM / GitHub-style Sources
- [x] **Fast Path programmatic filter** — deterministic source/noise rules (`ingress/filter`)
- [x] **Slow Path semantic/policy filter** — can follow a model policy; the Mock path can skip or stay on rules
- [x] **Thread = event stream for one topic or PR** — Thread key
- [x] **Subscribed → straight to the Worker (bypass Router Eval)** — log `bypass=subscription` + `ticketId`
- [x] **Unsubscribed → Router/Eval cold start** — Intake → Eval → Ticket
- [~] **Worker unsubscribe / hand back to the Router** — direction is in PLAN; the demo does not stress it (T21)
- [x] **Router can still observe every Trigger** — Intake bookkeeping
- [x] **Inline: summaries in context** — `memory/recall`
- [x] **Spill: long content stored out of band + id** — `store/spill`
- [x] **Locality: IDs and summaries first, expand on demand** — `read_object`
- [x] **Chain of Recall** — pull a spillId or object ref on demand (minimal T25)
- [x] **Speculative execution runs in the background first** — speculative Assignment
- [x] **Deliver only if it is valuable; otherwise drop it quietly** — `deliver=true` gate; checked by the demo

### §4 Human interaction

- [x] **Async ReAct: `start` returns immediately** — harness loop / async job
- [x] **Started notification** — job-started log/event
- [x] **Completion returns as a new Session event** — completion is fed back to the Worker
- [x] **Full duplex: new input still arrives while a job runs** — inbound and job completion enqueue together
- [x] **IM low-interrupt / short-reply norms** — `channels/norms` (including a word cap)
- [x] **Structured output on async channels such as GitHub** — GitHub channel formatter
- [x] **Only the Router speaks outward** — Workers cannot write a channel directly

### §5 Compute / state / environment

- [x] **Compute can be stateless; Session and domain live in the DB** — SQLite Store
- [x] **Execution environment stays on the machine (sandbox directory)** — `LocalEnv`
- [x] **The daemon does not hold session state** — `daemon.ts` only schedules the Watchdog and similar work
- [x] **BYOM: OpenAI-compatible `DS_AGENT_API_*`** — `createModelFromEnv`
- [~] **Intermittent devices / multi-machine handoff** — the Store can resume; a real cross-machine daemon is not done (T40, partial)

### §6 Watchdog

- [x] **External control-loop Session** — `watchdog` role
- [x] **Timer-driven** — daemon interval tick
- [x] **Nudge / fail stuck work** — watchdog tools + demo tick
- [~] **Natural-language maintenance for infra faults and goal drift** — nudge/fail exist; full health checks and YAML rule edits are not in yet (T43–T44)

### §7 Experiments (article evals; do not block the open-source release)

- [ ] **End-to-end dual layer vs single Session** — Phase-2 / optional M12 (T45)
- [ ] **Router batching stress curves** — Phase-2 (T45)

### §8 Open questions (explicitly out of M11)

- [ ] Router scale-out / Worker-direct topology (§8.1)
- [ ] Long-horizon memory across months (§8.1)
- [ ] A product shell that is not a Session (§8.2)
- [ ] Mid-task human collaboration UX (§8.2)
- [ ] A2A across instances (§8.3)
- [ ] Deeper security and privacy; credentials never enter the model context (§8.4; baseline: secrets stay out of the prompt) — PLAN T51

### Modules M0–M11

| Module | Article | Status |
|--------|---------|--------|
| M0 shared | types / ports | [x] |
| M1 Harness | §2 / §4.1 / §5 | [x] |
| M2 Store | §5.1 / §3.3 Spill | [x] |
| M3 Engine | §2 / §3 Eval · Ticket · Assignment | [x] |
| M4 Ingress | §3.1 | [x] |
| M5 Subscribe | §3.2 | [x] |
| M6 Memory | §3.3 | [x] |
| M7 Speculate | §3.4 | [x] |
| M8 Channels | §4.2 | [x] |
| M9 Env | §5.2 | [x] |
| M10 Watchdog | §6 | [x] |
| M11 CLI demo | acceptance script | [x] `pnpm demo` |

## Architecture

Layers: an outer **Channel** enters **Ingress**, then **Engine** (routing / batching → Thread → Eval → Ticket → Assignment). **Harness** runs the Worker Session. **Store** (state / Spill) and **Env** (sandbox / process) sit underneath. **Watchdog** hangs off the side.

```mermaid
flowchart TB
  subgraph Channels["Channel"]
    C1[CLI / fake IM / fake GitHub]
  end

  subgraph Ingress["Ingress"]
    Fast[Fast Path]
    Slow[Slow Path]
    Fast --> TK[Thread key]
    Slow --> TK
  end

  subgraph Engine["Engine"]
    Intake[Intake / routing + batching]
    Thread[Thread]
    Eval[Eval]
    Ticket[Ticket]
    Assign[Assignment]
    Intake --> Thread --> Eval
    Eval -->|actionable| Ticket --> Assign
    Eval -->|noise| Drop[drop / archive]
  end

  subgraph Harness["Harness"]
    Sess[Session · async ReAct · model · tools]
    Worker[Worker]
    Assign --> Worker
    Worker --> Sess
  end

  subgraph Bottom["Foundation"]
    Store[(Store · SQLite + Spill)]
    Env[Env · LocalEnv / daemon]
  end

  WD[Watchdog]

  C1 --> Fast
  C1 --> Slow
  TK --> Intake
  Sess --> Store
  Sess --> Env
  Worker -.->|report| Intake
  WD -.-> Worker
```

Text flow:

```
Channel ──► Ingress (Fast/Slow → Thread key)
              │
              ▼
           Engine.receive
              │  routing / batching
              ▼
           Thread ──► Eval ──► Ticket ──► Assignment
                         │                    │
                         └─ drop              ▼
                                        Harness Worker
                                              │
                    Store ◄───────────────────┤
                    Env   ◄───────────────────┘
                              Watchdog → stuck Workers
```

A Thread that is already subscribed uses `bypass=subscription` and skips Router Eval, going straight to the existing Worker.

| Layer | Job |
|-------|-----|
| Channel | inbound adapters, outbound shape |
| Ingress | Fast / Slow Path → Thread key |
| Engine | routing/batching, Thread, Eval, Ticket, Assignment |
| Harness | session, async ReAct, model, tools, daemon |
| Store | SQLite, Spill, `read_object` |
| Env | sandbox directory and process |
| Watchdog | stuck Workers |

## Quick start

Node.js 22+ (see `engines` in [package.json](./package.json)), [pnpm](https://pnpm.io/). **`pnpm demo` requires a real model** (no silent MockModel).

```bash
pnpm install

export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat   # optional

# also accepted, after DS_AGENT_API_*:
#   DEEPSEEK_API_KEY=sk-...          # https://api.deepseek.com/v1, model deepseek-chat
#   OPENROUTER_API_KEY=...           # e.g. deepseek/deepseek-chat
#   OPENAI_API_KEY=...
#   GROK_API_KEY=...                 # or XAI_API_KEY

pnpm demo          # real API; missing key → clear error
pnpm test          # offline unit tests may still use MockModel
pnpm test:live     # live integration tests when a key is set
pnpm ds-agent chat "fix the login timeout"
```

[GitHub Actions](./.github/workflows/ci.yml) runs `pnpm typecheck` and `pnpm test` on pushes to `main` and on pull requests. The demo job runs only when `DEEPSEEK_API_KEY` or `DS_AGENT_API_KEY` is set as a secret, and then calls the live model.

State lives in `DS_AGENT_HOME`, or in `./.ds-agent` (SQLite).

```bash
pnpm ds-agent tasks
pnpm ds-agent status
pnpm ds-agent emit im --thread bug-login --text "login still 500"
pnpm ds-agent emit github --pr 42 --text "CI failed on auth test"
```

## Demo

`pnpm demo` feeds fake IM / GitHub events through a **real model API** (errors if no key). Fake events, real completions. The checks cover noise filtering, Ticket → Worker, `bypass=subscription`, Spill + `read_object`, the speculative deliver gate, Watchdog, and restart persistence. A live run skips the scripted offline proofs.

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat   # optional
pnpm demo
```

## Models

`resolveLiveApi()` checks these in order. The first match wins. `DS_AGENT_API_MODEL` overrides the model name.

| Variable | Meaning |
|----------|---------|
| `DS_AGENT_API_BASE` + `DS_AGENT_API_KEY` | OpenAI-compatible base and key (checked first) |
| `DEEPSEEK_API_KEY` | DeepSeek key. Base defaults to `https://api.deepseek.com/v1`, model `deepseek-chat` |
| `OPENROUTER_API_KEY` | OpenRouter. Default model `deepseek/deepseek-chat` |
| `OPENAI_API_KEY` | OpenAI. Default model `gpt-4o-mini` |
| `GROK_API_KEY` or `XAI_API_KEY` | xAI. Default model `grok-2-latest` |
| `DS_AGENT_API_MODEL` | Optional model override |

Use a lightweight model for the Router and Watchdog, and a stronger one for the Worker.

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat   # optional
# or DEEPSEEK_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, GROK_API_KEY / XAI_API_KEY
pnpm demo
```

`pnpm demo` calls `requireLiveModelFromEnv()` and prints setup instructions when no key is set. It does not use MockModel.

`pnpm test` and `pnpm ds-agent` call `createModelFromEnv()`, which uses the live API when a key is set and otherwise uses MockModel so the unit tests stay offline.

## Credits

LofiSu × Grokbot (CoderBot).

## License

[MIT](./LICENSE)

- [WeChat article](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)
- [Official prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
