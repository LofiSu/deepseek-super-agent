# deepseek-super-agent

`ds-agent` · MIT · LoomLab

TypeScript 实验项目：按公开 Super-agent 文章的思路，自己写了一套薄 Harness + 领域引擎。  
**不是** DeepSeek 官方产品，也别拿去直接上生产。

和 [Grokbot（CoderBot）](https://cursor.com) 一起写完的。

| | |
|---|---|
| 中文 | [灵感](#灵感来源) · [对照](#和博客的对照) · [架构](#架构) · [跑起来](#跑起来) · [Demo](#demo) · [模型](#模型) · [致谢](#致谢) · [许可](#许可) |
| English | [Inspiration](#inspiration) · [Checklist](#checklist-vs-blog) · [Architecture](#architecture) · [Run](#run) · [Demo](#demo-1) · [Models](#models) · [Credits](#credits) · [License](#license) |

---

## 中文

核心就两块：

1. **Harness** — Session 日志、异步 ReAct、OpenAI 兼容调用、按角色挂工具、daemon  
2. **Engine** — Intake → Eval → Ticket → Assignment → Reply  

不依赖 DeepSeek Harness，也不依赖 Cordis。没有 `@deepseek-ai/dsh*`。

### 灵感来源

| 来源 | 链接 | 我们拿了什么 |
|------|------|--------------|
| 微信文 | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | §2–§6 的目标：双层 Router/Worker、Trigger、异步工具、多信道、存算/环境拆开、Watchdog |
| 官方原型 | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | 领域词：Trigger → Eval → Ticket → Assignment；Harness 自己写，不搬 DSH |

### 和博客的对照

下面是设计目标。勾上不等于已经全绿——以 `pnpm demo` 为准。

- [ ] 双层 Router / Worker（§2）
- [ ] 异步 ReAct：`start()` / 完成事件，长工具不堵前台（§2.2、§4.1）
- [ ] Trigger + Fast/Slow 两级过滤（§3.1）
- [ ] SQLite，重启可恢复（§5.1）
- [ ] Thread 订阅扇出，可绕过 Router Eval（§3.2）
- [ ] Inline / Spill + `read_object`（§3.3）
- [ ] 投机 Assignment，过 deliver gate 再对外（§3.4）
- [ ] CLI / 假 IM / 假 GitHub 多信道（§4.2）
- [ ] Store 和 LocalEnv 沙箱分开（§5）
- [ ] `DS_AGENT_API_*` BYOM + 端侧 daemon（§5.2）
- [ ] Watchdog：卡住就 nudge / fail（§6）

没配 Key 就用 MockModel。

### 架构

```
Channel   CLI / 假 IM / 假 GitHub
   │
Ingress   Fast Path + Slow Path → Thread key
   │
Engine    Intake → Eval → Ticket / Assignment（领域只在这写）
   │
Harness   Session · 异步 ReAct · 模型 · 工具
   │
Store     SQLite + Spill        Env  LocalEnv / daemon
```

| 层 | 职责 |
|----|------|
| Harness | Session、循环、模型、工具、daemon |
| Engine | Trigger / Thread / Decision / Ticket / Assignment |
| Store | SQLite、Spill |
| Channels | 进站适配、出站格式 |
| Env | 沙箱目录和进程 |
| Watchdog | 盯卡住的 Worker |

### 跑起来

Node 20+，[pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm demo      # 默认 MockModel
pnpm start
pnpm test
```

### Demo

`pnpm demo` 喂一批假 IM / GitHub 事件，大致应能看到：

1. 噪声被过滤掉  
2. 可行动消息变成 Ticket → Worker  
3. 同 Thread 跟进带 `bypass=subscription`  
4. 能起第二个并行 Worker  
5. Spill + `read_object`  
6. 投机结果在 gate 前对外不可见  
7. Watchdog 能 nudge / fail  
8. 重启后数据还在  
9. 依赖里没有 `@deepseek-ai/dsh*`

### 模型

| 变量 | 含义 |
|------|------|
| `DS_AGENT_API_BASE` | OpenAI 兼容 Base |
| `DS_AGENT_API_KEY` | Key |
| `DS_AGENT_API_MODEL` | 可选默认模型 |

建议：Router / Watchdog 用轻量模型，Worker 用强一点的。

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### 目录

```
src/harness/    session、loop、model、tools、daemon
src/core/       Engine
src/store/      SQLite + Spill
src/ingress/    两级过滤
src/memory/     Inline / Spill
src/speculate/  deliver gate
src/channels/   CLI / 假 IM / 假 GitHub
src/env/        LocalEnv
src/watchdog/
src/cli/
scripts/demo.ts
```

### 致谢

本仓库由 **LofiSu / LoomLab** 与 **Grokbot（CoderBot）** 共同完成。

### 许可

[MIT](./LICENSE)

跟 DeepSeek 无隶属、无背书。思路来自公开文章和原型，实现是自己的；学习实验随便，出事自负。

- [微信文](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- [官方原型](https://github.com/deepseek-ai/dsh-superagent-prototype)

---

## English

Two pieces:

1. **Harness** — session log, async ReAct, OpenAI-compatible calls, role tools, daemon  
2. **Engine** — Intake → Eval → Ticket → Assignment → Reply  

No DeepSeek Harness. No Cordis. No `@deepseek-ai/dsh*`.

Built with [Grokbot (CoderBot)](https://cursor.com).

### Inspiration

| Source | Link | What we took |
|--------|------|--------------|
| WeChat post | [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) | Goals in §2–§6 |
| Official prototype | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | Domain vocab Trigger → Eval → Ticket → Assignment; Harness is ours |

### Checklist vs blog

Design targets. Checked boxes are not a green CI — run `pnpm demo`.

- [ ] Dual Router / Worker (§2)
- [ ] Async ReAct: `start()` / completion events (§2.2, §4.1)
- [ ] Triggers + Fast/Slow filter (§3.1)
- [ ] SQLite across restart (§5.1)
- [ ] Thread subscription fan-out (§3.2)
- [ ] Inline / Spill + `read_object` (§3.3)
- [ ] Speculative Assignment + deliver gate (§3.4)
- [ ] CLI / fake IM / fake GitHub (§4.2)
- [ ] Store vs LocalEnv (§5)
- [ ] `DS_AGENT_API_*` BYOM + daemon (§5.2)
- [ ] Watchdog nudge / fail (§6)

No keys → MockModel.

### Architecture

```
Channel   CLI / fake IM / fake GitHub
   │
Ingress   Fast + Slow → Thread key
   │
Engine    Intake → Eval → Ticket / Assignment
   │
Harness   Session · async ReAct · model · tools
   │
Store     SQLite + Spill        Env  LocalEnv / daemon
```

| Layer | Job |
|-------|-----|
| Harness | session, loop, model, tools, daemon |
| Engine | Trigger / Thread / Decision / Ticket / Assignment |
| Store | SQLite, Spill |
| Channels | inbound adapters, outbound shape |
| Env | sandbox workdir / process |
| Watchdog | stuck Workers |

### Run

Node 20+, [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm demo
pnpm start
pnpm test
```

### Demo

`pnpm demo` feeds fake IM / GitHub events. You should roughly see noise dropped, Ticket → Worker, `bypass=subscription`, a second Worker, Spill + `read_object`, speculative work hidden until the gate, Watchdog ticks, persistence after restart, and no `@deepseek-ai/dsh*`.

### Models

| Var | Meaning |
|-----|---------|
| `DS_AGENT_API_BASE` | OpenAI-compatible base |
| `DS_AGENT_API_KEY` | key |
| `DS_AGENT_API_MODEL` | optional default |

Router / Watchdog → cheap model. Worker → stronger one.

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com/v1
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-chat
pnpm start
```

### Layout

```
src/harness/  src/core/  src/store/  src/ingress/
src/memory/   src/speculate/  src/channels/  src/env/
src/watchdog/ src/cli/  scripts/demo.ts
```

### Credits

Co-completed by **LofiSu / LoomLab** and **Grokbot (CoderBot)**.

### License

[MIT](./LICENSE)

Not affiliated with or endorsed by DeepSeek. Ideas from a public post and open prototype; implementation is ours. Learning/experiments OK — your risk.

- [WeChat post](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)  
- [Official prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
