# deepseek-super-agent

CLI：`ds-agent` · 协议：MIT · 出品：LoomLab

按公开文章里的 Super-agent 思路，用 TypeScript 写的一套薄运行时：底下是自研 Harness，上面是领域引擎。本仓库与 DeepSeek 没有官方关系，目前只适合拿来研究、改着玩，不要直接部署到生产。

作者是 [LofiSu](https://github.com/LofiSu)，与 [Grokbot（CoderBot）](https://cursor.com) 共同完成。

| | |
|---|---|
| 中文 | [灵感来源](#灵感来源) · [能力清单](#能力清单) · [架构](#架构) · [快速开始](#快速开始) · [Demo](#demo) · [模型配置](#模型配置) · [致谢](#致谢) · [许可](#许可) |
| English | [Inspiration](#inspiration) · [Feature checklist](#feature-checklist) · [Architecture](#architecture) · [Quick start](#quick-start) · [Demo](#demo-1) · [Model config](#model-config) · [Credits](#credits) · [License](#license) |

---

## 中文

### 这是什么

`ds-agent` 分两层：

- **Harness**：Session 事件日志、异步 ReAct 循环、OpenAI 兼容的模型调用、按角色注册工具、常驻 daemon。
- **Engine**：Intake → Eval → Ticket → Assignment → Reply。领域状态只在这一层写入。

不依赖 DeepSeek Harness，也不依赖 Cordis，依赖树里没有 `@deepseek-ai/dsh*`。

### 灵感来源

设计参考两份公开材料，代码是重新实现的：

| 来源 | 链接 | 用到了什么 |
|------|------|------------|
| 微信文章 | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | §2–§6：双层 Router/Worker、Trigger、异步工具、多信道、状态与环境分离、Watchdog |
| 官方原型 | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | 领域流程 Trigger → Eval → Ticket → Assignment；Harness 自研，不搬 DSH 代码 |

### 能力清单

对照上面那篇文章。这些是设计目标，不是「已经全部跑绿」——以本机 `pnpm demo` 为准。

- [ ] 双层 Router / Worker（§2）
- [ ] 异步 ReAct：`start()` 和任务完成事件，长工具不堵住前台（§2.2、§4.1）
- [ ] Trigger + Fast Path / Slow Path 两级过滤（§3.1）
- [ ] SQLite 持久化，进程重启后还能恢复（§5.1）
- [ ] Thread 订阅扇出，已订阅事件可以绕过 Router Eval（§3.2）
- [ ] Inline / Spill 记忆，用 `read_object(id)` 链式取回（§3.3）
- [ ] 投机执行：先静默跑 Assignment，过 deliver gate 再对外可见（§3.4）
- [ ] 多信道：CLI、假 IM、假 GitHub（§4.2）
- [ ] Store 和 LocalEnv 沙箱分开（§5）
- [ ] 用 `DS_AGENT_API_*` 接自己的模型；端侧 daemon（§5.2）
- [ ] Watchdog：发现卡住的 Worker 就 nudge 或 fail（§6）

没有配置 API Key 时，默认走 MockModel，方便先把流水线跑通。

### 架构

```
Channel    CLI / 假 IM / 假 GitHub
    │
Ingress    Fast Path + Slow Path，算出 Thread key
    │
Engine     Intake → Eval → Ticket / Assignment
    │
Harness    Session、异步 ReAct、模型、工具
    │
Store      SQLite + Spill          Env：LocalEnv / daemon
```

事件从信道进来，经过 Ingress，进入 `Engine.receive`。Eval 之后生成 Ticket 和 Assignment，Worker Session 执行完再向 Router 汇报，最后按信道格式写出。Watchdog 在外侧盯着卡住的任务。

| 层 | 做什么 |
|----|--------|
| Harness | Session、循环、模型客户端、工具、daemon |
| Engine | 写入 Trigger、Thread、Decision、Ticket、Assignment |
| Store | SQLite 和 Spill 对象 |
| Channels | 入站适配、出站回复格式 |
| Env | 沙箱工作目录和进程 |
| Watchdog | 定时检查卡住的 Worker |

### 快速开始

需要 Node.js 20+ 和 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm demo      # 脚本场景，默认 MockModel
pnpm start     # 常驻进程 / CLI 入站
pnpm test
```

### Demo

`pnpm demo` 会注入一批合成的 IM / GitHub 风格事件。日志里大致应该能看到：

1. 噪声类 Trigger 被两级过滤丢掉  
2. 可行动的消息变成 Ticket，再派给 Worker  
3. 同一 Thread 的跟进消息带上 `bypass=subscription`（含 `ticketId`）  
4. 可以再起一个并行 Worker  
5. Spill 写入，以及 `read_object` 链式召回  
6. 投机 Assignment 在过 gate 之前对外不可见  
7. Watchdog 的 tick 能 nudge 或 fail  
8. 进程重启之后 Store 里的数据还在  
9. 依赖里没有 `@deepseek-ai/dsh*`

### 模型配置

| 环境变量 | 作用 |
|----------|------|
| `DS_AGENT_API_BASE` | OpenAI 兼容的 API Base |
| `DS_AGENT_API_KEY` | API Key |
| `DS_AGENT_API_MODEL` | 可选，默认模型 id |

base 和 key 都没设时用 MockModel。

常见分工：Router 和 Watchdog 用轻量模型；Worker 用更强的模型做编码和长工具链。

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### 目录结构

```
src/harness/     Session、loop、model、tools、daemon
src/core/        Engine
src/store/       SQLite + Spill
src/ingress/     两级过滤
src/memory/      Inline / Spill
src/speculate/   deliver gate
src/channels/    CLI / 假 IM / 假 GitHub
src/env/         LocalEnv
src/watchdog/    控制回路
src/cli/         命令行装配
scripts/demo.ts
```

### 致谢

作者 [LofiSu](https://github.com/LofiSu)（LoomLab）与 [Grokbot（CoderBot）](https://cursor.com) 共同完成。

### 许可

[MIT](./LICENSE)

本项目与 DeepSeek 无隶属、无背书关系。思路来自公开文章和开源原型，实现由 LoomLab 独立完成，仅供学习与实验，使用风险自负。

- 文章：[Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- 原型：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)

---

## English

### What this is

`ds-agent` has two layers:

- **Harness** — session event log, async ReAct loop, OpenAI-compatible model calls, role-based tools, and a long-running daemon.
- **Engine** — Intake → Eval → Ticket → Assignment → Reply. Domain state is written only here.

It does not depend on DeepSeek Harness or Cordis, and there is no `@deepseek-ai/dsh*` in the dependency tree.

This is an unofficial research project under LoomLab. It is fine for learning and tinkering; do not ship it to production as-is.

Author: [LofiSu](https://github.com/LofiSu), co-written with [Grokbot (CoderBot)](https://cursor.com).

### Inspiration

Two public sources shaped the design. The code is a fresh implementation:

| Source | Link | What we used |
|--------|------|--------------|
| WeChat article | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | Goals from §2–§6: dual Router/Worker, Triggers, async tools, channels, state/env split, Watchdog |
| Official prototype | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Domain flow Trigger → Eval → Ticket → Assignment; Harness is ours, not a DSH port |

### Feature checklist

Mapped to the article above. These are design targets, not a claim that CI is all green — trust `pnpm demo` on your machine.

- [ ] Dual Router / Worker (§2)
- [ ] Async ReAct: `start()` and completion events so long tools do not block the front (§2.2, §4.1)
- [ ] Triggers with Fast Path / Slow Path filtering (§3.1)
- [ ] SQLite persistence across process restart (§5.1)
- [ ] Thread subscription fan-out that can skip Router Eval (§3.2)
- [ ] Inline / Spill memory via `read_object(id)` (§3.3)
- [ ] Speculative Assignments, visible only after the deliver gate (§3.4)
- [ ] Channels: CLI, fake IM, fake GitHub (§4.2)
- [ ] Store separated from the LocalEnv sandbox (§5)
- [ ] Bring your own model with `DS_AGENT_API_*`, plus a side daemon (§5.2)
- [ ] Watchdog that nudges or fails stuck Workers (§6)

If no API key is set, the runtime uses MockModel so you can walk the pipeline first.

### Architecture

```
Channel    CLI / fake IM / fake GitHub
    │
Ingress    Fast Path + Slow Path → Thread key
    │
Engine     Intake → Eval → Ticket / Assignment
    │
Harness    Session, async ReAct, model, tools
    │
Store      SQLite + Spill          Env: LocalEnv / daemon
```

Events enter through a channel, pass Ingress, then `Engine.receive`. After Eval you get Tickets and Assignments; a Worker session runs them and reports back to the Router, which writes outbound replies. Watchdog sits outside and watches for stuck work.

| Layer | Responsibility |
|-------|----------------|
| Harness | Session, loop, model client, tools, daemon |
| Engine | Writes Trigger, Thread, Decision, Ticket, Assignment |
| Store | SQLite and Spill objects |
| Channels | Inbound adapters and outbound reply shape |
| Env | Sandbox workdir and process |
| Watchdog | Periodically checks stuck Workers |

### Quick start

Node.js 20+ and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm demo      # scripted scenario; MockModel by default
pnpm start     # long-running process / CLI ingress
pnpm test
```

### Demo

`pnpm demo` feeds a synthetic IM / GitHub-style event stream. In the logs you should roughly see:

1. Noisy Triggers dropped by the two-level filter  
2. Actionable messages turned into Tickets, then Worker Assignments  
3. Same-Thread follow-ups marked `bypass=subscription` (with `ticketId`)  
4. A second parallel Worker can start  
5. Spill writes and `read_object` recall  
6. Speculative Assignments hidden until the deliver gate  
7. Watchdog ticks that can nudge or fail  
8. Store data still there after a restart  
9. No `@deepseek-ai/dsh*` in the dependency tree  

### Model config

| Variable | Meaning |
|----------|---------|
| `DS_AGENT_API_BASE` | OpenAI-compatible API base URL |
| `DS_AGENT_API_KEY` | API key |
| `DS_AGENT_API_MODEL` | Optional default model id |

If base and key are unset, MockModel is used.

A practical split: lightweight models for Router and Watchdog; a stronger model for Worker (coding and long tool chains).

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### Layout

```
src/harness/     session, loop, model, tools, daemon
src/core/        Engine
src/store/       SQLite + Spill
src/ingress/     two-level filter
src/memory/      Inline / Spill
src/speculate/   deliver gate
src/channels/    CLI / fake IM / fake GitHub
src/env/         LocalEnv
src/watchdog/    control loop
src/cli/         CLI wiring
scripts/demo.ts
```

### Credits

Author [LofiSu](https://github.com/LofiSu) (LoomLab), co-written with [Grokbot (CoderBot)](https://cursor.com).

### License

[MIT](./LICENSE)

Not affiliated with or endorsed by DeepSeek. Ideas come from a public article and an open prototype; the implementation is LoomLab’s, for learning and experiments. Use at your own risk.

- Article: [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- Prototype: [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
