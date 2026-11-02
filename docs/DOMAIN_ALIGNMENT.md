# 领域对齐：以《从零打造 Personal Agent（三）》为准

本文记录本仓（`ds-agent` / `deepseek-super-agent`）相对该文的**命名与实现偏差**，以及已经落地的修正。文章的领域模型以 DeepSeek `dsh-superagent-prototype` 的公开文档为参照；本仓是独立 MIT 实现。

> 一句话：**计划里的 Harness / Store / Watchdog 骨架可以保留；但“谁研判、谁执行、订阅是什么、Ticket 什么时候结束”必须按这篇文章改。**

## 1. 命名对照

| 本仓旧名 | 文章/原型名 | 处理 |
|---|---|---|
| Router / Router Session | **Main Agent / Main Session** | 对外日志、prompt、文档改为 Main；内部 `role='router'` 作为兼容标识保留 |
| Worker / Worker Session | **Executor / Executor Session** | 对外日志、文档改为 Executor；内部 `role='worker'` 保留 |
| `Evals.evaluateDue()` 一律 accept | **Eval = Gate + Assessment → Decision** | 已改为 Policy Gate；无法确定时 `defer` 给 Main Agent |
| `Tickets.create` 用消息 label 当 `Mandate.scope` | **Mandate 记录授权范围** | 已改为 `scope`/`title` 由 Eval 提供 |
| `policyVersion: 'policy-v1'` 硬编码 | **Policy 带版本** | 引入 `Policy` 与版本字段，Mandate 记录来源版本 |
| `Thread.subscriptions: string[]` + `Ticket.threadKeys` | **Subscription 是 Ticket ↔ Thread 的多对多关系** | 保留兼容字段；新增 `contextOnly` 语义与订阅判定 |
| 多个订阅者仲裁出一个 winner | **Subscription fan-out（多对多）** | 已改为所有 live 订阅者都收到输入 |
| `Replies.send` 总是用 `ticket.channels[0]` | **Channel 是 Thread 的写入侧** | 回复可按 `threadKey` 选择正确 Channel |
| failed report 直接结束 Ticket | **失败结束 Assignment，Ticket 可重试** | 已改为 failed/blocked/waiting 只结束 Assignment；新增 `retry` |
| Outbox 失败即 `failed` | **保留结果、重试交付、幂等** | 已加 attempts / backoff / idempotencyKey / sending 恢复 |
| 没有 Panel | **Panel + Execution** | 新增 `executionView()` 与 `ds-agent panel` |
| `tasks` 的状态字符串 | **Open/Pending/Working/Waiting for a Trigger/Ended…** | 新增 `executionState()` 作为规范状态 |

## 2. 文章要求 vs 修正前实现

### 2.1 Eval 不是“自动接单”

文章：Source 产生 Trigger → Thread 组织上下文 → **Eval 的 Gate 做确定性准入，Assessment 研判是否接单** → 接单后才创建 Mandate/Ticket。

修正前：`Evals.evaluateDue()` 对每个有 `pending` 的 Thread 直接 `Tickets.create`，`Decision.kind` 固定 `accept`。类型里有 `ignore/stop/unavailable`，但生产路径不存在。Router 是在 Ticket 创建后才启动的“说话者”，不是决策者。

现在：
- `src/core/policy.ts` 的 `gateTriggers()` 负责确定性准入：命令、explicit、bot、speculative、inferred、observe 模式。
- 无法确定时返回 `defer`，Thread 保持 `pending`，由 `Runtime.assessPending()` 调用 `assessWithMainAgent()`。
- Main Agent 返回 `accept` 时必须给出 `title`、`scope`、`strength`；`Tickets.create` 用它们写 Mandate。
- `unavailable` 会记录 Decision，不会静默接单。

### 2.2 Subscription 只传上下文，不授权

文章：Subscription 是 Ticket 与 Thread 的多对多关联，**只把相关 Trigger 作为上下文送给 Ticket，不增加授权**；context-only 订阅不会唤醒已结束的 Ticket。

修正前：
- `Intake.receive()` 用 `arbitrateSubscribers()` 只选一个 winner，其他订阅者拿不到同一事件。
- 没有 `contextOnly`；所有订阅都是 full bypass。
- bot/CI 事件完全不走已有 Ticket。

现在：
- 所有 live 订阅者都收到输入；`Disposition.fanout` 可以是多个 Ticket。
- `Thread.contextOnly` / `Ticket.contextOnlyThreads` 标记只读上下文；这类 Ticket 收到 `kind:'context'` 输入，但不会被唤醒。
- bot/CI 事件同时：作为 context 进入已有 Ticket，并独立进入 Eval 成为新工作候选。
- `handback` 会同时清理 `subscriptions` 与 `contextOnly`。

### 2.3 Mandate 的 scope 不是标题

修正前：`mandate.scope = label`（消息前 80 字），`policyVersion` 固定 `'policy-v1'`。这等于把“你说了什么”当成“你授权了什么”。

现在：`Mandate.scope` 来自 Eval 的 `accept.scope`；没有时保守回退到 title，而不是整条消息。`policyVersion` 与 `rules` 记录准入依据。

### 2.4 Ticket 结束 ≠ Assignment 结束 ≠ Outbox 送达

文章：
- 失败时重试研究 Ticket，而不是重发同一次快讯。
- 提交 ready Report 不一定意味着 Ticket 已结束（还有待收尾 PR）。
- Ticket ended 与 Outbox 送达分开判断。

修正前：`Assignments.report()` 对 `ready/failed/dropped` 一律 `finish()`，把 Ticket 标成 `ended/failed`，且 `ticketStage()` 先看 `ended`，所以 `person/blocked`、`person/review` 实际不可达。

现在：
- `failed` / `blocked` / `waiting` 只结束当前 Assignment；Ticket 保持 open，可 `retryTicket()` 创建新的 Assignment（同 Ticket、同 Session、同目录）。
- `ready` / `dropped` 仍结束 Ticket（这是本仓暂未实现“待收尾 PR”的已知缺口）。
- `executionState()` 输出 Open/Pending/Working/Waiting for a Trigger/Awaiting answer/Awaiting review/Blocked/Ended；Panel 会把 outbox 的 pending/sent/failed 单独显示。

### 2.5 Outbox 必须能重试且不重复

文章：结果已生成，渠道不可用不应重做研究；恢复后继续发送；远端已收到、本地未记录成功时，需要幂等键或回执查询。

修正前：`Outbox.flushOnce()` 失败即 `markOutboxFailed`，永不重试；没有 attempts、没有幂等键、没有 `sending` 状态。

现在：
- `outbox` 增加 `idempotency_key`、`attempts`、`next_attempt_at`。
- 发送前 `claimOutbox()` 原子地把 `pending → sending`，避免两个 flusher 重复发送。
- 失败按指数退避重试（最多 5 次）；进程重启时 `requeueSending()` 把中断的 `sending` 放回 `pending`。
- `idempotencyKey` 默认等于 `replyId`，供 Channel 适配器去重。

### 2.6 回复必须回到产生输入的那个 Thread

修正前：`Replies.send()` 固定用 `ticket.channels[0]`。一张 Ticket 订阅多个 Thread 时，回复会发错地方。

现在：`Engine.reply(ticketId, text, purpose, threadKey?)`；`channelFor()` 按 `source:id` 找到对应 Channel，找不到才回退第一个。`reply_user` 工具新增 `thread` 参数。

### 2.7 缺少 Panel

文章把 Panel/Execution 列为三件套之一。修正前只有 `ds-agent tasks` 的零星状态。

现在：
- `src/core/panel.ts` 的 `executionView()` 输出：Ticket、规范状态、Mandate、Executor Session、目录、最近 Report、订阅、Outbox 计数。
- `ds-agent panel`（别名 `execution`）按“需要人处理优先”排序。
- `ds-agent retry <ticketId>` 在同一个 Ticket 上创建新 Assignment。

## 3. 仍然存在的缺口（不要当成已实现）

1. **没有真正的 Source 抽象**。文章里的行情 Source / 定时 Source 在本仓没有对应物；`Source` 仍只是 Channel 适配器 + Ingress 过滤。
2. **没有“等待触发”后自动新建 Assignment**。`waiting` report 只结束 Assignment；新 Trigger 到达后如何重新启动 Executor，仍需要产品层或调用方处理。
3. **ready 仍然结束 Ticket**。文章说有待收尾 PR 时不应结束；本仓还没有 PR completion rule。
4. **Policy 是代码常量，不是可编辑的版本化实体**。`Policy.version` 目前只有默认值，没有 Store 表与管理界面。
5. **Subscription 仍是数组缓存**。`Thread.subscriptions` / `Ticket.threadKeys` 与 `subscriptions` 表并存，尚未收敛为单一关系表。
6. **Panel 是 CLI，不是 Web**。文章里的 Panel 是界面概念；本仓只实现了只读视图。
7. **预存在的测试失败**：`test/sanitize.test.ts`（LocalEnv 环境输出）与 `test/speculate.test.ts` 的 scratch workdir 隔离断言，和本次领域对齐无关，属于之前的沙箱改动遗留。

## 4. 验收

```bash
pnpm typecheck
DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run \
  test/domain-alignment.test.ts test/subscription.test.ts test/outbox.test.ts \
  test/highs.test.ts test/ports.test.ts test/router-sequence.test.ts
```

`test/domain-alignment.test.ts` 锁定：Gate→Main Agent、context-only 订阅、失败后 retry、按 Thread 回复、Outbox 重试、Panel 状态。
