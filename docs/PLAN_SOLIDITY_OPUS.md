结论：not solid

# PLAN / 实现扎实度审查（Opus 后备 · tip eadba592）

| 字段 | 值 |
|------|-----|
| 仓库 | github.com/LofiSu/deepseek-super-agent |
| Tip | `eadba592dffc603a28d00b6c48e5adbfac1c3210`（`docs: review PLAN against the ds-agent implementation (#4)`） |
| 本地克隆 | `/workspace/deepseek-super-agent` |
| 对照文档 | `PLAN.md`、`docs/REVIEW.md`、既有 `PLAN_SOLIDITY_REVIEW.md` / `CODE_SOLIDITY_REVIEW.md` |
| 范围 | Channel→Ingress→Engine→Store/Env 分层；双层 Router/Worker；订阅旁路；Inline/Spill；DeliverGate；async ReAct；BYOM；Watchdog；七项既有 Critical 回归 |
| 日期 | 2026-11-01（Asia/Shanghai） |

---

## 1. 四层架构：Channel → Ingress → Engine → Store/Env

**判断：分层口号清楚，运行时边界有环、有旁路，不算 solid。**

| 层 | PLAN 承诺 | tip 实况 | 清晰？ | 环？ |
|----|-----------|----------|--------|------|
| **Channel** | 半结构化→Trigger；出站规范；不写领域 | `src/channels/*` 只造 Trigger / 截断文案；无 Outbox 投递适配器 | 入站清晰 | 无 |
| **Ingress** | Fast/Slow 唯一准入；Thread key | `filterTrigger` 在 Runtime 与 `Host.scope.admit` **双跑**；`meta.admitted`（不可信）可短路；Slow Path 实为同一套关键词规则（Mock 与 HttpOpenAI 皆然） | 名义清晰、执法弱 | Runtime↔Engine 双重过滤形成逻辑环 |
| **Engine** | 领域唯一写者；Gate+Assessment→decide | `Evals.evaluateDue` **永远** `Tickets.create` / `kind:'accept'`；无 `Engine.decide`、无 ignore/stop；Worker 工具经闭包持有完整 `Engine` | 写入口多在 `Engine.*` | **Harness → Engine → Harness.routerTurn** 回调环 |
| **Store/Env** | SQLite+Spill；Env 无 Session、凭据不进上下文 | Store 文档写入大体经 Engine；但 **jobs/artifacts/session** 由 Harness 直写；`LocalEnv.bash` 全量继承 `process.env`，无 `sanitize.ts` | Store 半清晰；Env 红线失败 | Env stdout → tool result → 下一轮 prompt（泄露环） |

**交叉依赖小结**

- 组合根 `Runtime` 把 `engine` 整对象塞进 `ToolRegistry` / `Harness`（`runtime.ts:82-104`），Worker 工具可调 `engine.report` / `engine.subscribe`，Router 工具可调 `engine.reply`——类型层无角色窄 port。
- `report_to_router` 在 Worker 链上 `await routerTurn`（`tools.ts:155-157`），形成 **Worker turn → Engine → Router turn** 的同步耦合；PLAN 的「Router=Sequence Point、Worker 无直接用户 I/O」在工具白名单上部分成立，在控制面上不成立。
- 无循环 import（目录依赖大体 `channels/ingress → core → store/env`），但有 **运行时能力环**：Worker 持 Engine 全能面 + Harness 直写 Store。

**一句话：** 四层图画得对；tip 实现是「demo 名词对齐 + 控制面缩水」。分层不 solid。

---

## 2. 横切机制一致性（相对 PLAN）

| 机制 | 一致性 | 证据要点 |
|------|--------|----------|
| **Dual Router/Worker** | **不一致** | 角色工具白名单有（Router 无 bash，`tools.ts:97-100`+`invoke` 拒跨角色）；但 `Harness.launch` 用 `Promise.all` 并行开 Router∥Worker（`loop.ts:63-66`），Assignment 在模型决策前已 `assignmentStarted`。Router 不是 Sequence Point。 |
| **Batching** | **弱/名存实亡** | `nextBatch` 原样拷贝 pending（`ingress/batch.ts`）；`ingest` 末尾立刻 `evaluateDue`（`runtime.ts:153`），demo 批大小恒为 1。 |
| **Subscription fan-out** | **半实现、语义错** | 日志探针 `bypass=subscription ticketId=` 在（`intake.ts:59-60`）；条件是「票未 ended 则任何 Trigger 都可投递」（`:73-74`），非「人消息达 live Ticket」；多订阅广播无仲裁。 |
| **Inline/Spill** | **半实现** | 超长文本会 spill 并截断 inline（`memory/recall.ts`）；`read_object` 整包回灌 prompt（`tools.ts:128-138`），无分页/邻居/ACL——与「Chain of Recall 边界」相反。 |
| **DeliverGate / maySurface** | **不一致** | `maySurface` 仅导出未调用（`gate.ts:6-9`）；交付权=Worker 自报 `deliver===true`（`assignments.ts:35-42`）；无 `DeliverGate.evaluate`、无 `speculate.delivered/discarded` 事件。 |
| **Async ReAct** | **外形有、会话无** | `start_job` 返回 `{status:'started',jobId}`；完成另起 turn，但 `runTurn` 每次只装 system+当前 prompt（`loop.ts:201-204`），journal 只写不读；无 `start`/`stop`/`injectJobResult`。 |
| **BYOM / daemon** | **客户端可换、策略不迁移** | `DS_AGENT_API_*` 切换 `HttpOpenAI`；daemon 仅 timer 调 `Watchdog.tick`（`daemon.ts:10-14`），不恢复 Session/Job；凭据红线未落地。 |
| **Watchdog** | **观察日志、不行动** | `tick` 只打 `nudge` 日志（`watchdog.ts:24-32`）；不调 `Engine.report` / `nudge_worker`；卡住判据看 session `running`，而失败 turn 会把 session 置 `idle`。 |

**总评：** 博客名词与日志探针可绿；控制面合同（仲裁、门闩、序列点、凭证、恢复）与 PLAN 不一致 → 整体 **not solid**。

---

## 3. 七项既有 Critical 回归表

| # | Critical | 状态 | file:line 证据 |
|---|----------|------|----------------|
| 1 | Subscription bypass lacks arbitration | **NOT FIXED** | `src/core/intake.ts:38-52`：对 `thread.subscriptions` 逐票 `deliverable` 后全部 `reached.add`，无 priority / own-follow / 最近 Assignment 选择；多票同 Thread = 广播。 |
| 2 | Speculative side effects not rollbackable | **NOT FIXED** | 投机 Worker 仍拿 `bash`/`write_file`/`start_job`（`tools.ts:97-184`）；`Assignments.report` 在 `deliver!==true` 时只静默日志（`assignments.ts:35-38`），无 workdir 隔离、无文件/进程/job 回滚；`LocalEnv.workspace` 按 session 落盘后永不清理（`local-env.ts:16-19`）。 |
| 3 | ToolContext injects full Engine into Worker | **NOT FIXED** | `ToolDeps.engine: Engine`（`tools.ts:15-18`）；构造时闭包捕获全能 Engine（`:38-39`）；Worker 工具直接 `engine.report`（`:155`）、`engine.subscribe`（`:168`）。无 `WorkerPorts`/`RouterPorts` 收窄。 |
| 4 | bash inherits env secrets | **NOT FIXED** | `spawn('bash', ['-c', command], { cwd, timeout })` **无 `env:`**（`local-env.ts:26`）→ Node 默认继承 `process.env`（含 `DS_AGENT_API_KEY`）；stdout/stderr 原样回工具（`tools.ts:101-104`）再 JSON 进 messages（`loop.ts:223-228`）。`src/env/` 仅有 `local-env.ts`+`index.ts`，**无 `sanitize.ts`**。 |
| 5 | Speculative discard does not end Assignment | **NOT FIXED** | `assignments.ts:35-38`：`speculative && deliver!==true` **提前 return**，位于 `ready|dropped|failed` 终态分支（`:44-52`）之前；`mark_task_failed` 发 `kind:'failed', deliver:false`（`tools.ts:213-214`）时投机票 Assignment 可一直 `running`。 |
| 6 | Live ticket bypass without mandate check | **NOT FIXED** | `deliverable`：`if (!ticket.ended) return true`（`intake.ts:73-74`）——不看 `trigger.human`、不看 `ticket.mandate.scope/actor/strength`；Mandate 仅在创建时写入装饰字段（`tickets.ts:33-39`），bypass 路径零再校验；非人 CI/bot 亦可 fan-out。 |
| 7 | Engine.reply ignores maySurface | **NOT FIXED** | `Engine.reply`（`engine.ts:45-50`）直接 `replies.send`，无 `ticket.speculative` / `maySurface` 判断；`maySurface` 仅在 `gate.ts:6-9` 与 `speculate/index.ts` 导出，**全仓无调用方**；静默依赖 MockModel 提示词纪律，非 Engine 不变量。 |

**计数：7 / 7 仍开放（0 FIXED，0 PARTIAL）。**

---

## 4. 其余伤害扎实度的问题（按严重度）

### Critical（上表之外仍属红线的延续）

- （已含上表 C1–C7；此处不重复开新 Critical ID。）

### High

1. **Eval 不能拒绝；Router 非 Sequence Point** — `evals.ts:9-29` 恒 `tickets.create`；`decision.kind` 硬编码 `'accept'`（`tickets.ts:66-76`）；`launch` 并行开 Worker（`loop.ts:63-66`）。（与 docs/REVIEW H2 一致，tip 未改。）
2. **`meta.admitted` 击穿 Ingress** — `runtime.ts:66-71` / `:137-144`：不可信 `meta` 布尔即可 `listened:true`。（REVIEW H1）
3. **交付门闩=Worker 自报** — 无独立 `DeliverGate.evaluate`；与 C7 合流。（REVIEW H4）
4. **Session journal 不驱动下一轮** — async ReAct / follow-up / JOB_DONE 均无历史 messages。（REVIEW H5）
5. **Watchdog 不能改 Assignment** — timer 路径只日志（`watchdog.ts:24-32`）。（REVIEW H6）
6. **`read_object` 无 Ticket/Session ACL，整包入 prompt** — `tools.ts:128-138`。（REVIEW H7）
7. **Live BYOM 不承载 Mock 证明的策略** — 同一 `HttpOpenAI` 服务三角色；`classify` 仍走规则（REVIEW H8）。
8. **无跨 await 的 Engine 串行事件循环** — `Store.atomic` 只罩同步段；`ingest` 火后不等待 `launch`（`runtime.ts:153-160`）。（CODE H5）

### Medium

- Outbox 行直接 `status:'sent'`，无真实投递；accept ack + Router `reply_user` 双发言。
- `handback` 不退订、不立刻 `evaluateDue`；`stop_worker`/`create_worker`/`nudge_worker` 多为日志成功。
- Ingress 快路径丢弃后仍跑 semantic；频道规范对中文无空格截断失效。
- 大 bash 输出不 spill；shell `timeout` 不杀进程组，孙子进程可挂死 Worker 链。
- Daemon 无 resume；PLAN 文件树（`sanitize.ts`、`Assessor`、`prompts/watchdog.md` 等）未落地。

### Low

- `DecisionKind` 含 ignore/stop，实现不用；事件枚举缺 speculate/watchdog 终态。
- `Thread.correlated` 只写不读；`maySurface` 死导出。
- `package.json` engines≥22 vs README Node 20+；库文件名 `ds-agent.db` vs PLAN `ds-agent.sqlite`。

---

## 5. 仍扎实、应保留的契约方向

1. Engine 公共命令走 `atomic` 的同步事务习惯（在单入口、无 await 时成立）。
2. 角色工具名白名单 + `invoke` 拒跨角色（Router 无 bash）。
3. Channel 适配器不写 Ticket；Trigger 不可变叙事。
4. 订阅 bypass 的**日志探针**形状（`bypass=subscription ticketId=`）可测。
5. Inline 超长外置 Spill 的模式意图（实现需补 ACL/分页）。
6. 「凭据值永不进上下文」作为验收红线方向正确（执法未做）。
7. Fake Sources + Mock 默认可跑 / BYOM 可选的产品边界。

这些是 **应钉死的不变量**，不是「当前 tip 已 solid」的证明。

---

## 6. 总判据

| 问题 | 答案 |
|------|------|
| 整体项目 + 架构是否 SOLID？ | **否 → not solid** |
| 四层是否清晰无环？ | 文档清晰；运行时有 Engine↔Harness 能力环与 Env→prompt 泄露环 |
| 七项 Critical 是否已修？ | **0 FIXED / 7 NOT FIXED** |
| 能否因 README `[x]` 或 demo 日志判 solid？ | **不能** — demo 证明的是 Mock 脚本与探针字符串，不是控制面 |

**最小要变成 solid 的契约钉（非新功能清单）：**

1. Engine 单进程串行队列；Thread 级 Eval 互斥。  
2. Fan-out：human + live + mandate 再校验 + 多订阅仲裁。  
3. Speculative：只读工具集或可弃 workdir；discard 必须结束 Assignment 且无出站。  
4. `ToolDeps` 拆 RouterPorts / WorkerPorts；禁止 Worker 持 `reply`/`decide`。  
5. `LocalEnv` env 白名单 + stdout/stderr sanitize + 探针测试。  
6. `Engine.reply` / 出站路径强制 `maySurface`。  
7. Watchdog timer 经 Engine 真正 nudge/fail；journal 驱动下一轮 ReAct。

---

本审查由 box 侧代码核对完成（本机 Cursor Claude Free 墙时的后备）；非 rubber-stamp README checkboxes。
