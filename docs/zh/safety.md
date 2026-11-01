---
layout: default
title: 安全
lang: zh-CN
nav: safety
alt: /safety/
description: "密钥放哪、demo 会写什么，以及 Harness 怎么把凭据挡在工具文本外面。"
permalink: /zh/safety/
---

# 安全

这是跑在本机上的一层 Harness。配了模型 Key 就会调模型。配了 `gh` 或飞书，Router 就能往外发。

## 密钥

密钥放环境变量。别写进仓库，也别贴到 issue 或聊天里。

`pnpm demo` 会在 `DS_AGENT_GH_REPO` 上建真实 GitHub issue、发真实评论。指到你有写权限的仓库。默认是 `LofiSu/deepseek-super-agent`。跑完会关掉 issue，除非设了 `DS_AGENT_GH_KEEP=1`。

## 工具文本

README 里这一条是 `[~]`，还没做完。

- 子进程只拿一份环境变量白名单。名字像 key、token、secret 的，就算写在名单里也会丢掉。
- 父进程环境里的密钥值，在变成工具结果之前，会从标准输出、标准错误和读文件结果里换成 `[redacted]`。
- `FileVault.describe()` 只返回名字。vault 文件权限是 `0600`。
- `DS_AGENT_SANDBOX=1` 时，macOS 用 `sandbox-exec` 包一层 bash。Linux 用 `bwrap` 或 `unshare` 做网络命名空间。这些命令不在机器上，就退回普通 bash。

宿主自己的 vault 策略和 seccomp 策略不在这个仓库里。`DS_AGENT_SANDBOX=1` 只是上面那层薄封装。

## 谁对外说话

只有 Router 往信道写。Worker 往上汇报。

GitHub 用这台机器上的 `gh` 登录。飞书用你配的应用 id 和 secret。信道细节在 [docs/REAL_CHANNELS.md]({{ site.repository_url }}/blob/main/docs/REAL_CHANNELS.md)。
