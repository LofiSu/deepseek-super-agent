# deepseek-super-agent

CLI：`ds-agent` · MIT · LoomLab

按公开 Super-agent 文章的思路，用 TypeScript 写的薄运行时：下层是自研 Harness，上层是领域引擎。

作者 [LofiSu](https://github.com/LofiSu) 与 [Grokbot（CoderBot）](https://cursor.com) 合作完成。

思路来源于 DeepSeek 的公开文章和原型，由本人独立实现。

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

不依赖 DeepSeek Harness，也不依赖 Cordis；依赖树里没有 `@deepseek-ai/dsh*`。

### 灵感来源

| 来源 | 链接 | 参考内容 |
|------|------|----------|
| 微信文章 | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | §2–§6：双层 Router/Worker、Trigger、异步工具、多信道、状态与环境分离、Watchdog |
| 官方原型 | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | 领域流程 Trigger → Eval → Ticket → Assignment；Harness 自研，不搬 DSH 代码 |

### 能力清单

对照上面那篇文章。下列是设计目标，是否跑通以本机 `pnpm demo` 为准。

- [ ] 双层 Router / Worker（§2）
- [ ] 异步 ReAct：`start()` 与任务完成事件，长工具不堵住前台（§2.2、§4.1）
- [ ] Trigger + Fast Path / Slow Path 两级过滤（§3.1）
- [ ] SQLite 持久化，进程重启后可恢复（§5.1）
- [ ] Thread 订阅扇出，已订阅事件可绕过 Router Eval（§3.2）
- [ ] Inline / Spill 记忆，用 `read_object(id)` 链式取回（§3.3）
- [ ] 投机执行：先静默跑 Assignment，过 deliver gate 再对外可见（§3.4）
- [ ] 多信道：CLI、假 IM、假 GitHub（§4.2）
- [ ] Store 与 LocalEnv 沙箱分开（§5）
- [ ] 用 `DS_AGENT_API_*` 接入自有模型；端侧 daemon（§5.2）
- [ ] Watchdog：卡住的 Worker 可 nudge 或 fail（§6）

未配置 API Key 时默认使用 MockModel。

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

事件从信道进入 Ingress，再进入 `Engine.receive`。Eval 之后生成 Ticket 与 Assignment；Worker Session 执行完向 Router 汇报，再按信道格式写出。Watchdog 在外侧检查卡住的任务。

| 层 | 职责 |
|----|------|
| Harness | Session、循环、模型客户端、工具、daemon |
| Engine | 写入 Trigger、Thread、Decision、Ticket、Assignment |
| Store | SQLite 与 Spill 对象 |
| Channels | 入站适配、出站回复格式 |
| Env | 沙箱工作目录与进程 |
| Watchdog | 定时检查卡住的 Worker |

### 快速开始

需要 Node.js 20+ 与 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm demo      # 脚本场景，默认 MockModel
pnpm start     # 常驻进程 / CLI 入站
pnpm test
```

### Demo

`pnpm demo` 会注入一批合成的 IM / GitHub 风格事件。日志里大致应能看到：

1. 噪声类 Trigger 被两级过滤丢掉  
2. 可行动消息变成 Ticket，再派给 Worker  
3. 同一 Thread 的跟进带 `bypass=subscription`（含 `ticketId`）  
4. 可再起一个并行 Worker  
5. Spill 写入，以及 `read_object` 链式召回  
6. 投机 Assignment 在过 gate 前对外不可见  
7. Watchdog tick 可 nudge 或 fail  
8. 进程重启后 Store 数据仍在  
9. 依赖里没有 `@deepseek-ai/dsh*`

### 模型配置

| 环境变量 | 作用 |
|----------|------|
| `DS_AGENT_API_BASE` | OpenAI 兼容 API Base |
| `DS_AGENT_API_KEY` | API Key |
| `DS_AGENT_API_MODEL` | 可选，默认模型 id |

未设置 base / key 时使用 MockModel。

建议：Router、Watchdog 用轻量模型；Worker 用更强的模型做编码和长工具链。

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

作者 [LofiSu](https://github.com/LofiSu) 与 [Grokbot（CoderBot）](https://cursor.com) 合作完成。

### 许可

[MIT](./LICENSE)

思路来源于 DeepSeek 的公开文章和原型，由本人独立实现。

- [微信文章](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- [官方原型](https://github.com/deepseek-ai/dsh-superagent-prototype)

---

## English

### What this is

`ds-agent` has two layers:

- **Harness** — session event log, async ReAct loop, OpenAI-compatible model calls, role-based tools, and a long-running daemon.
- **Engine** — Intake → Eval → Ticket → Assignment → Reply. Domain state is written only here.

No DeepSeek Harness, no Cordis, and no `@deepseek-ai/dsh*` in the dependency tree.

Author [LofiSu](https://github.com/LofiSu), co-written with [Grokbot (CoderBot)](https://cursor.com).

Inspired by DeepSeek's public article and prototype; implemented independently.

### Inspiration

| Source | Link | What we used |
|--------|------|--------------|
| WeChat article | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | Goals from §2–§6: dual Router/Worker, Triggers, async tools, channels, state/env split, Watchdog |
| Official prototype | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Domain flow Trigger → Eval → Ticket → Assignment; Harness is ours, not a DSH port |

### Feature checklist

Mapped to the article above. These are design targets — run `pnpm demo` locally to see what actually works.

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

Without an API key, the runtime uses MockModel.

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

Practical split: lightweight models for Router and Watchdog; a stronger model for Worker (coding and long tool chains).

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

Author [LofiSu](https://github.com/LofiSu), co-written with [Grokbot (CoderBot)](https://cursor.com).

### License

[MIT](./LICENSE)

Inspired by DeepSeek's public article and prototype; implemented independently.

- [WeChat article](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- [Official prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
