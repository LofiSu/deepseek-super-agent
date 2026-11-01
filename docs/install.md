---
layout: default
title: Install and run
lang: en
nav: install
alt: /zh/install/
description: "Install ds-agent and run the live demo. Node.js 22, pnpm, and an OpenAI-compatible model."
---

# Install and run

Node.js 22 or newer. See `engines` in [package.json]({{ site.repository_url }}/blob/main/package.json). The store uses `node:sqlite`. Install [pnpm](https://pnpm.io/).

```bash
git clone https://github.com/LofiSu/deepseek-super-agent.git
cd deepseek-super-agent
pnpm install
pnpm test
gh auth login
pnpm demo
```

`pnpm test` and `pnpm demo` both need a live OpenAI-compatible model. MockModel is not used on that path. `pnpm demo` uses real channels only. It creates and reads real GitHub issues, and posts real issue comments through `gh`. There is no fake IM or GitHub fallback.

`pnpm demo:local` is an in-memory fixture smoke check. It is not the acceptance path.

Set both `DS_AGENT_API_BASE` and `DS_AGENT_API_KEY`, or set one provider key. Setting only one of that pair exits with an error.

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-flash
pnpm demo
pnpm ds-agent chat "fix the login timeout"
```

Omit `DS_AGENT_API_MODEL` on that pair and the client sends `deepseek-chat`. `DEEPSEEK_API_KEY` alone defaults to `deepseek-flash`.

`DS_AGENT_API_BASE` can be any OpenAI-compatible URL. A local [Magpie](https://github.com/yetone/magpie) gateway is fine. Use the gateway token as the key, and Magpie's model id.

```bash
export DS_AGENT_API_BASE=http://127.0.0.1:3425/v1
export DS_AGENT_API_KEY=magpie
export DS_AGENT_API_MODEL=deepseek/deepseek-flash
pnpm demo
```

The provider table is in the [README]({{ site.repository_url }}/blob/main/README.md#models). One model for the process. A small model fits the Router and Watchdog. A stronger one fits the Worker.

State lives in `DS_AGENT_HOME`, or in `./.ds-agent` (SQLite).

```bash
pnpm ds-agent tasks
pnpm ds-agent status
pnpm ds-agent metrics
```

Phase-2 helpers stay off unless you set `DS_AGENT_PHASE2=1`.

`pnpm demo` writes real issues on `DS_AGENT_GH_REPO` (default `LofiSu/deepseek-super-agent`) and closes them at the end. `DS_AGENT_GH_KEEP=1` leaves them open. Feishu setup is in the repo: [docs/REAL_CHANNELS.md]({{ site.repository_url }}/blob/main/docs/REAL_CHANNELS.md).
