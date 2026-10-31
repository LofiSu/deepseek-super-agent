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

对照上面那篇文章。下列是设计目标，是否跑通以本机 `pnpm demo` 为准。

- [ ] 双层 Router / Worker（§2）
- [ ] 异步 ReAct：`start()` 与完成事件，长工具不堵前台（§2.2、§4.1）
- [ ] Trigger + Fast / Slow 两级过滤（§3.1）
- [ ] SQLite，重启可恢复（§5.1）
- [ ] Thread 订阅扇出，可绕过 Router Eval（§3.2）
- [ ] Inline / Spill + `read_object`（§3.3）
- [ ] 投机 Assignment，过 deliver gate 再对外（§3.4）
- [ ] CLI / 假 IM / 假 GitHub（§4.2）
- [ ] Store 与 LocalEnv 沙箱分开（§5）
- [ ] `DS_AGENT_API_*` 接自有模型 + daemon（§5.2）
- [ ] Watchdog：卡住就 nudge / fail（§6）

没配 Key 时用 MockModel。

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

Design targets from the article. Trust `pnpm demo` for what actually runs.

- [ ] Dual Router / Worker (§2)
- [ ] Async ReAct: `start()` / completion events (§2.2, §4.1)
- [ ] Triggers + Fast / Slow filter (§3.1)
- [ ] SQLite across restart (§5.1)
- [ ] Thread subscription fan-out (§3.2)
- [ ] Inline / Spill + `read_object` (§3.3)
- [ ] Speculative Assignment + deliver gate (§3.4)
- [ ] CLI / fake IM / fake GitHub (§4.2)
- [ ] Store vs LocalEnv (§5)
- [ ] `DS_AGENT_API_*` BYOM + daemon (§5.2)
- [ ] Watchdog nudge / fail (§6)

No key → MockModel.

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
