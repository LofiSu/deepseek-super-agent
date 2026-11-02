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

`pnpm demo` 会在 `DS_AGENT_GH_REPO` 上建真实 GitHub issue、发真实评论。跑之前把这个变量指到你能写的仓库。不设的话是 `LofiSu/deepseek-super-agent`。

关 issue 只是收尾，发生在每个场景的正事之后。关闭请求失败会被忽略，issue 可以一直开着，demo 也不会因此判失败。场景抛错，或者在关闭之前就 return，已经建好的 issue 也会留着。`DS_AGENT_GH_KEEP=1` 是故意不关。跑完去仓库里看一眼。demo 的 issue 带 `ds-agent-demo` 标签。

## 工具文本

README 里这一条是 `[~]`，还没做完。

- 子进程只拿一份环境变量白名单。名字像 key、token、secret 的，就算写在名单里也会丢掉。
- 脱敏只覆盖父进程环境里名字像 key、token、secret、password、credential 的值，而且值至少 8 个字符。这些值会在进工具结果之前，从标准输出、标准错误和读文件结果里换成 `[redacted]`。更短的值，或者密钥放在别的变量名下面，会原样留下，也能进模型。注入子进程的 vault 值，同样要满 8 个字符才会被换成 `[redacted]`。
- `FileVault.describe()` 只返回名字。vault 文件权限是 `0600`。
- 每个 Worker `bash` 调用都会包沙箱。macOS 用 `sandbox-exec`；Linux 用 `bwrap`（CI 会装 bubblewrap）。wrapper 不存在时命令直接报错，不会退回普通 bash。`DS_AGENT_SANDBOX` 不再改变这个行为。
- 沙箱限制写入（限定在工作区）和网络（默认拒绝，除非策略放行），但不提供读隔离：macOS 仍允许大范围 `file-read*`，Linux 使用 `--ro-bind / /`，所以 Worker 仍然能读 `<stateDir>/ds-agent.db`。进程级读隔离仍要靠外部容器边界。

宿主自己的 vault 策略和 seccomp 策略不在这个仓库里。

## 谁对外说话

只有 Router 往信道写。Worker 往上汇报。

GitHub 用这台机器上的 `gh` 登录。飞书用你配的应用 id 和 secret。信道细节在 [docs/REAL_CHANNELS.md]({{ site.repository_url }}/blob/main/docs/REAL_CHANNELS.md)。
