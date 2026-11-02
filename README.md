![DeepSeek Super Agent](docs/assets/ds-agent-banner.png)

# deepseek-super-agent

English | [简体中文](README.zh-CN.md)

CLI: `ds-agent`. License: MIT.

Thin TypeScript runtime. Custom Harness below. Domain engine on top.

Inspired by DeepSeek's public article and prototype. Independent implementation. No DeepSeek Harness, Cordis, or `@deepseek-ai/dsh*`.

Author: LofiSu. Co-written with Grokbot (CoderBot).

[Docs](docs/index.md) · [Inspiration](#inspiration) · [Features](#features) · [Architecture](#architecture) · [Quick start](#quick-start) · [Demo](#demo) · [Models](#models) · [Credits](#credits) · [License](#license)

Shorter pages, same facts: [install](docs/install.md), [architecture](docs/architecture.md), [safety](docs/safety.md). [中文](docs/zh/index.md).

## What this is

Two layers.

- **Harness.** Session log, async ReAct loop, OpenAI-compatible calls, tools by role, daemon.
- **Engine.** Intake → Eval → Ticket → Assignment → Reply. Domain writes stay in the Engine.

## Inspiration

| Source | Link | Used for |
|--------|------|----------|
| WeChat article | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | §2–§6: dual Router/Worker, Trigger, async tools, multi-channel, state vs environment, Watchdog |
| Official prototype | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Trigger → Eval → Ticket → Assignment. The Harness is ours. |

## Features

Checked against [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg), one item at a time. Status follows this repo, `pnpm demo`, and `pnpm test`. Task list: [PLAN.md](./PLAN.md) (T01–T51). Where the plan and the code diverge: [docs/REVIEW.md](./docs/REVIEW.md).

`[x]` done and covered. `[~]` partial. `[ ]` not done. Extension domains are always-wired Runtime services, not an opt-in gate: router shards, Worker mesh, long-term memory, lifecycle events, and A2A are assembled on every run. See [docs/MODULES.md](./docs/MODULES.md).

### §1 Four traits

- [x] **Continuous.** IM and GitHub-style channels share one domain state. Sessions stay inside the runtime. (Harness Session + Engine Thread/Ticket)
- [x] **Efficient.** Workers run in parallel. The Router batches Triggers waiting on the same Thread (`evals` + harness inbox).
- [x] **Proactive.** Triggers drive the loop. Speculative Assignment, then a deliver gate (`speculate/`).
- [x] **Persistent.** SQLite. A restart can resume (`store/` plus the demo restart check).

### §2 Dual Router / Worker

- [x] **Continuity vs throughput.** Two layers. The Router talks and dispatches. Workers execute alone (`SessionRole`).
- [x] **Router is the sequence point.** Inbound goes through the Engine. Outbound goes through Router/Outbox.
- [x] **Router stays light.** Workers hold the execution tools. The Router tool set is smaller.
- [x] **Small model on the Router.** `roleModels.router`. Workers can use a stronger model.
- [x] **Trigger batching.** Under load, same-Thread Triggers fold into the next Eval. Demo and tests cover it.
- [~] **Router sharding / multi-layer filter.** `RouterShardRegistry` is always wired into the Runtime (PLAN T09/T46). Configure with `DS_AGENT_SHARDS` or `RuntimeOptions.routerShards`; the default shard always exists.
- [x] **Isolated Worker context.** Each Worker has its own Session and the full tool set.
- [x] **Workers report upward.** `report` goes to the Router. The Router sends the reply. A worker session holds `WorkerPorts`, not the Engine, and cannot `reply` or `decide`.
- [x] **Worker ↔ Thread subscriptions.** Many-to-many, via `subscribe` and fan-out.
- [x] **Subagent / Team inside a Worker.** Async jobs + `spawn_team`/`team_status`/`complete_team` → member jobs → `TEAM_MEMBER_DONE` → aggregate report. Team rows persist in SQLite and `ds-agent team`/`teams` inspect them offline. Router only sees the parent Assignment report (T14; unit + harness + live e2e).
- [~] **One UI, many topics.** Several Tickets can exist at once. `LifecycleBus` is always wired as a read model; there is no default UI yet (T15/T49).

### §3 Event-driven

- [x] **Triggers.** Semi-structured events from IM / GitHub-style sources.
- [x] **Fast Path.** Deterministic source and noise rules (`ingress/filter`).
- [x] **Slow Path.** Semantic or policy filter. It can call a model. Rules can stand in.
- [x] **Thread.** One topic or PR. One event stream. Thread key.
- [x] **Already subscribed.** Straight to the Worker. Log line `bypass=subscription` plus `ticketId`.
- [x] **Not subscribed.** Cold start: Intake → Eval → Ticket.
- [x] **Unsubscribe / hand back.** `handback` drops the subscription and requeues the trigger for Eval (T21).
- [x] **Router still sees every Trigger.** Intake records them.
- [x] **Inline.** Short summaries stay in context (`memory/recall`).
- [x] **Spill.** Long content is stored out of band, with an id (`store/spill`).
- [x] **Locality.** IDs and summaries first. Expand on demand (`read_object`).
- [x] **Chain of Recall.** Pull a spill id or object ref when needed (minimal T25).
- [x] **Speculative work.** A background Assignment can run first.
- [x] **Deliver gate.** `deliver=true`, or the result is dropped. The demo checks this.

### §4 Talking to people

- [x] **Async ReAct.** `start` returns at once. The foreground does not wait.
- [x] **Started notice.** A job-started log event.
- [x] **Completion comes back.** The result is a new Session event on the Worker.
- [x] **Duplex.** New input still arrives while a job runs.
- [x] **IM norms.** Short replies. Low interruption (`channels/norms`, with a word cap).
- [x] **GitHub-style output.** Structured text from the GitHub channel formatter.
- [x] **Only the Router speaks outward.** Workers cannot write a channel directly.

### §5 Compute, state, environment

- [x] **Stateless compute.** Session and domain state live in SQLite.
- [x] **Env stays on the machine.** Sandbox directory via `LocalEnv`.
- [x] **Daemon holds no session.** `daemon.ts` schedules the Watchdog and similar work.
- [x] **BYOM.** OpenAI-compatible `DS_AGENT_API_*` and provider key presets (`resolveLiveApi`).
- [~] **Machines that come and go.** `MachineRegistry` heartbeats + stale detection (`DS_AGENT_MACHINE_STALE_MS`) + daemon resume hook (T40). True multi-host mesh still optional.

### §6 Watchdog

- [x] **Outside control loop.** `watchdog` role.
- [x] **Timer.** Daemon interval tick.
- [x] **Stuck work.** Nudge or fail. Watchdog tools, plus the demo tick.
- [~] **Infra faults and goal drift, in plain language.** Nudge/fail + rules + read-only `ds-agent health` (store/vault mode/machines/watchdog). Deeper NL drift checks still thin (T43–T44).

### §7 Experiments

Article evals. They do not block the release.

- [x] **Runtime counters.** Ingress admit/drop, eval accept, bypass fan-out, speculative deliver/discard, watchdog nudge/fail, model latency. `ds-agent metrics` reads `<stateDir>/metrics.json`.
- [~] **Latency curve samples.** Optional `curveSamples` / `summarizeCurve` in metrics (T45). Full dual-layer vs one-Session bake-off still open.
- [x] **Router batching stress curves.** `runBatchingStress` floods same-Thread Triggers, records batch sizes + eval counts, and appends one Eval latency sample per eval to `curveSamples` (T45 stress harness).

### §8 Left open

Kept out of M11.

- [~] Router scale-out / Worker-direct topology (§8.1) — always-wired `RouterShardRegistry` + `WorkerMeshRegistry` (placement is logical; a remote transport is external)
- [~] Memory that spans tickets (§8.1) — always-wired `SpillBackedLongTermMemory` (not month-scale yet)
- [~] A product shell that is not a Session (§8.2) — always-wired `LifecycleBus` read model; no default UI yet
- [x] Mid-task collaboration with a person (§8.2) — CLI `pause` / `intervene` / `resume` / `collab` + durable `Ticket.collaboration`; harness/watchdog honor pause
- [~] A2A across instances (§8.3) — always-wired `A2ARouter` (in-process; `runtime.sendA2A`)
- [~] **Credentials stay out of tool output.** LocalEnv allowlist + `[redacted]` for secret-named env values of at least 8 characters (shorter values and other names are left as-is) + FileVault `describe()` (names only) + Darwin `sandbox-exec` / Linux `bwrap|unshare` when `DS_AGENT_SANDBOX=1` (§8.4, T51). Host vault/seccomp policy still external.

### Modules M0–M11

| Module | Article | Status |
|--------|---------|--------|
| M0 shared | types / ports | [x] |
| M1 Harness | §2 / §4.1 / §5 | [x] |
| M2 Store | §5.1 / §3.3 Spill | [x] |
| M3 Engine | §2 / §3 Eval, Ticket, Assignment | [x] |
| M4 Ingress | §3.1 | [x] |
| M5 Subscribe | §3.2 | [x] |
| M6 Memory | §3.3 | [x] |
| M7 Speculate | §3.4 | [x] |
| M8 Channels | §4.2 | [x] |
| M9 Env | §5.2 | [x] |
| M10 Watchdog | §6 | [x] |
| M11 CLI demo | acceptance script | [x] `pnpm demo` |

## Architecture

A Channel enters Ingress, then the Engine. The Engine routes and batches, then runs Thread → Eval → Ticket → Assignment. Harness runs the Worker Session. Store and Env are underneath. Watchdog stays outside that path.

```mermaid
flowchart TB
  subgraph Channels["Channel"]
    C1[CLI / Feishu IM / GitHub (real adapters)]
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

A subscribed Thread uses `bypass=subscription`. It skips Router Eval and goes to the Worker already on that Thread.

| Layer | Job |
|-------|-----|
| Channel | inbound adapters, outbound shape |
| Ingress | Fast / Slow Path → Thread key |
| Engine | routing and batching, Thread, Eval, Ticket, Assignment |
| Harness | session, async ReAct, model, tools, daemon |
| Store | SQLite, Spill, `read_object` |
| Env | sandbox directory and process |
| Watchdog | stuck Workers |

## Quick start

Node.js 22+. See `engines` in [package.json](./package.json). The store uses `node:sqlite`. Install [pnpm](https://pnpm.io/).

```bash
pnpm install
export DS_AGENT_API_BASE=https://api.deepseek.com
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-flash
pnpm test
gh auth login            # real GitHub Source + Outbox
export DS_AGENT_GH_REPO=your-account/your-writable-repo
pnpm demo
```

`pnpm test` and `pnpm demo` both require a live OpenAI-compatible model. MockModel is forbidden in the default suite and demo. Set `DS_AGENT_API_BASE`, `DS_AGENT_API_KEY`, and `DS_AGENT_API_MODEL` before `pnpm test`. If any of the three is missing, the `test` script fills a local Magpie default (`http://127.0.0.1:3425/v1`, key `magpie`, model `workbuddy/deepseek-v4.1-flash`). A provider key alone does not replace that, because the script sets the base and key itself.

`pnpm demo` uses real channels only: it creates and reads real GitHub issues and posts real issue comments through `gh api`. There is no fake IM or GitHub fallback. Set `DS_AGENT_GH_REPO` to a repository you can write. Unset, it is `LofiSu/deepseek-super-agent`. Closing the issues is best-effort. The close runs after each scenario's main work, a failed close is ignored, and a throw or an early return before the close leaves issues open. `DS_AGENT_GH_KEEP=1` skips the close. Afterwards, check for open issues labeled `ds-agent-demo`. `pnpm demo:local` is an in-memory fixture baseline for offline smoke checks, not the acceptance path. Feishu setup and `pnpm demo:feishu` are documented in [docs/REAL_CHANNELS.md](./docs/REAL_CHANNELS.md).

`pnpm demo` and `pnpm ds-agent chat` do not apply the Magpie default from the test script. For those, set both `DS_AGENT_API_BASE` and `DS_AGENT_API_KEY`, or one provider key. Setting only one of that pair exits with an error.

Live demo for DeepSeek V4.1 Flash. The API name is `deepseek-flash`. Set `DS_AGENT_API_*`:

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-flash
pnpm demo
pnpm ds-agent chat "fix the login timeout"
```

Omit `DS_AGENT_API_MODEL` on that pair and the client sends `deepseek-chat`. `DEEPSEEK_API_KEY` alone defaults to `deepseek-flash`.

`DS_AGENT_API_BASE` can be any OpenAI-compatible URL. A local [Magpie](https://github.com/yetone/magpie) gateway is allowed. Use the gateway token as the key (often `magpie` on this machine), and Magpie's model id.

```bash
export DS_AGENT_API_BASE=http://127.0.0.1:3425/v1
export DS_AGENT_API_KEY=magpie
export DS_AGENT_API_MODEL=deepseek/deepseek-flash
export DS_AGENT_GH_REPO=your-account/your-writable-repo
pnpm demo
```

[GitHub Actions](./.github/workflows/ci.yml) runs `pnpm typecheck` and `pnpm test` on pushes to `main` and on pull requests. The demo job runs `pnpm demo:local` (in-memory fixture smoke, no repository writes) when `DEEPSEEK_API_KEY` or `DS_AGENT_API_KEY` is set; real-channel acceptance is `pnpm demo` run by an operator with `gh` auth.

State lives in `DS_AGENT_HOME`, or in `./.ds-agent` (SQLite).

```bash
pnpm ds-agent tasks
pnpm ds-agent status
pnpm ds-agent metrics
pnpm ds-agent emit im --thread bug-login --text "login still 500"
pnpm ds-agent emit github --pr 42 --text "CI failed on auth test"
```

## Demo (real channels)

`pnpm demo` is the acceptance path and it uses real channels only:

| Scenario | Real inbound Source | Real outbound Outbox |
|----------|---------------------|----------------------|
| `01-parallel-github` | three real GitHub issues pulled via `gh api` | one issue comment per ticket |
| `02-spill-github` | one real issue body + two real comments | Router replies as issue comments |
| `03-watchdog-github` | one real issue pulled via `gh api` | acknowledgement issue comment |

Each run creates fresh issues on `DS_AGENT_GH_REPO` (default `LofiSu/deepseek-super-agent`), waits for the live model, posts real comments, then re-reads those comments from the GitHub API as proof. Closing is best-effort: it runs after each scenario's main work, a failed close is ignored, and a throw or an early return before the close leaves issues open. `DS_AGENT_GH_KEEP=1` skips the close. Check afterwards for open issues labeled `ds-agent-demo`. Logs and JSON proofs land in `/tmp/ds-agent-live-e2e-logs/demos/`.

```bash
export DS_AGENT_API_BASE=http://127.0.0.1:3425/v1
export DS_AGENT_API_KEY=magpie
export DS_AGENT_API_MODEL=workbuddy/deepseek-v4.1-flash
export DS_AGENT_GH_REPO=LofiSu/deepseek-super-agent
gh auth login
pnpm demo                              # all three scenarios
pnpm demo -- --only watchdog           # one scenario
DS_AGENT_GH_KEEP=1 pnpm demo           # keep the real issues open
```

`pnpm demo:local` runs the legacy in-memory fixture baseline; it is not the channel acceptance path. `pnpm demo:feishu` exercises the real Feishu message API when `FEISHU_APP_ID`/`FEISHU_APP_SECRET`/`FEISHU_CHAT_ID` are set. `pnpm test:live` runs the live-model tests when a key is already in the environment.

## Extension domains

The functional domains keep the T45–T51 ids: evaluation and metrics, extensions, long-term memory, product layer, interop, and security and privacy. The extension services are no longer behind a feature flag; `Runtime.create` always constructs them:

- `runtime.routerShards` — `src/ingress/shards.ts`; configure with `DS_AGENT_SHARDS` (JSON) or `RuntimeOptions.routerShards`. The default shard always exists.
- `runtime.workerMesh` — `src/harness/mesh.ts`; `DS_AGENT_MESH_CAPACITY` or `RuntimeOptions.meshCapacity`.
- `runtime.longTermMemory` — `src/memory/long-term.ts`; one entry per finished ticket.
- `runtime.lifecycle` — `src/core/lifecycle.ts`; read-model events for panels and CLI views.
- `runtime.a2aRouter` / `runtime.sendA2A` — `src/channels/a2a.ts`; the Runtime registers its instance as the local recipient.

`DS_AGENT_INSTANCE_ID` sets the local A2A address and mesh node id. See [docs/MODULES.md](./docs/MODULES.md) for the module reference.

```bash
DS_AGENT_INSTANCE_ID=alpha pnpm ds-agent chat "fix the login timeout"
DS_AGENT_SHARDS='[{"id":"github","filter":"source:github"}]' pnpm ds-agent chat "CI failed"
```

## Models

Both `DS_AGENT_API_BASE` and `DS_AGENT_API_KEY` win over the presets below. Omit the model and that pair sends `deepseek-chat`. For V4.1 Flash, set `deepseek-flash`.

| Variable | Meaning |
|----------|---------|
| `DS_AGENT_API_BASE` | OpenAI-compatible base. DeepSeek: `https://api.deepseek.com`. Local Magpie: `http://127.0.0.1:3425/v1`. |
| `DS_AGENT_API_KEY` | API key. On Magpie, this is the gateway token, not the DeepSeek key. |
| `DS_AGENT_API_MODEL` | Model id. `deepseek-flash` is DeepSeek V4.1 Flash. On Magpie use `deepseek/deepseek-flash`. |

A provider key alone fills in the base and default model. The first matching row wins. `DS_AGENT_PROVIDER` picks one. Aliases: `xai`/`grok`, `moonshot`/`kimi`, `zhipu`/`glm`, `gemini`/`google`, `anthropic`/`claude`.

| Provider | Environment variable | OpenAI-compatible base | Default model |
|----------|----------------------|------------------------|---------------|
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` | `deepseek-flash` |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` |
| xAI / Grok | `XAI_API_KEY` or `GROK_API_KEY` | `https://api.x.ai/v1` | `grok-4.7` |
| Moonshot / Kimi | `MOONSHOT_API_KEY` or `KIMI_API_KEY` | `https://api.moonshot.cn/v1` | `kimi-k3.1-pro` |
| Zhipu / GLM | `ZHIPU_API_KEY` or `GLM_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3` |
| Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` |
| Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` | `claude-opus-5-5` |

`HttpOpenAI` posts to `{base}/chat/completions` with `Authorization: Bearer`. Moonshot's international base is `https://api.moonshot.ai/v1`. Zhipu's overseas base is `https://api.z.ai/api/paas/v4`. Set those with `DS_AGENT_API_BASE` and `DS_AGENT_API_KEY`.

`pnpm ds-agent chat` calls `createModelFromEnv()` (legacy offline Mock only when no key). Demo and `pnpm test` call `requireLiveModelFromEnv()` / Magpie HttpOpenAI and refuse MockModel.

Use a small model for the Router and Watchdog. Use a stronger one for the Worker. The table is one model for the process.

## Credits

Author: LofiSu. Co-written with Grokbot (CoderBot).


## Live model tests

Measured on a local [Magpie](https://github.com/yetone/magpie) gateway (Asia/Shanghai) with `workbuddy/deepseek-v4.1-flash`:

```bash
export DS_AGENT_API_BASE=http://127.0.0.1:3425/v1
export DS_AGENT_API_KEY=magpie
export DS_AGENT_API_MODEL=workbuddy/deepseek-v4.1-flash
export DS_AGENT_GH_REPO=LofiSu/deepseek-super-agent
gh auth login
pnpm test
pnpm demo          # real GitHub issues/comments + live model
```

`pnpm test` fills any missing `DS_AGENT_API_*` with those Magpie defaults before Vitest starts. `test/setup-live.ts` does the same only when the variables are still unset, and it skips that fill on CI. A provider key alone does not replace the three. Transcripts from the E2E cases land under `/tmp/ds-agent-live-e2e-logs/`; real-channel demo logs and proofs land in `/tmp/ds-agent-live-e2e-logs/demos/`. Update the pass/fail counts in this section after each live run.

## License

[MIT](./LICENSE)

- [WeChat article](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)
- [Official prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
