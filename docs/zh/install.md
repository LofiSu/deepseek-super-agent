---
layout: default
title: 安装和运行
lang: zh-CN
nav: install
alt: /install/
description: "安装 ds-agent 并跑实况 demo。需要 Node.js 22、pnpm，以及一个 OpenAI 兼容模型。"
permalink: /zh/install/
---

# 安装和运行

Node.js 22 或更高。版本写在 [package.json]({{ site.repository_url }}/blob/main/package.json) 的 `engines` 里。存储用 `node:sqlite`。包管理用 [pnpm](https://pnpm.io/)。

```bash
git clone https://github.com/LofiSu/deepseek-super-agent.git
cd deepseek-super-agent
pnpm install
pnpm test
gh auth login
pnpm demo
```

`pnpm test` 和 `pnpm demo` 都要一个能打通的 OpenAI 兼容模型。这两条路径不用 MockModel。`pnpm demo` 只走真实信道：用 `gh` 创建、读取真实 GitHub issue，并把回复发成真实评论。没有假的 IM，也没有假的 GitHub。

`pnpm demo:local` 是内存 fixture 冒烟，不是验收路径。

`DS_AGENT_API_BASE` 和 `DS_AGENT_API_KEY` 要成对设置，或者只设一把厂商 Key。这一对只设其中一个，进程会报错退出。

```bash
export DS_AGENT_API_BASE=https://api.deepseek.com
export DS_AGENT_API_KEY=sk-...
export DS_AGENT_API_MODEL=deepseek-flash
pnpm demo
pnpm ds-agent chat "fix the login timeout"
```

这一对不设 `DS_AGENT_API_MODEL` 时，客户端发送 `deepseek-chat`。只设 `DEEPSEEK_API_KEY` 时，默认模型是 `deepseek-flash`。

`DS_AGENT_API_BASE` 可以是任意 OpenAI 兼容地址，包括本机的 [Magpie](https://github.com/yetone/magpie)。密钥填网关 token，模型名用 Magpie 上的 id。

```bash
export DS_AGENT_API_BASE=http://127.0.0.1:3425/v1
export DS_AGENT_API_KEY=magpie
export DS_AGENT_API_MODEL=deepseek/deepseek-flash
pnpm demo
```

厂商对照表在 [README]({{ site.repository_url }}/blob/main/README.zh-CN.md#模型配置)。一个进程用一个模型。Router 和 Watchdog 用轻的，Worker 用强一点的。

状态在 `DS_AGENT_HOME`，没设的话在 `./.ds-agent`（SQLite）。

```bash
pnpm ds-agent tasks
pnpm ds-agent status
pnpm ds-agent metrics
```

Phase-2 默认关着。要开的话设 `DS_AGENT_PHASE2=1`。

`pnpm demo` 会在 `DS_AGENT_GH_REPO`（默认 `LofiSu/deepseek-super-agent`）上建真实 issue，跑完关掉。`DS_AGENT_GH_KEEP=1` 则留着。飞书怎么配，看仓库里的 [docs/REAL_CHANNELS.md]({{ site.repository_url }}/blob/main/docs/REAL_CHANNELS.md)。
