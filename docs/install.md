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
```

`pnpm test` and `pnpm demo` both need a live OpenAI-compatible model. MockModel is not used on that path. `pnpm demo:local` is an in-memory fixture smoke check. It is not the acceptance path.

Set `DS_AGENT_API_BASE`, `DS_AGENT_API_KEY`, and `DS_AGENT_API_MODEL` before `pnpm test`. If any of the three is missing, the `test` script fills a local Magpie default: base `http://127.0.0.1:3425/v1`, key `magpie`, model `workbuddy/deepseek-v4.1-flash`. Without that gateway, the tests cannot reach a model. A provider key alone, such as `DEEPSEEK_API_KEY`, does not replace those defaults. The script sets `DS_AGENT_API_BASE` and `DS_AGENT_API_KEY` itself, so the preset path never sees the lone key.

`pnpm demo` and `pnpm ds-agent chat` do not apply that Magpie default. For those, set both `DS_AGENT_API_BASE` and `DS_AGENT_API_KEY`, or one provider key. Setting only one of that pair exits with an error. Omit `DS_AGENT_API_MODEL` on the pair and the client sends `deepseek-chat`. `DEEPSEEK_API_KEY` alone defaults to `deepseek-flash`.

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-flash
pnpm test
```

`pnpm demo` uses real channels only. It creates and reads real GitHub issues, and posts real issue comments through `gh`. There is no fake IM or GitHub fallback. Log in with `gh auth login`, and set `DS_AGENT_GH_REPO` to a repository this `gh` login can write, before the demo. Unset, the demo uses `LofiSu/deepseek-super-agent`.

```bash
gh auth login
export DS_AGENT_GH_REPO=your-account/your-writable-repo
pnpm demo
pnpm ds-agent chat "fix the login timeout"
```

`DS_AGENT_API_BASE` can be any OpenAI-compatible URL. A local [Magpie](https://github.com/yetone/magpie) gateway is fine. Use the gateway token as the key, and Magpie's model id.

```bash
export DS_AGENT_API_BASE=http://127.0.0.1:3425/v1
export DS_AGENT_API_KEY=magpie
export DS_AGENT_API_MODEL=deepseek/deepseek-flash
export DS_AGENT_GH_REPO=your-account/your-writable-repo
pnpm demo
```

The provider table is in the [README]({{ site.repository_url }}/blob/main/README.md#models). One model for the process. A small model fits the Router and Watchdog. A stronger one fits the Worker.

State lives in `DS_AGENT_HOME`, or in `./.ds-agent` (SQLite).

```bash
pnpm ds-agent tasks
pnpm ds-agent status
pnpm ds-agent metrics
```

The Runtime constructs router shards, the Worker mesh, long-term memory, the lifecycle bus, and A2A unconditionally. There is no extension opt-in flag. Configure them with `DS_AGENT_SHARDS`, `DS_AGENT_MESH_CAPACITY`, and `DS_AGENT_INSTANCE_ID`; see [docs/MODULES.md]({{ site.repository_url }}/blob/main/docs/MODULES.md).

Closing those issues is best-effort. Each scenario calls `closeGithubIssues` only after its main work. A failed close is ignored, so the issue stays open and the demo does not fail for that. A throw, or a return before that call, also leaves issues open: a later `createIssue` can fail after earlier ones exist, the watchdog scenario returns when the issue has no trigger, and the spill scenario returns when a trigger is missing. `DS_AGENT_GH_KEEP=1` skips the close on purpose. After a run, look through the repo for open issues labeled `ds-agent-demo`.

Feishu setup is in the repo: [docs/REAL_CHANNELS.md]({{ site.repository_url }}/blob/main/docs/REAL_CHANNELS.md).
