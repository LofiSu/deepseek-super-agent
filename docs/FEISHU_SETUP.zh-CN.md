# 飞书（Feishu）私信快速上手

本文是 **通用** ds-agent 飞书单聊（p2p）配置教程，示例一律使用占位符（`cli_xxxxxxxx`、`oc_xxxxxxxx`、`ou_xxxxxxxx`）。请勿把真实 App Secret、open_id 或聊天截图提交到 Git。

英文概要见 [README.md](../README.md#feishu-personal-dm-quick-start) 与 [docs/REAL_CHANNELS.md](REAL_CHANNELS.md)。

---

## 能自动做什么 / 必须你亲手做什么

| 步骤 | 自动化 | 说明 |
|------|--------|------|
| 飞书开放平台登录、创建企业自建应用 | 否 | 需浏览器与管理员权限 |
| 启用机器人、申请权限、发布版本 | 否 | 租户可能需审核 |
| 订阅事件 `im.message.receive_v1`，**长连接**模式 | 否（控制台配置） | 向导运行时会发起**出站** WebSocket，无需公网 webhook |
| 在客户端打开与机器人的单聊 | 否 | 可用应用链接（applink） |
| 本地保存 App ID / Secret（0600 文件） | 是 | `pnpm ds-agent feishu setup` |
| 生成一次性绑定口令、仅接受匹配的 p2p 发送者 | 是 | 长连接监听期间有效 |
| 写出 `FEISHU_CHAT_ID`、`FEISHU_BOT_OPEN_ID`、发送者白名单 | 是 | 写入 `feishu.env` |
| 提示 `channels check` / `serve --feishu` | 是 | 复用现有 CLI |

---

## 一、控制台配置（人工）

1. 登录 [飞书开放平台](https://open.feishu.cn/)（国际区 Lark 使用 [https://open.larksuite.com](https://open.larksuite.com)，并设置 `FEISHU_BASE_URL`）。
2. 创建 **企业自建应用**，开启 **机器人** 能力。
3. **权限**（单聊至少需要）：
   - `im:message.p2p_msg:readonly` — 读取与你的机器人的私信
   - `im:message:send_as_bot` — 以机器人身份发消息  
   若还要做群聊轮询，另需 `im:message:readonly`、`im:message.group_msg` 等（见 `channels check` 输出）。
4. **事件订阅**：添加 `im.message.receive_v1`，接收方式选 **长连接**（不是请求地址 URL）。
5. **发布**应用版本，并按租户流程启用。
6. 在飞书客户端中 **打开与机器人的单聊**（可在开放平台「机器人」页获取打开方式）。

---

## 二、本地一键向导

在仓库目录：

```bash
pnpm install
export DS_AGENT_HOME="${DS_AGENT_HOME:-$PWD/.ds-agent}"   # 可选，默认 ./.ds-agent
pnpm ds-agent feishu setup
```

常用参数：

- `--dry-run` — 只打印将要执行的步骤，不写密钥、不联网绑定。
- `--credentials <路径>` — 自定义 env 文件（默认 `$DS_AGENT_HOME/feishu.env`）。
- `--bind-timeout <秒>` — 等待你发送绑定口令的时限（默认 600）。
- `--skip-bind` — 只更新凭据，不重新绑定。
- `--force-bind` — 已有聊天绑定仍强制重新绑定。

向导会：

1. 用 **隐藏输入** 询问 App Secret（TTY 下不回显）；若环境变量已设置 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 则优先使用。
2. 以 `umask 077`、目录 `0700`、文件 `0600` 写入 `feishu.env`（**切勿提交 Git**）。
3. 调用 `bot/v3/info` 获取机器人 `open_id`（用于 `DS_AGENT_DROP_SELF`）。
4. 显示随机口令；你在 **单聊** 里原样发送后，通过官方 SDK **出站长连接** 完成绑定（仅匹配 p2p + 精确口令）。
5. 打印后续命令（`source feishu.env`、`channels check --feishu --network`、`serve --feishu`）。

加载环境：

```bash
set -a && source "$DS_AGENT_HOME/feishu.env" && set +a
```

`feishu.env` 中会包含（示例）：

```text
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=...
FEISHU_CHAT_ID=oc_xxxxxxxx
FEISHU_BOT_OPEN_ID=ou_xxxxxxxx
DS_AGENT_ACTOR_ALLOWLIST=ou_xxxxxxxx
DS_AGENT_DROP_SELF=ou_xxxxxxxx
DS_AGENT_FEISHU_P2P_DIRECT=1
```

---

## 三、预检与常驻服务

```bash
pnpm ds-agent channels check --feishu --network
```

配置 **模型**（任选其一）：

```bash
export DS_AGENT_API_BASE="https://api.example.com/v1"
export DS_AGENT_API_KEY="YOUR_KEY"
export DS_AGENT_API_MODEL="your-model"
```

启动入站轮询与守护进程（与向导解耦，复用既有 `serve`）：

```bash
pnpm ds-agent serve --feishu
```

`DS_AGENT_FEISHU_P2P_DIRECT=1` 时，单聊短句会走 direct 会话逻辑（需本仓库已合并的 direct-chat / 慢路径相关修复）；无需 mesh / A2A 即可个人私信使用。

---

## 四、诚实限制

1. **入站投递**：`serve --feishu` 当前仍是 **单会话 HTTP 轮询**，不是长连接收消息。长连接仅用于 `feishu setup` 绑定阶段。
2. **图片 / 文件**：飞书 API 常只给 `image_key` / `file_key`，默认不会把二进制交给模型；文本里可能是 `[image]` / `[file]` 占位。
3. **无法「一键」**：控制台登录、审核、首次打开机器人会话必须人工完成。
4. **密钥**：只存在本机 `feishu.env`；不要放进仓库、截图或日志。

---

## 五、故障排查

| 现象 | 建议 |
|------|------|
| `tenant_access_token` 失败 | 检查 App ID/Secret、应用是否发布、`channels check --network` |
| 长连接无事件 | 确认事件为长连接模式；应用已安装到当前租户；本机可访问外网 |
| 绑定口令无响应 | 确认是 **单聊** 而非群；口令完全一致；未超时 |
| 机器人不回复短句 | 确认 `DS_AGENT_FEISHU_P2P_DIRECT=1` 与 actor 白名单；配置 live model |
| `channels check` 缺 chat | 先完成 `feishu setup` 绑定或手动设置 `FEISHU_CHAT_ID` |

---

## 相关文档

- [docs/REAL_CHANNELS.md](REAL_CHANNELS.md) — 信道与轮询语义
- [docs/MODULES.md](MODULES.md) — 模块边界
