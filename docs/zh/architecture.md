---
layout: default
title: 架构
lang: zh-CN
nav: architecture
alt: /architecture/
description: "一条 Trigger 怎么走过 Ingress、Engine、Harness 和 Watchdog。"
permalink: /zh/architecture/
---

# 架构

信道先进 Ingress，再进 Engine。Engine 做路由和批处理，然后走 Thread → Eval → Ticket → Assignment。Harness 跑 Worker 的 Session。底下是 Store 和 Env。Watchdog 在这条链路外面。

```
Channel ──► Ingress (Fast/Slow → Thread key)
              │
              ▼
           Engine.receive
              │  路由 / 批处理
              ▼
           Thread ──► Eval ──► Ticket ──► Assignment
                         │                    │
                         └─ 丢弃              ▼
                                        Harness Worker
                                              │
                    Store ◄───────────────────┤
                    Env   ◄───────────────────┘
                              Watchdog ─► 卡住的 Worker
```

同 Thread 已经订阅时走 `bypass=subscription`，跳过 Router 的 Eval，直接到这个 Thread 上的 Worker。

| 层 | 干什么 |
|----|--------|
| Channel | 入站适配、出站格式 |
| Ingress | Fast / Slow Path → Thread key |
| Engine | 路由和批处理、Thread、Eval、Ticket、Assignment |
| Harness | Session、异步 ReAct、模型、工具、daemon |
| Store | SQLite、Spill、`read_object` |
| Env | 沙箱目录和进程 |
| Watchdog | 看卡住的 Worker |

两个角色。Router 是序点：入站走 Engine，出站走 Router。Worker 拿执行工具，做完往上汇报。Worker 的 Session 不能直接往信道回消息。

这个形状的公开来源：

- [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)（§2–§6）
- [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（Trigger → Eval → Ticket → Assignment）

本仓库的 Harness 不是那份原型。计划和正在跑的代码哪里不一致，看 [docs/REVIEW.md]({{ site.repository_url }}/blob/main/docs/REVIEW.md)。能力清单在 [README]({{ site.repository_url }}/blob/main/README.zh-CN.md#能力清单)。
