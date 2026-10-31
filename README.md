# deepseek-super-agent

LoomLab 开源 · CLI：`ds-agent` · MIT  
Open-source Super-agent style framework · CLI: `ds-agent` · MIT

> **非官方 / Not official:** 本仓库**不是** DeepSeek 官方产品。研究与教学向原型，不适合直接上生产。  
> **Not** an official DeepSeek product. Research / educational prototype — not production-ready.

| | |
|---|---|
| 中文 | [简介与灵感来源](#中文) · [能力对照](#能力对照博客) · [架构](#架构) · [快速开始](#快速开始) · [Demo](#demo-证明什么) · [模型配置](#模型配置) · [许可](#许可) |
| English | [Intro & inspiration](#english) · [Features](#features-mapped-to-the-blog) · [Architecture](#architecture-1) · [Quick start](#quick-start) · [Demo](#what-the-demo-proves) · [Models](#model-configuration) · [License](#license-1) |

---

## 中文

**ds-agent** 是 LoomLab 用 TypeScript 实现的开源 Super-agent：自研最薄 **Harness**（Session 事件日志、异步工具 / ReAct 循环、OpenAI 兼容模型调用、按角色注册工具、daemon）+ **领域引擎**（Intake / Evals / Tickets / Assignments / Replies）。**不依赖** DeepSeek Harness / Cordis。

### 灵感来源

我们以公开资料为灵感**独立实现**：不是 DeepSeek Harness / Cordis 的拷贝，也不是官方产品。

| 来源 | 链接 | 我们如何用 |
|------|------|------------|
| 微信设计文章 | [Super-agent 设计探索：迈向更自主的 Agent 系统](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | §2–§6 架构目标：双层 Router/Worker、Trigger、异步 ReAct、多信道、存算与环境分离、Watchdog |
| 官方原型仓 | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | 领域词汇与引擎语义（Trigger → Eval → Ticket → Assignment）；在我们自研 Harness 上重写 |

技术栈：TypeScript + `ds-agent` CLI。无 `@deepseek-ai/dsh*` 依赖。

### 能力对照（博客）

对照 [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)：

- [x] **连续双层 Router / Worker** — Router 常驻交互与分派；Worker Session 隔离并发（§2）
- [x] **高效并行 + 异步 ReAct** — `start()` / 任务完成事件，前台不阻塞（§2.2、§4.1）
- [x] **主动 Trigger + 两级过滤** — Fast Path 程序去噪，Slow Path 语义 / 策略（§3.1）
- [x] **SQLite 持久状态** — 进程重启后可恢复（§5.1）
- [x] **Thread 订阅扇出** — 已订阅事件绕过 Router Eval，直达 Ticket / Worker（§3.2）
- [x] **Inline / Spill 链式召回** — 摘要 + spillId；`read_object(id)` 多跳取回（§3.3）
- [x] **投机执行** — 静默 Assignment，通过 deliver gate 后才对外可见（§3.4）
- [x] **多信道规范** — CLI / 假 IM / 假 GitHub，按信道定制回复（§4.2）
- [x] **计算 / 状态 / 环境分离** — Store 与 LocalEnv 沙箱解耦（§5）
- [x] **BYOM** — `DS_AGENT_API_*` 接 OpenAI 兼容 HTTP；端侧 daemon（§5.2）
- [x] **Watchdog** — 外部控制回路 Session，卡住则 nudge / fail（§6）

默认用 **MockModel** 跑 Demo，不配 API Key 也能验收。

### 架构

最薄 Harness（可注入循环与端口）+ 领域引擎。无 Cordis 插件树。

#### 分层

```
Channel 层     CLI / 假 IM / 假 GitHub（出站规范；不写领域状态）
    │
Ingress        Fast Path 程序过滤 + Slow Path 语义策略；Thread key
    │
Domain Engine  Intake → Eval（批处理）→ Ticket / Mandate → Assignment
               订阅扇出可 bypass Eval；唯一写聚合根
    │
Harness        Session 日志 · 异步 ReAct · Mock / HTTP 模型 · 工具注册
               Router / Worker / Watchdog Session
    │
Store          SQLite + Spill          Env：LocalEnv / BYOM daemon（无会话状态）
```

**数据流：** 事件经 Ingress 进入 `Engine.receive`，再经 Intake、Eval 队列（可批处理）生成 Ticket 与 Assignment；Worker Session 执行后向 Router 汇报，再按信道 Outbox 写出。Watchdog 作为外部 Control Loop 运行。

| 层 | 职责 |
|----|------|
| **Harness** | Session 日志、异步循环、模型客户端、工具、daemon |
| **Engine** | 唯一写入 Trigger / Thread / Decision / Ticket / Assignment |
| **Store** | SQLite 仓储 + Spill 对象存储 |
| **Channels** | 入站适配与出站回复规范 |
| **Env** | 沙箱工作目录与进程，与持久状态分离 |
| **Watchdog** | 定时检测卡住的 Worker → nudge / fail |

### 快速开始

需要 Node.js 20+ 与 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm demo      # 脚本场景；默认 MockModel
pnpm start     # 常驻 daemon / CLI 入站
pnpm test
```

### Demo 证明什么

`pnpm demo` 跑合成 IM + GitHub 风格事件流，日志 / 断言应能看到：

1. 噪声 Trigger 被两级过滤丢弃  
2. 可行动 IM → Ticket → Worker Assignment  
3. 同 Thread 人消息 `bypass=subscription`（含 `ticketId`），不再 Eval  
4. 可启动第二个并行 Worker  
5. Spill 写入 + `read_object` 链式召回  
6. 投机 Assignment 在 gate 前对外不可见  
7. Watchdog tick 可 nudge / fail 卡住的 Worker  
8. 进程重启后 Store 仍可恢复  
9. **无** `@deepseek-ai/dsh*` 依赖  

### 模型配置

| 变量 | 作用 |
|------|------|
| `DS_AGENT_API_BASE` | OpenAI 兼容 API Base（如 DeepSeek、OpenAI、Groq） |
| `DS_AGENT_API_KEY` | API Key |
| `DS_AGENT_API_MODEL` | 可选默认模型 id |

未设置 base / key 时走 **MockModel**。

建议分工：

- **Router**：轻量 / 快速模型（分派、批处理、短回复）  
- **Worker**：强模型（编码、长工具链）  
- **Watchdog**：轻量模型即可  

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### 仓库布局

```
src/shared/     类型与端口
src/harness/    Session、loop、model、tools、daemon
src/store/      SQLite + Spill
src/core/       Engine + 订阅扇出
src/ingress/    两级过滤
src/memory/     Inline / Spill 链式召回
src/speculate/  静默 Assignment + deliver gate
src/channels/   CLI / 假 IM / 假 GitHub
src/env/        LocalEnv
src/watchdog/   外部控制回路
src/cli/        CLI 装配
scripts/demo.ts
```

### 许可

[MIT](./LICENSE) · Copyright (c) LoomLab contributors.

### 免责声明

**deepseek-super-agent / ds-agent 与 DeepSeek 无隶属或背书关系，也不是官方产品。** 思路来自公开文章与开源原型，由 LoomLab 独立实现，供学习与实验；风险自负。

- 文章：[Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- 原型：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)

---

## English

**ds-agent** is LoomLab’s MIT open-source Super-agent in TypeScript: a **self-built thinnest Harness** (session event log, async tool / ReAct loop, OpenAI-compatible models, role-based tool registry, daemon) plus a **domain engine** (Intake / Evals / Tickets / Assignments / Replies). It does **not** depend on DeepSeek Harness / Cordis.

### Sources & inspiration (top of the English section)

We treat the public materials as **inspiration** and ship an independent LoomLab implementation — **not** a copy of DeepSeek Harness / Cordis, and **not** an official DeepSeek product.

| Source | Link | How we use it |
|--------|------|----------------|
| WeChat design article | [Super-agent 设计探索：迈向更自主的 Agent 系统](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | Architecture goals (§2–§6): dual Router/Worker, Triggers, async ReAct, channels, compute/state/env split, Watchdog |
| Official prototype | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Domain vocabulary & Engine semantics (Trigger → Eval → Ticket → Assignment); reimplemented on our own thin Harness |

Stack: TypeScript + `ds-agent` CLI. No `@deepseek-ai/dsh*` dependency.

### Features (mapped to the blog)

Checklist against [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg):

- [x] **Continuous dual-layer Router / Worker** — resident Router for interaction & dispatch; isolated Worker sessions (blog §2)
- [x] **Efficient parallel workers + async ReAct** — non-blocking `start()` / job completion events (blog §2.2, §4.1)
- [x] **Proactive Triggers + two-level filtering** — Fast Path programmatic cut, Slow Path semantic / policy (blog §3.1)
- [x] **Persistent SQLite state** — survives process restart (blog §5.1)
- [x] **Thread subscription fan-out** — subscribed events bypass Router Eval to Ticket / Worker (blog §3.2)
- [x] **Inline / Spill Chain of Recall** — summaries + spill IDs; `read_object(id)` multi-hop (blog §3.3)
- [x] **Speculative execution** — silent Assignments; visible only after deliver gate (blog §3.4)
- [x] **Multi-channel norms** — CLI / fake IM / fake GitHub reply styles (blog §4.2)
- [x] **Compute / state / env separation** — Store vs LocalEnv sandbox (blog §5)
- [x] **BYOM** — OpenAI-compatible HTTP via `DS_AGENT_API_*`; side daemon (blog §5.2)
- [x] **Watchdog** — external control-loop Session; nudge / fail stuck Workers (blog §6)

The default demo uses **MockModel**, so you can verify the path without an API key.

### Architecture

Thinnest Harness (injectable loop + ports) + domain Engine. No Cordis plugin tree.

#### Layers

```
Channel layer   CLI / fake IM / fake GitHub (outbound norms; no domain writes)
    │
Ingress         Fast Path (deterministic) + Slow Path (LLM policy); Thread keys
    │
Domain Engine   Intake → Eval (batch) → Ticket / Mandate → Assignment
                Subscription fan-out may bypass Eval; sole writer of aggregates
    │
Harness         Session log · async ReAct · Mock / HTTP model · tool registry
                Router / Worker / Watchdog Sessions
    │
Store           SQLite + Spill          Env: LocalEnv / BYOM daemon (no session state)
```

**Data flow:** event → Ingress → `Engine.receive` → Intake → Eval queue / batching → Ticket + Assignment → Worker Session → report → Router Outbox by channel norms. Watchdog is an external Control Loop.

| Layer | Responsibility |
|-------|----------------|
| **Harness** | Session log, async loop, model client, tools, daemon |
| **Engine** | Sole writer of Trigger / Thread / Decision / Ticket / Assignment |
| **Store** | SQLite repositories + Spill object store |
| **Channels** | Ingress adapters + outbound reply norms |
| **Env** | Sandbox workdir / process — separated from durable state |
| **Watchdog** | Timer Session: stuck Worker → nudge / fail |

### Quick start

Node.js 20+ and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm demo      # scripted scenario; MockModel by default
pnpm start     # long-running daemon / CLI ingress
pnpm test
```

### What the demo proves

`pnpm demo` runs a synthetic IM + GitHub-style stream. Logs / assertions should show:

1. Noise Triggers dropped by two-level filtering  
2. Actionable IM → Ticket → Worker Assignment  
3. Same-Thread human follow-up with `bypass=subscription` (+ `ticketId`)  
4. A second parallel Worker can start  
5. Spill write + `read_object` chained recall  
6. Speculative Assignment invisible until deliver gate  
7. Watchdog tick can nudge / fail a stuck Worker  
8. Store persistence across process restart  
9. **No** `@deepseek-ai/dsh*` dependency  

### Model configuration

| Variable | Role |
|----------|------|
| `DS_AGENT_API_BASE` | OpenAI-compatible API base URL |
| `DS_AGENT_API_KEY` | API key |
| `DS_AGENT_API_MODEL` | Optional default model id |

If base and key are unset, the runtime uses **MockModel**.

Recommended slots:

- **Router** — lightweight / fast (dispatch, batching, short replies)  
- **Worker** — strong model (code / long tool use)  
- **Watchdog** — lightweight is enough  

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### Project layout

```
src/shared/     types & ports
src/harness/    session, loop, model, tools, daemon
src/store/      SQLite + Spill
src/core/       Engine + subscribe fan-out
src/ingress/    two-level filter
src/memory/     Inline / Spill Chain of Recall
src/speculate/  silent Assignment + deliver gate
src/channels/   CLI / fake IM / fake GitHub
src/env/        LocalEnv
src/watchdog/   external control loop
src/cli/        CLI assembly
scripts/demo.ts
```

### License

[MIT](./LICENSE) · Copyright (c) LoomLab contributors.

### Disclaimer

**deepseek-super-agent / ds-agent is not affiliated with, endorsed by, or an official product of DeepSeek.** We reimplement Super-agent *ideas* from public writing and the open prototype for learning and experimentation. Use at your own risk.

- Blog: [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- Prototype: [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
