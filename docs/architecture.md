---
layout: default
title: Architecture
lang: en
nav: architecture
alt: /zh/architecture/
description: "How a trigger moves through Ingress, the Engine, the Harness, and Watchdog."
---

# Architecture

A Channel enters Ingress, then the Engine. The Engine routes and batches, then runs Thread → Eval → Ticket → Assignment. The Harness runs the Worker session. Store and Env sit underneath. Watchdog stays outside that path.

```
Channel ──► Ingress (Fast/Slow → Thread key)
              │
              ▼
           Engine.receive
              │  routing / batching
              ▼
           Thread ──► Eval ──► Ticket ──► Assignment
                         │                    │
                         └─ drop              ▼
                                        Harness Worker
                                              │
                    Store ◄───────────────────┤
                    Env   ◄───────────────────┘
                              Watchdog → stuck Workers
```

A subscribed Thread uses `bypass=subscription`. It skips Router Eval and goes to the Worker already on that Thread.

| Layer | Job |
|-------|-----|
| Channel | inbound adapters, outbound shape |
| Ingress | Fast / Slow Path → Thread key |
| Engine | routing and batching, Thread, Eval, Ticket, Assignment |
| Harness | session, async ReAct, model, tools, daemon |
| Store | SQLite, Spill, `read_object` |
| Env | sandbox directory and process |
| Watchdog | stuck Workers |

Two roles. The Router is the sequence point: inbound through the Engine, outbound through the Router. Workers hold the execution tools and report upward. A worker session cannot reply on a channel.

The public sources for this shape:

- [Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) (§2–§6)
- [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (Trigger → Eval → Ticket → Assignment)

The harness in this repo is not that prototype. Where the plan and the code diverge: [docs/REVIEW.md]({{ site.repository_url }}/blob/main/docs/REVIEW.md). The feature checklist is in the [README]({{ site.repository_url }}/blob/main/README.md#features).
