# deepseek-super-agent

CLI：`ds-agent` · MIT · LoomLab  
TypeScript Super-agent 实验仓。不是 DeepSeek 官方产品，也别直接上生产。

| | |
|---|---|
| 中文 | [灵感](#中文) · [能力对照](#能力对照博客) · [架构](#架构) · [快速开始](#快速开始) · [Demo](#demo) · [模型](#模型配置) · [许可](#许可) |
| English | [Inspiration](#english) · [Features](#features-vs-blog) · [Architecture](#architecture) · [Quick start](#quick-start) · [Demo](#demo-1) · [Models](#model-configuration) · [License](#license) |

---

## 中文

**ds-agent** 用 TypeScript 搭了一套偏博客里 Super-agent 思路的运行时：自研最薄 **Harness**（Session 日志、异步 ReAct、OpenAI 兼容调用、按角色挂工具、daemon），上面再挂领域 **Engine**（Intake / Evals / Tickets / Assignments / Replies）。不依赖 DeepSeek Harness，也不依赖 Cordis。

### 灵感来源

公开材料只当设计参考，代码是 LoomLab 自己写的。

| 来源 | 链接 | 用法 |
|------|------|------|
| 微信文 | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | §2–§6：双层 Router/Worker、Trigger、异步 ReAct、多信道、存算/环境分离、Watchdog |
| 官方原型 | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Trigger → Eval → Ticket → Assignment 这套领域语义；Harness 自研，不搬 DSH |

没有 `@deepseek-ai/dsh*` 依赖。

### 能力对照（博客）

对照同一篇微信文。勾选表示设计目标已进本仓方案与实现路径；是否全部跑通以 `pnpm demo` 为准。

- [ ] **双层 Router / Worker** — Router 管交互与分派；Worker Session 隔离（§2）
- [ ] **异步 ReAct** — `start()` / 任务完成事件，长工具不堵前台（§2.2、§4.1）
- [ ] **Trigger + 两级过滤** — Fast Path 程序去噪，Slow Path 再过语义/策略（§3.1）
- [ ] **SQLite 持久化** — 重启还能接着跑（§5.1）
- [ ] **Thread 订阅扇出** — 已订阅事件可绕过 Router Eval（§3.2）
- [ ] **Inline / Spill 链式召回** — 摘要 + `read_object(id)`（§3.3）
- [ ] **投机执行** — 先静默 Assignment，过 deliver gate 再对外（§3.4）
- [ ] **多信道** — CLI / 假 IM / 假 GitHub，出站文案按信道定（§4.2）
- [ ] **计算 / 状态 / 环境分开** — Store 与 LocalEnv 沙箱拆开（§5）
- [ ] **BYOM** — `DS_AGENT_API_*` 接 OpenAI 兼容接口；端侧 daemon（§5.2）
- [ ] **Watchdog** — 外部控制回路；卡住就 nudge / fail（§6）

没配 Key 时默认走 **MockModel**，方便先把流水线跑通。

### 架构

```
Channel     CLI / 假 IM / 假 GitHub（只适配进出，不写领域状态）
   │
Ingress     Fast Path + Slow Path；算 Thread key
   │
Engine      Intake → Eval（可批）→ Ticket / Assignment
            订阅扇出可 bypass Eval；领域写入只在这里
   │
Harness     Session · 异步 ReAct · Mock/HTTP 模型 · 工具注册
            Router / Worker / Watchdog Session
   │
Store       SQLite + Spill          Env：LocalEnv / BYOM daemon
```

事件进 Ingress，再进 `Engine.receive`，排队 Eval 后出 Ticket 和 Assignment；Worker 跑完向 Router 汇报，再按信道写出。Watchdog 在外侧盯卡住的 Worker。

| 层 | 干什么 |
|----|--------|
| **Harness** | Session、循环、模型客户端、工具、daemon |
| **Engine** | 写 Trigger / Thread / Decision / Ticket / Assignment |
| **Store** | SQLite + Spill |
| **Channels** | 入站适配、出站回复格式 |
| **Env** | 沙箱目录与进程，和持久状态分开 |
| **Watchdog** | 定时看卡住的 Worker → nudge / fail |

### 快速开始

Node.js 20+，[pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm demo      # 脚本场景；默认 MockModel
pnpm start     # daemon / CLI 入站
pnpm test
```

### Demo

`pnpm demo` 丢一批合成的 IM / GitHub 风格事件，日志里大致应能看到：

1. 噪声 Trigger 被两级过滤扔掉  
2. 可行动消息 → Ticket → Worker Assignment  
3. 同 Thread 跟进带 `bypass=subscription`（含 `ticketId`）  
4. 能再起一个并行 Worker  
5. Spill 写入 + `read_object` 链式召回  
6. 投机 Assignment 在 gate 前对外不可见  
7. Watchdog tick 能 nudge / fail  
8. 重启后 Store 还在  
9. 依赖树里没有 `@deepseek-ai/dsh*`

### 模型配置

| 变量 | 含义 |
|------|------|
| `DS_AGENT_API_BASE` | OpenAI 兼容 Base URL |
| `DS_AGENT_API_KEY` | API Key |
| `DS_AGENT_API_MODEL` | 可选默认模型 id |

base / key 都没设就用 MockModel。

常用分工：

- **Router**：轻量、便宜的（分派、批处理、短回复）  
- **Worker**：强一点的（写代码、长工具链）  
- **Watchdog**：轻量就行  

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### 目录

```
src/shared/     类型与端口
src/harness/    session、loop、model、tools、daemon
src/store/      SQLite + Spill
src/core/       Engine + 订阅扇出
src/ingress/    两级过滤
src/memory/     Inline / Spill 召回
src/speculate/  静默 Assignment + deliver gate
src/channels/   CLI / 假 IM / 假 GitHub
src/env/        LocalEnv
src/watchdog/   控制回路
src/cli/        CLI 装配
scripts/demo.ts
```

### 许可

[MIT](./LICENSE) · Copyright (c) LoomLab contributors.

### 免责

**deepseek-super-agent / ds-agent 跟 DeepSeek 没有隶属或背书关系。** 思路来自公开文章和开源原型，实现是 LoomLab 自己的，拿来学习实验可以，出事自负。

- 文章：[Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- 原型：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)

---

## English

**ds-agent** is a TypeScript runtime that follows the Super-agent ideas from a public design post: a thin **Harness** (session log, async ReAct, OpenAI-compatible calls, role tools, daemon) plus a domain **Engine** (Intake / Evals / Tickets / Assignments / Replies). No DeepSeek Harness. No Cordis.

### Inspiration

Public sources are design input only. The code is LoomLab’s.

| Source | Link | How it’s used |
|--------|------|----------------|
| WeChat post | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | Goals in §2–§6: dual Router/Worker, Triggers, async ReAct, channels, compute/state/env split, Watchdog |
| Official prototype | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Domain flow Trigger → Eval → Ticket → Assignment; reimplemented on our Harness |

No `@deepseek-ai/dsh*` dependency.

### Features vs blog

Mapped to the same post. Boxes are design targets in this repo; treat `pnpm demo` as the source of truth for what actually runs.

- [ ] **Dual Router / Worker** — Router for chat & dispatch; isolated Worker sessions (§2)
- [ ] **Async ReAct** — `start()` / completion events; long tools don’t block the front (§2.2, §4.1)
- [ ] **Triggers + two-level filter** — Fast Path cuts noise; Slow Path does semantic/policy (§3.1)
- [ ] **SQLite persistence** — survives restart (§5.1)
- [ ] **Thread subscription fan-out** — subscribed events can skip Router Eval (§3.2)
- [ ] **Inline / Spill recall** — summaries + `read_object(id)` (§3.3)
- [ ] **Speculative work** — silent Assignment until deliver gate (§3.4)
- [ ] **Channels** — CLI / fake IM / fake GitHub outbound norms (§4.2)
- [ ] **Compute / state / env split** — Store vs LocalEnv sandbox (§5)
- [ ] **BYOM** — `DS_AGENT_API_*` for OpenAI-compatible HTTP; side daemon (§5.2)
- [ ] **Watchdog** — outer control loop; nudge / fail stuck Workers (§6)

Without keys, runtime uses **MockModel**.

### Architecture

```
Channel     CLI / fake IM / fake GitHub (I/O only; no domain writes)
   │
Ingress     Fast Path + Slow Path; Thread keys
   │
Engine      Intake → Eval (batchable) → Ticket / Assignment
            subscription fan-out may bypass Eval; sole domain writer
   │
Harness     Session · async ReAct · Mock/HTTP model · tools
            Router / Worker / Watchdog sessions
   │
Store       SQLite + Spill          Env: LocalEnv / BYOM daemon
```

Event → Ingress → `Engine.receive` → Eval → Ticket + Assignment → Worker → report → channel outbox. Watchdog watches stuck Workers from outside.

| Layer | Job |
|-------|-----|
| **Harness** | Session, loop, model client, tools, daemon |
| **Engine** | Writes Trigger / Thread / Decision / Ticket / Assignment |
| **Store** | SQLite + Spill |
| **Channels** | Inbound adapters, outbound reply shape |
| **Env** | Sandbox workdir / process, separate from durable state |
| **Watchdog** | Timer: stuck Worker → nudge / fail |

### Quick start

Node.js 20+ and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm demo      # scripted scenario; MockModel by default
pnpm start     # daemon / CLI ingress
pnpm test
```

### Demo

`pnpm demo` feeds a synthetic IM + GitHub-style stream. You should roughly see:

1. Noise Triggers dropped by the two-level filter  
2. Actionable message → Ticket → Worker Assignment  
3. Same-Thread follow-up with `bypass=subscription` (+ `ticketId`)  
4. A second parallel Worker can start  
5. Spill write + `read_object` recall  
6. Speculative Assignment hidden until the deliver gate  
7. Watchdog tick can nudge / fail  
8. Store still there after restart  
9. No `@deepseek-ai/dsh*` in the tree  

### Model configuration

| Variable | Meaning |
|----------|---------|
| `DS_AGENT_API_BASE` | OpenAI-compatible base URL |
| `DS_AGENT_API_KEY` | API key |
| `DS_AGENT_API_MODEL` | Optional default model id |

Unset base/key → MockModel.

Usual split:

- **Router** — cheap/fast (dispatch, batching, short replies)  
- **Worker** — stronger (code, long tool chains)  
- **Watchdog** — lightweight is fine  

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### Layout

```
src/shared/     types & ports
src/harness/    session, loop, model, tools, daemon
src/store/      SQLite + Spill
src/core/       Engine + subscribe fan-out
src/ingress/    two-level filter
src/memory/     Inline / Spill recall
src/speculate/  silent Assignment + deliver gate
src/channels/   CLI / fake IM / fake GitHub
src/env/        LocalEnv
src/watchdog/   control loop
src/cli/        CLI wiring
scripts/demo.ts
```

### License

[MIT](./LICENSE) · Copyright (c) LoomLab contributors.

### Disclaimer

**deepseek-super-agent / ds-agent is not affiliated with, endorsed by, or an official product of DeepSeek.** Ideas come from a public post and an open prototype; the implementation is LoomLab’s, for learning and experiments. Use at your own risk.

- Post: [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- Prototype: [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
