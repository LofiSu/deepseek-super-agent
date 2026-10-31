# ds-agent 并行模块技术方案

> LoomLab 独立 MIT 实现。自研最薄 Harness + 原型领域语义。**不依赖** DeepSeek Harness / Cordis。
>
> - 博客: https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg
> - 原型语义参考: https://github.com/deepseek-ai/dsh-superagent-prototype
> - 作者: LofiSu \<163713803+LofiSu@users.noreply.github.com\>
> - **免责声明：非官方 DeepSeek 产品；研究原型，非生产就绪。**

---

## 1. 目标与边界

| 项 | 约定 |
|----|------|
| 许可 | MIT |
| CLI | `ds-agent` |
| 默认模型 | `MockModel`（可确定性跑 demo / 测试） |
| BYOM | `DS_AGENT_API_BASE` + `DS_AGENT_API_KEY`（及可选 `DS_AGENT_API_MODEL`）走 OpenAI 兼容 HTTP |
| Harness | 自研最薄：Session 事件日志、异步工具/ReAct 循环、OpenAI 兼容模型调用、按角色工具注册、daemon |
| 领域引擎 | 移植原型语义（Intake / Evals / Tickets / Assignments / Replies），**不**挂 Cordis 插件树 |
| 不做 | 完整 Feishu/GitHub 生产 Source、Web Panel、与 DSH Session API 兼容层 |

---

## 2. 架构

```
Source ──► Ingress(两级过滤) ──► Engine ──┬──► Harness(Router Session)
                                          ├──► Executor(Worker Session + Env)
                                          ├──► Watchdog
                                          └──► Store(SQLite + Spill)
```

- **Source / Ingress**：事件进入；两级过滤（通道噪声 → 策略/作用域）；映射 Thread key。
- **Engine**：唯一写 Trigger / Thread / Decision / Ticket / Assignment；同步命令 + 事务。
- **Harness**：Router（主 Session）跑评估/派工工具循环；Worker Session 跑 Assignment。
- **Executor / Env**：存算分离——Store 持领域状态，Env 持沙箱工作目录与进程。
- **Watchdog**：独立 Session/定时器，探测卡住的 Worker，nudge 或 fail。
- **Store**：SQLite 仓储 + Spill 对象存储（大结果外置，Inline 只留摘要+id）。

---

## 3. 最薄 Harness 组件

| 组件 | 路径建议 | 职责 |
|------|----------|------|
| Session | `src/harness/session.ts` | 追加式事件日志（user/assistant/tool/system）；按 sessionId 恢复 |
| Loop | `src/harness/loop.ts` | 异步 ReAct：`runTurn(sessionId)`；工具可返回 `{status:'started', jobId}` 不阻塞 |
| Model | `src/harness/model.ts` | `MockModel` + `HttpOpenAIModel`（读 `DS_AGENT_API_*`） |
| Tools | `src/harness/tools.ts` | 按角色（router / worker / watchdog）注册；JSON schema 参数 |
| Daemon | `src/harness/daemon.ts` | 进程保活、优雅停、恢复未完成 Session |

Harness **不含** 领域规则；只提供可注入的循环与模型/工具端口。

---

## 4. 领域引擎五块 ↔ 博客能力

| Engine 部件 | 职责 | 博客/能力映射 |
|-------------|------|---------------|
| **Intake** | `receive(trigger)`：去重、记 Thread、扇出订阅、入 Eval 队列 | 两级过滤后的入站；Subscription fan-out |
| **Evals** | Thread 上串行 Eval；批处理同 Thread 积压 Trigger；Gate + Assessment 双层；超时 unavailable | Dual-layer（Gate 确定 + Router 研判）；Batching |
| **Tickets** | accept→Mandate+Ticket+首 Assignment+Subscriptions；resume / stop / retry | 授权工单生命周期 |
| **Assignments** | Executor 回调：started / inputsDelivered / report / interrupted | 异步 ReAct；Speculative（静默 Assignment + deliver gate） |
| **Replies** | Outbox：acknowledgement / answer / result / attention | Multi-channel 写回规范 |

横切：

| 能力 | 落点 |
|------|------|
| Dual-layer routing | Evals Gate + Router Session Assessment；Worker 执行 |
| Batching | Evals：同 Thread 一批 |
| Two-level filter | Ingress（通道）+ Policy/SourceScope（策略） |
| Thread subscription fan-out | Intake + `core/subscribe`；人消息可达 Ticket 则 bypass Eval |
| Inline / Spill chained recall | `memory`：Inline=摘要+spillIds；`read_object(id)` 链式取回 |
| Speculative execution | `speculate`：静默 Assignment，通过 deliver gate 才对外可见 |
| Async ReAct | Harness loop：长工具 → job，完成再注入 Session |
| Multi-channel spec | `channels`：CLI / fake IM / fake GitHub 适配 + 回复规范 |
| Storage / env separation | Store vs `env` LocalEnv 沙箱 |
| BYOM daemon | Http model + harness daemon |
| Watchdog | `watchdog` Session：卡住 → nudge/fail |

---

## 5. 模块拆分（并行 Agent）

| ID | Path | Deliverable | Depends |
|----|------|-------------|---------|
| **M0-shared** | `src/shared/` | types、ports、errors、DomainEvents | — |
| **M1-harness** | `src/harness/` | session、loop、model、tools、daemon + 单测 | M0 |
| **M2-store** | `src/store/` | SQLite schema、Repositories、Spill API | M0 |
| **M3-engine** | `src/core/` | Engine 五块 + model/stage/reasons | M0, M2 |
| **M4-ingress** | `src/ingress/` | 两级过滤、thread keys、batch hook | M0, M3 |
| **M5-subscribe** | `src/core/`（subscribe） | fan-out、resume、handback；日志含 `bypass=subscription` + ticketId | M3 |
| **M6-memory** | `src/memory/` | Inline、Spill、`read_object` Chain of Recall | M1, M2 |
| **M7-speculate** | `src/speculate/` | silent Assignment、deliver gate | M3, M1 |
| **M8-channels** | `src/channels/` | CLI、fake IM、fake GitHub + 回复规范 | M0 |
| **M9-env** | `src/env/` | LocalEnv 沙箱 bash、Env 接口 | M0 |
| **M10-watchdog** | `src/watchdog/` | timer、stuck workers、nudge/fail | M1, M3 |
| **M11-cli-demo** | `src/cli/` + `scripts/` | CLI、`pnpm demo`、README、总装配 | all |

### Waves

1. **Wave A**：先合 **M0**，再并行 **M1, M2, M8, M9**
2. **Wave B**：**M3**（依赖 Store 端口）
3. **Wave C**：并行 **M4, M5, M6, M7, M10**
4. **Wave D**：**M11** 合并接线 + demo 验收

---

## 6. 冻结接口契约

```ts
// Engine 入站
Engine.receive(trigger: Trigger): 'stored' | 'duplicate' | 'filtered'

// Harness 一轮
Harness.runTurn(sessionId: string): Promise<TurnResult>
// 长工具允许：
{ status: 'started', jobId: string }

// Spill
spill.put(bytes | string | object): Promise<string /* id */>
// 工具
read_object(id: string): Promise<unknown>
// Inline 形态：{ summary: string, spillIds: string[] }

// 订阅扇出探针（验收硬要求）
// fan-out 日志 MUST 包含：bypass=subscription 与 ticketId
```

其余端口（Repositories、Assessor、Executor、Outbox、SourceScope、Policy）形状对齐原型 `src/core/ports.ts` 语义，但实现落在本仓，无 DSH 类型。

---

## 7. 合并验收清单

```bash
pnpm install && pnpm test && pnpm demo
```

Demo / 测试须证明：

- [ ] 噪声被两级过滤丢掉
- [ ] 可行动 IM → 创建 Ticket → Worker Assignment
- [ ] 同 Thread 后续人消息 `bypass=subscription` 直达 Ticket（日志可探针）
- [ ] 第二路并行 Worker 可起
- [ ] Spill 写入 + `read_object` 链式召回
- [ ] Speculative Assignment 在 gate 前对外不可见，通过后可见
- [ ] Watchdog tick 能 nudge/fail 卡住的 Worker
- [ ] 进程重启后 Store 持久化恢复
- [ ] **无** `@deepseek-ai/dsh*` 依赖

---

## 8. 仓库布局

```
ds-agent/
  package.json          # name: ds-agent; bin: ds-agent
  README.md             # 免责 + 快速开始 + demo
  LICENSE               # MIT
  src/
    shared/             # M0
    harness/            # M1
    store/              # M2
    core/               # M3 + M5(subscribe)
    ingress/            # M4
    memory/             # M6
    speculate/          # M7
    channels/           # M8
    env/                # M9
    watchdog/           # M10
    cli/                # M11
  scripts/demo.ts       # 场景脚本
  prompts/              # router / worker / watchdog（精简自原型）
  test/
```

---

## 9. 与继续绑 DSH 的对比（决策记录）

| | 自研最薄 Harness（本方案） | 继续 fork DSH 原型 |
|--|---------------------------|-------------------|
| 两小时可演示面 | 领域能力 + Mock 全路径 | 「挂在 DSH 上」更快，但 Cordis/插件负担重 |
| 依赖 | 无 DSH | 强依赖 DeepSeek Harness |
| 可拷代码 | 可参考 pi / mini-swe 级 loop；领域语义来自原型 docs/core | 整仓 DSH 语义 |
| 推荐 | **采用**（已开干） | 仅当必须证明 DSH 兼容时 |

---

*本文档供并行 coding agents 只读契约；改契约须先改本文再改代码。*
