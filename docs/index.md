---
layout: default
title: deepseek-super-agent
lang: en
nav: home
home: true
alt: /zh/
description: "Thin TypeScript harness. Router, Worker, triggers, Watchdog. Not an official DeepSeek product."
---

# deepseek-super-agent

CLI: `ds-agent`. License: MIT.

This is a thin TypeScript runtime. The harness is ours. It is not an official DeepSeek product, and it does not ship DeepSeek Harness, Cordis, or `@deepseek-ai/dsh*`.

The shape comes from DeepSeek's public article and the public prototype. The code here is an independent implementation.

## Two layers

- **Harness.** Session log, async ReAct loop, OpenAI-compatible calls, tools by role, daemon.
- **Engine.** Intake → Eval → Ticket → Assignment → Reply. Domain writes stay in the Engine.

Router talks and dispatches. Workers execute. Triggers drive the loop. Watchdog sits outside that path and nudges stuck work.

## Run it

Node.js 22+, [pnpm](https://pnpm.io/). `pnpm test` and `pnpm demo` need a live OpenAI-compatible model. There is no mock on that path.

[Install and run]({{ '/install/' | relative_url }}) · [Architecture]({{ '/architecture/' | relative_url }}) · [Safety]({{ '/safety/' | relative_url }})

The long checklist lives in the [README]({{ site.repository_url }}/blob/main/README.md).
