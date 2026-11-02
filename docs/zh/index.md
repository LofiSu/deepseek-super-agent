---
layout: default
title: deepseek-super-agent
lang: zh-CN
nav: home
home: true
alt: /
description: "薄的 TypeScript Harness。Router、Worker、Trigger、Watchdog。不是 DeepSeek 官方产品。"
permalink: /zh/
---

# deepseek-super-agent

命令行是 `ds-agent`，许可是 MIT。

这是一层薄的 TypeScript 运行时。Harness 是自己写的。它不是 DeepSeek 官方产品，也不带 DeepSeek Harness、Cordis 或 `@deepseek-ai/dsh*`。

形状来自 DeepSeek 的公开文章和公开原型。这边的代码是独立实现。

## 两层

- **Harness。** Session 日志、异步 ReAct、OpenAI 兼容调用、按角色挂工具、daemon。
- **Engine。** Intake → Eval → Ticket → Assignment → Reply。领域状态只写在这里。

Router 负责说话和分派。Worker 负责执行。Trigger 驱动循环。Watchdog 在这条链路外面，卡住的任务由它 nudge。

## 跑起来

Node.js 22 或更高，包管理用 [pnpm](https://pnpm.io/)。跑 `pnpm test` 之前先设 `DS_AGENT_API_BASE`、`DS_AGENT_API_KEY`、`DS_AGENT_API_MODEL`。跑 `pnpm demo` 之前，把 `DS_AGENT_GH_REPO` 指到你能写的仓库。这两条路径不用 mock。

[安装和运行]({{ '/zh/install/' | relative_url }}) · [架构]({{ '/zh/architecture/' | relative_url }}) · [安全]({{ '/zh/safety/' | relative_url }})

逐条对照清单在 [README]({{ site.repository_url }}/blob/main/README.zh-CN.md)。
