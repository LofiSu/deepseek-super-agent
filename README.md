# deepseek-super-agent

CLI：`ds-agent` · MIT · LoomLab

按公开 Super-agent 文章的思路，用 TypeScript 写的薄运行时：下层是自研 Harness，上层是领域引擎。

思路来源于 DeepSeek 的公开文章和原型，由本人独立实现。

作者 LofiSu 与 Grokbot（CoderBot）共同完成。

| | |
|---|---|
| 中文 | [灵感来源](#灵感来源) · [能力清单](#能力清单) · [架构](#架构) · [快速开始](#快速开始) · [Demo](#demo) · [模型配置](#模型配置) · [致谢](#致谢) · [许可](#许可) |
| English | [Inspiration](#inspiration) · [Features](#features) · [Architecture](#architecture) · [Quick start](#quick-start) · [Demo](#demo-1) · [Models](#models) · [Credits](#credits) · [License](#license) |

---

## 中文

### 这是什么

`ds-agent` 分两层：

- **Harness**：Session 事件日志、异步 ReAct 循环、OpenAI 兼容调用、按角色注册工具、daemon。
- **Engine**：Intake → Eval → Ticket → Assignment → Reply。领域状态只在这里写入。

不依赖 DeepSeek Harness / Cordis，也没有 `@deepseek-ai/dsh*`。

### 灵感来源

| 来源 | 链接 | 参考什么 |
|------|------|----------|
| 微信文章 | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | §2–§6：双层 Router/Worker、Trigger、异步工具、多信道、状态与环境分离、Watchdog |
| 官方原型 | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Trigger → Eval → Ticket → Assignment；Harness 自研 |

### 能力清单

对照微信文 [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) **逐条**落地。状态以本仓代码 + `pnpm demo` / `pnpm test` 为准；完整任务矩阵见 [PLAN.md](./PLAN.md)（T01–T51）。

图例：`[x]` 已有实现并通过 demo/测试路径验证 · `[~]` 有骨架或部分能力 · `[ ]` 未做（含 Phase-2）

#### §1 四特质

- [x] **连续 Continuous** — 跨 IM / GitHub 等信道共用同一套领域状态，用户不必管 Session（Harness Session + Engine Thread/Ticket）
- [x] **高效 Efficient** — 多 Worker 并行；Router 侧批处理同 Thread 积压 Trigger（`evals` + harness inbox）
- [x] **主动 Proactive** — Trigger 驱动；投机 Assignment + deliver gate（`speculate/`）
- [x] **持久 Persistent** — SQLite 持久化；进程重启后可恢复（`store/` + demo restart 断言）

#### §2 双层 Router / Worker

- [x] **连续性 vs 吞吐权衡 → 双层拆分** — Router 管交互与分派，Worker 隔离执行（`SessionRole`）
- [x] **Router = 全局序点 / 协调 / 记忆入口** — 入站经 Engine；出站经 Router/Outbox
- [x] **Router 不直接干重活** — Worker 挂执行工具；Router 工具集更窄
- [x] **Router 可用轻量模型** — `roleModels.router` / Mock；Worker 可配强模型
- [x] **Trigger 批处理（拥堵时合并进下一轮）** — 同 Thread Eval batch；demo/测试覆盖
- [ ] **Router 水平切分 / 多层过滤** — 文章 §2/§8；Phase-2（PLAN T09）
- [x] **Worker 上下文隔离 + 完整执行工具** — 独立 Worker Session
- [x] **Worker 不直接对人回复** — 经 `report` → Router 再出站
- [x] **Worker ↔ Thread 订阅（可多对多）** — `subscribe` + fan-out
- [~] **Worker 内 Subagent / Team 对 Router 透明** — 有 async job；未做成完整 Team 拓扑（T14）
- [~] **单 UI 多话题 → 多 Worker** — 多 Ticket 可并存；产品壳未做（T15）

#### §3 事件驱动

- [x] **环境半结构化事件 = Trigger** — IM / GitHub 风格 Source
- [x] **Fast Path 程序过滤** — source/噪声等确定性规则（`ingress/filter`）
- [x] **Slow Path 语义/策略过滤** — 可走模型策略；Mock 路径可跳过或规则化
- [x] **Thread = 同一话题/PR 下的事件流** — Thread key
- [x] **已订阅 → 直通 Worker（bypass Router Eval）** — 日志 `bypass=subscription` + `ticketId`
- [x] **未订阅 → Router/Eval 冷启动分派** — Intake → Eval → Ticket
- [~] **Worker 取消订阅 / 交回 Router** — 接口方向在 PLAN；demo 未强调（T21）
- [x] **Router 仍可观察全局 Trigger** — Intake 记账
- [x] **Inline：摘要进上下文** — `memory/recall`
- [x] **Spill：长内容外置 + id** — `store/spill`
- [x] **局部性：先 ID/摘要，再按需展开** — `read_object`
- [x] **链式召回 Chain of Recall** — spillId / 对象引用按需拉取（T25 最小实现）
- [x] **投机执行：后台先跑** — speculative Assignment
- [x] **有价值才交付，否则安静丢弃** — `deliver=true` gate；demo 验证

#### §4 面向人的交互

- [x] **异步 ReAct：`start` 立即返回，不堵前台** — harness loop / async job
- [x] **Started 通知** — job started 日志/事件
- [x] **完成后作为新 Session 事件回来** — completion 回灌 Worker
- [x] **全双工：后台跑时仍接新输入** — 入站与 job 完成并行入队
- [x] **IM 低打扰 / 短回复规范** — `channels/norms`（含词数上限思路）
- [x] **GitHub 等异步信道结构化输出** — github channel formatter
- [x] **对外只由 Router 说话** — Worker 禁直写信道

#### §5 计算 / 状态 / 环境分离

- [x] **计算可无状态，Session/领域进 DB** — SQLite Store
- [x] **执行环境留在原地（沙箱目录）** — `LocalEnv`
- [x] **端侧 daemon 不持会话状态** — `daemon.ts` 只调度 Watchdog 等
- [x] **BYOM：OpenAI 兼容 `DS_AGENT_API_*`** — `createModelFromEnv`
- [~] **间歇上线设备 / 多机切换** — Store 可续；真·跨机 daemon 未做（T40 部分）

#### §6 Watchdog

- [x] **外部 Control Loop Session** — `watchdog` role
- [x] **定时驱动** — daemon interval tick
- [x] **卡住任务 nudge / fail** — watchdog tools + demo tick
- [~] **基础设施故障 + 目标偏离的 NL 维护** — 有 nudge/fail；完整健康检查/改规则 YAML 未齐（T43–T44）

#### §7 实验（文章评测，不挡开源）

- [ ] **端到端对比双层 vs 单 Session** — Phase-2 / 可选 M12（T45）
- [ ] **Router 批处理压测曲线** — Phase-2（T45）

#### §8 未决问题（明确不做进 M11）

- [ ] Router 扩展 / Worker 直连拓扑（§8.1）
- [ ] 长程跨月记忆（§8.1）
- [ ] 脱离 Session 的产品交互壳（§8.2）
- [ ] 中途人机协同 UX（§8.2）
- [ ] A2A 跨实例（§8.3）
- [ ] 安全隐私深化；凭据永不进模型上下文（§8.4，基线：密钥不进 prompt）— PLAN T51

#### 模块对照（M0–M11）

| 模块 | 文章落点 | 状态 |
|------|----------|------|
| M0 shared | 类型/端口 | [x] |
| M1 Harness | §2/§4.1/§5 | [x] |
| M2 Store | §5.1/§3.3 Spill | [x] |
| M3 Engine | §2/§3 Eval·Ticket·Assignment | [x] |
| M4 Ingress | §3.1 | [x] |
| M5 Subscribe | §3.2 | [x] |
| M6 Memory | §3.3 | [x] |
| M7 Speculate | §3.4 | [x] |
| M8 Channels | §4.2 | [x] |
| M9 Env | §5.2 | [x] |
| M10 Watchdog | §6 | [x] |
| M11 CLI demo | 验收脚本 | [x] `pnpm demo` |


### 架构

```
Channel    CLI / 假 IM / 假 GitHub
    │
Ingress    Fast Path + Slow Path → Thread key
    │
Engine     Intake → Eval → Ticket / Assignment
    │
Harness    Session、异步 ReAct、模型、工具
    │
Store      SQLite + Spill          Env：LocalEnv / daemon
```

事件进 Ingress，再进 `Engine.receive`；Eval 后出 Ticket 和 Assignment，Worker 跑完向 Router 汇报，再按信道写出。Watchdog 在外侧盯卡住的任务。

| 层 | 职责 |
|----|------|
| Harness | Session、循环、模型、工具、daemon |
| Engine | Trigger / Thread / Decision / Ticket / Assignment |
| Store | SQLite、Spill |
| Channels | 入站适配、出站格式 |
| Env | 沙箱目录与进程 |
| Watchdog | 检查卡住的 Worker |

### 快速开始

Node.js 20+，[pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm demo
pnpm start
pnpm test
```

### Demo

`pnpm demo` 注入一批假 IM / GitHub 事件，日志里大致应能看到：噪声被过滤、可行动消息变成 Ticket → Worker、同 Thread 跟进带 `bypass=subscription`、可起第二个 Worker、Spill + `read_object`、投机结果过 gate 前不可见、Watchdog 能 nudge / fail、重启后数据还在、依赖里没有 `@deepseek-ai/dsh*`。

### 模型配置

| 变量 | 作用 |
|------|------|
| `DS_AGENT_API_BASE` | OpenAI 兼容 Base |
| `DS_AGENT_API_KEY` | API Key |
| `DS_AGENT_API_MODEL` | 可选默认模型 |

Router / Watchdog 用轻量模型，Worker 用强一点的。

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### 致谢

作者 LofiSu 与 Grokbot（CoderBot）共同完成。

### 许可

[MIT](./LICENSE)

- [微信文章](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- [官方原型](https://github.com/deepseek-ai/dsh-superagent-prototype)

---

## English

### What this is

`ds-agent` has two layers:

- **Harness** — session log, async ReAct, OpenAI-compatible calls, role tools, daemon.
- **Engine** — Intake → Eval → Ticket → Assignment → Reply. Domain writes happen only here.

No DeepSeek Harness / Cordis, and no `@deepseek-ai/dsh*`.

Inspired by DeepSeek's public article and prototype; implemented independently.

Author: LofiSu, co-written with Grokbot (CoderBot).

### Inspiration

| Source | Link | Used for |
|--------|------|----------|
| WeChat article | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | §2–§6 goals |
| Official prototype | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Trigger → Eval → Ticket → Assignment; Harness is ours |

### Features

Mapped **point-by-point** to [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg). Status from this repo + `pnpm demo` / `pnpm test`. Full task matrix: [PLAN.md](./PLAN.md) (T01–T51).

Legend: `[x]` implemented & covered by demo/tests · `[~]` partial · `[ ]` not done (incl. Phase-2)

#### §1 Four traits

- [x] **Continuous** — shared domain state across IM/GitHub-style channels
- [x] **Efficient** — parallel Workers; Router-side Trigger batching
- [x] **Proactive** — Trigger-driven; speculative Assignment + deliver gate
- [x] **Persistent** — SQLite; survives restart

#### §2 Dual Router / Worker

- [x] Continuity vs throughput → dual layer
- [x] Router as sequence / coordination point
- [x] Router does not do heavy execution
- [x] Lightweight Router model slot
- [x] Trigger batching under load
- [ ] Router sharding / multi-filter (Phase-2)
- [x] Isolated Workers with exec tools
- [x] Workers never speak to users directly
- [x] Many-to-many Worker↔Thread subscriptions
- [~] In-Worker Subagent/Team opaque to Router
- [~] One UI / many topics → many Workers

#### §3 Event-driven

- [x] Triggers from the environment
- [x] Fast Path programmatic filter
- [x] Slow Path semantic/policy filter
- [x] Thread = event stream
- [x] Subscribed → bypass Router Eval (`bypass=subscription`)
- [x] Unsubscribed → cold-start Eval
- [~] Unsubscribe / handback to Router
- [x] Router still observes all Triggers
- [x] Inline summaries
- [x] Spill + id
- [x] Locality / on-demand expand (`read_object`)
- [x] Chain of Recall (minimal)
- [x] Speculative background work
- [x] Deliver only if valuable

#### §4 Human interaction

- [x] Async ReAct `start` (non-blocking)
- [x] Started ack
- [x] Completion as a new session event
- [x] Duplex while jobs run
- [x] IM low-interrupt norms
- [x] GitHub-style structured outbound
- [x] Router owns outbound

#### §5 Compute / state / env

- [x] Stateless compute + durable DB
- [x] Env stays local (`LocalEnv`)
- [x] Daemon holds no session state
- [x] BYOM via `DS_AGENT_API_*`
- [~] Intermittent / multi-machine hands

#### §6 Watchdog

- [x] External control-loop Session
- [x] Timer-driven ticks
- [x] Nudge / fail stuck work
- [~] Full infra + NL rule maintenance

#### §7 Experiments (optional)

- [ ] E2E dual-layer vs single Session (Phase-2)
- [ ] Router batching stress curves (Phase-2)

#### §8 Open questions (out of M11)

- [ ] Router scale-out / Worker mesh
- [ ] Long-horizon memory
- [ ] Session-free product UX
- [ ] Mid-task human co-pilot UX
- [ ] A2A
- [ ] Hardened security/privacy (creds never in context — baseline kept)

#### Modules M0–M11

| Module | Article | Status |
|--------|---------|--------|
| M0–M11 | §§2–6 + demo harness | [x] see Chinese table; `pnpm demo` green on Origin/GitHub mirror |


### Architecture

```
Channel    CLI / fake IM / fake GitHub
    │
Ingress    Fast + Slow → Thread key
    │
Engine     Intake → Eval → Ticket / Assignment
    │
Harness    Session, async ReAct, model, tools
    │
Store      SQLite + Spill          Env: LocalEnv / daemon
```

Event → Ingress → `Engine.receive` → Eval → Ticket / Assignment → Worker → Router outbox. Watchdog watches stuck Workers.

| Layer | Job |
|-------|-----|
| Harness | session, loop, model, tools, daemon |
| Engine | Trigger / Thread / Decision / Ticket / Assignment |
| Store | SQLite, Spill |
| Channels | inbound adapters, outbound shape |
| Env | sandbox workdir / process |
| Watchdog | stuck Workers |

### Quick start

Node.js 20+, [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm demo
pnpm start
pnpm test
```

### Demo

`pnpm demo` feeds fake IM / GitHub events. Expect noise filtered, Ticket → Worker, `bypass=subscription`, a second Worker, Spill + `read_object`, speculative work hidden until the gate, Watchdog ticks, persistence after restart, and no `@deepseek-ai/dsh*`.

### Models

| Variable | Meaning |
|----------|---------|
| `DS_AGENT_API_BASE` | OpenAI-compatible base |
| `DS_AGENT_API_KEY` | API key |
| `DS_AGENT_API_MODEL` | optional default model |

Lightweight for Router / Watchdog; stronger for Worker.

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### Credits

Author: LofiSu, co-written with Grokbot (CoderBot).

### License

[MIT](./LICENSE)

- [WeChat article](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- [Official prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
