# 插件包与媒体 MCP 能力 — 设计

- 日期：2026-11-05
- 状态：待 owner 确认
- 归属：LofiSu
- 涉及仓库：`deepseek-super-agent`、新仓库 `jimeng-mcp`、已有仓库 `krene-mcp`
- 参考产品：Claude Code plugins、OpenAI Codex plugins、Magpie gateway plugins

## 1. 意图与为什么

`deepseek-super-agent` 已经有 skill（M9）和 Gateway 中间件插件，但还没有：

1. 一个 Worker 可调用的通用 **MCP 客户端**（PR #142 已写好，但和 `main` 冲突且未合并）；
2. 一个把 **skill、MCP server、agent 配置、routine** 打包安装的 **插件包**；
3. **生图**和**生视频**能力。

目标不是把 provider 塞进核心，而是让核心继续做 thin harness：能力以插件包分发，插件包内的 MCP server 负责 provider 细节，Worker 通过 `mcp__<server>__<tool>` 调用，结果以本地文件路径交付。

成功标准：

- 在 ds-agent 的 home 里放一个插件目录，运行 `ds-agent plugin add`，Worker 就能看到并调用该插件的 MCP 工具；Router 和 Watchdog 看不到。
- 一个插件可以同时带来 `SKILL.md`、MCP server、local agent 配置和 routine。
- 安装一个 `video-jimeng` 插件后，Worker 能调用 Seedance 2.0 生成一段视频，视频落盘，回复里给出可打开的路径。
- 同一套 MCP server 不经过 ds-agent 也能在 Claude Code / Codex 里直接使用。
- 插件安装、启用、删除只能由 owner 在 CLI 完成；模型没有任何插件管理工具。

## 2. 目标、非目标、反目标

### 目标

- 合并 #142 的通用 MCP 客户端：stdio、工具命名空间、完整 JSON Schema、超时、脱敏、spill、子进程环境白名单、`Runtime.finish()` 关闭。
- 新增 M11 Runtime 组合层的插件包加载器：读取 `<home>/plugins/<id>/plugin.json`，校验并把组件并入现有 skill / MCP / local-agent / routine 注册表。
- 新增 M11 CLI：`ds-agent plugin list/add/enable/disable/remove/validate`。
- MCP 媒体结果落到 **Worker 工作区**，让后续 `read_file` / `bash` 能直接使用；speculative 工单在 v1 不调用 MCP。
- 插件可以为 MCP server 声明 `approval: "always"`，把"花钱/外向"的工具纳入现有的 owner approval 流程。
- 新建 `jimeng-mcp`：Seedance 2.0 的 stdio MCP server，支持文生视频、图生视频、任务查询、下载。
- 在 `krene-mcp` 中先交付 `login` / `capture`，为后续 Krene 生图协议实现准备真实 fixture。
- 提供两个示例插件包：`video-jimeng`、`image-krene`，以及随包 skill。

### 非目标

- 不把图片/视频内联进模型消息或写进 Feishu/iMessage 回复；v1 只交付本地路径 + 元数据。
- 不做插件市场、网络安装、版本解析、自动更新。
- 不做远程 MCP 传输（HTTP/SSE）；v1 只支持 stdio。
- 不做模型发起的插件安装、启用、删除或修改。
- 不做 Claude Code 式 hooks、slash commands、subagent markdown 定义；插件只组合本仓库已有的四类组件。
- 不在本期实现 Krene 的生图协议；没有真实抓包就不写协议。

### 反目标（即使"能跑"也算失败）

- 模型可以给自己安装插件或 MCP server。
- 插件里的 skill 获得工具、扩大角色或绕过 approval。
- 密钥、token、cookie 写进 `plugin.json`、仓库或日志。
- 一个坏插件导致 Runtime 无法启动。
- 把 base64 图片/视频塞进模型对话或 spill 预览。
- MCP server 返回的任意绝对路径被直接当成可读文件。
- speculative 工单通过 MCP 产生无法回滚的外向副作用。

## 3. 约束

- Node.js 22+，TypeScript，pnpm；仓库规则见 `CLAUDE.md`。
- 一个 PR 一个关注点；从当前 `main` 开分支；`pnpm typecheck`、`pnpm lint`、`pnpm test` 必须通过。
- 按 M0–M11 命名，不新增模块编号，不引入目录式里程碑命名（`pnpm lint` 会拒绝）。
- 不新增功能开关；扩展通过配置数据（插件 manifest、home 配置文件）表达。
- 默认离线测试；live 测试显式开关。
- owner-only 仓库：只有 LofiSu 提交。

## 4. 已核实的现状

- 工具面：`src/harness/tools.ts` 的 `ToolRegistry` 在构造时登记内置工具，按 `router` / `worker` / `watchdog` 角色过滤；`specsFor(role)` 返回工具列表，`invoke()` 执行。
- Skill（M9）：`src/env/skills.ts` 读取 `<home>/skills/<id>/SKILL.md`，索引进 system prompt，`read_skill` 按需读正文；skill 是文档，不是能力。已合并（#149）。
- Local agents（M9）：`src/env/local-agents.ts` 读取 `<home>/local-agents.json`，Worker 只能传 agent id 和 task，命令/argv/env 由 owner 配置。
- Gateway 插件（M11/gateway）：`src/gateway/plugins.ts` 照 Magpie 实现 `onRequest` / `onResponse` / `strategies`，只处理 Gateway 中间件，不注册 agent 工具。
- MCP：PR #142（`feat/mcp-client`）已实现 `src/harness/mcp-config.ts`、`src/harness/mcp.ts`、worker-only 工具暴露、`mcp__<server>__<tool>`、完整 JSON Schema、超时、脱敏、spill、`close()`。当前和 `main` **CONFLICTING**；已核实冲突只集中在 `src/harness/tools.ts` 和 `src/runtime.ts`，异步 `specsFor`、完整 JSON Schema、`close()` 已在分支上，不需要重写。
- 媒体：`mcp.ts` 现在把 image/resource 块写到全局 `<home>/mcp/<server>/`，不在 Worker 工作区；PR 描述已把"对齐 Worker 工作区"列为遗留项。
- 通道：模型消息和现有通道都是纯文本；图片/视频只能以路径交付。
- Routine（M10）：`src/harness/routines.ts` 读取 `<home>/routines.json`，由 daemon tick 触发，经 `Runtime.ingest` 进入正常准入。
- Krene：`krene-mcp` 的 `feat/krene-mcp-server` 分支已经实现 CLI 骨架、浏览器登录、HTTP/WebSocket 抓包、脱敏、session 存储（0600）和测试；`serve` 仍是 stub。设计明确"没有真实 fixture 不写协议实现"，且 Krene 不生视频。本期复用该分支，不另起炉灶。

## 5. 参考的接入方式

### Claude Code plugins

- 可选清单 `.claude-plugin/plugin.json`；组件放在插件根目录：`skills/<name>/SKILL.md`、`agents/*.md`、`hooks/hooks.json`、`.mcp.json`。
- `${CLAUDE_PLUGIN_ROOT}` 在 hook 命令、MCP 配置、skill/agent 正文里替换为插件安装路径；`${CLAUDE_PLUGIN_DATA}` 提供跨更新持久目录。
- 通过 `/plugin` 和 marketplace 安装；插件更新会改变根路径，所以配置必须用占位符而不是硬编码。

本设计采用同样的"清单 + 根目录组件 + 路径占位符"结构，但组件范围收窄到本仓库已有的四类。

### OpenAI Codex plugins

- 根目录 `plugin.json` + `skills/` + `mcp.json`；在 `.codex/config.toml` 中按 `[plugins."<id>@<source>"] enabled = true` 启用。
- MCP server 支持 per-tool `approval_mode`（例如 `approve`），以及 `enabled_tools` / `default_tools_approval_mode`。

本设计采用"安装目录 + 独立启用登记"的做法，并借鉴 per-server approval，但只做 `always` / `never` 两档，避免引入 per-tool 策略编辑器。

### Magpie gateway plugins

- 插件是模块（`onRequest` / `onResponse` / `strategies`），从 `gateway-plugins/*.mjs` 加载，由 `gateway.plugins.json` 选择启用；hook 失败开放（fail-open），有 250ms 超时。

本仓库的 Gateway 插件已经对齐；新的 agent 插件包是**另一层**，不替代它。两者共用"配置数据 + owner 启用"的思路，但 agent 插件的失败策略是 **fail-closed 到该插件**（跳过插件，不影响其他插件和 Runtime），不是 fail-open 到原始请求。

## 6. 决策

### 6.1 总体架构

```text
<DS_AGENT_HOME>/
  skills/<id>/SKILL.md                 # 已有：owner 直接放的 skill
  local-agents.json                    # 已有
  routines.json                        # 已有
  plugins.json                         # 新增：插件的启用登记
  plugins/<plugin-id>/
    plugin.json                        # 新增：清单
    skills/<skill-id>/SKILL.md
    server/...                         # 可选：插件自带的 MCP server
  plugin-data/<plugin-id>/             # 新增：插件持久数据（不被 add --force 覆盖）
```

模块归属：

| 能力 | 模块 | 文件 |
|---|---|---|
| MCP 客户端、配置、工具暴露 | M1 Harness | `src/harness/mcp.ts`、`mcp-config.ts`、`tools.ts`、`model.ts` |
| 插件清单读取、校验、组件加载 | M11 Runtime 组合层 | `src/plugins.ts`（新增） |
| Skill / local agent / routine 现有加载器 | M9 / M10 | 复用，不重写 |
| Runtime 组合与关闭 | M11 Runtime | `src/runtime.ts` |
| `plugin` CLI | M11 CLI | `src/cli/main.ts` + `src/cli/plugins.ts` |

不新增 M12：插件是 M11 Runtime 的组合层，因为它同时读 M1 的 MCP 配置、M9 的 skill/agent、M10 的 routine；把它放在 M9 会造成 M9 → M1/M10 的反向依赖。MCP 仍是 M1 的工具源。

### 6.2 插件清单 `plugin.json`

```json
{
  "name": "video-jimeng",
  "version": "0.1.0",
  "description": "Seedance 2.0 video generation for Workers",
  "skills": "skills",
  "mcpServers": [
    {
      "name": "jimeng",
      "command": "jimeng-mcp",
      "args": ["serve"],
      "env": {
        "ARK_API_KEY": "${ARK_API_KEY}",
        "JIMENG_OUTPUT_DIR": "${pluginData}/output",
        "JIMENG_INPUT_ROOTS": "${home}/workspaces"
      },
      "timeoutMs": 300000,
      "outputDir": "${pluginData}/output",
      "approval": "always",
      "approvalTools": ["jimeng_generate_video"]
    }
  ],
  "agents": [],
  "routines": []
}
```

规则：

- `name` 匹配 `^[a-z][a-z0-9-]{0,63}$`，必须等于目录名。
- `version` 必填，`^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$`；仅用于展示，不做版本解析。
- `description` 必填，单行，最多 200 字符。
- 顶层未知 key 直接拒绝；组件未知 key 由现有 `normalize*` 拒绝。
- 所有组件可选；没有组件的插件是无效的（至少要有 skill / MCP server / agent / routine 之一）。
- 上限：插件 16 个；合并后 skill 64、local agent 16、routine 32、MCP server 16（沿用现有上限）。
- `skills` 是可选的子目录名，默认 `"skills"`；只读该目录下 `<id>/SKILL.md`，沿用 M9 的符号链接拒绝和大小上限。
- `mcpServers` 沿用 #142 的 schema，新增三个可选字段：
  - `outputDir`：该 server 允许返回的本地文件根目录；默认 `${pluginData}/output`，解析后必须位于 `<home>` 之下。
  - `approval`：`"never"`（默认）或 `"always"`。
  - `approvalTools`：`approval: "always"` 时生效；只对这些工具要求 owner 批准，默认是 server 的全部工具。媒体包只把 `jimeng_generate_video` 放进去，状态查询和任务续查不需要批准。
- `agents` 沿用 `LocalAgentSpec`，`command` / `args` 支持 `${pluginDir}`。
- `routines` 沿用 `RoutineSpec`。
- 清单里不写密钥值；`env` 的值可以是字面量，或用 `${ENV_NAME}` / `${pluginDir}` / `${pluginData}` / `${home}` 引用。
- `outputDir`、`approval`、`approvalTools` 也接受于顶层 `DS_AGENT_MCP_SERVERS` / `RuntimeOptions.mcpServers`，这样 owner 直接配置的高成本 server 也能被同样约束，且媒体/审批层可以先于插件层单独测试和合并。

### 6.3 路径占位符

- `${pluginDir}` → 插件安装目录的绝对路径。可用于 `mcpServers[].command/args/env`、`agents[].command/args`、`outputDir`。
- `${pluginData}` → `<home>/plugin-data/<id>` 的绝对路径，启动时创建，`add --force` 不删除。可用位置同 `${pluginDir}`。
- `${home}` → `<DS_AGENT_HOME>` 的绝对路径。可用位置同 `${pluginDir}`；示例用它把 `JIMENG_INPUT_ROOTS` 指到 `<home>/workspaces`。
- `${ENV_NAME}` → 宿主环境变量的值。只在 MCP `env` 的值里替换；未设置时插件加载失败并给出变量名（不打印值）。可以单独出现，也可以嵌在字面量里（例如 `Bearer ${ARK_API_KEY}`）。
- 替换后的值如果仍包含未解析的 `${...}`，插件加载失败。
- `outputDir` 解析后必须是 `<home>` 之下的绝对路径；否则插件加载失败。这样导入边界不会落到 `/tmp` 或用户主目录的其他位置。
- 不展开 `~`；`command` 可以是绝对路径或 PATH 上的可执行名，推荐绝对路径。
- MCP 客户端启动子进程时自动把解析后的 `outputDir` 注入为 `DS_AGENT_MCP_OUTPUT_DIR`，server 应优先读它；manifest 里再显式设置 server 自己的输出变量，保证两边指向同一目录。

### 6.4 启用登记

`<home>/plugins.json`：

```json
{
  "plugins": [
    { "id": "video-jimeng", "enabled": true },
    { "id": "image-krene", "enabled": false }
  ]
}
```

- 没有 `plugins.json` 时，`<home>/plugins/` 下所有清单有效的插件默认启用（与 Gateway 插件"无配置即全启用"一致）。
- `plugins.json` 存在、但某个已安装插件没有对应条目时，该插件**启用**；只有显式 `enabled: false` 才禁用。这样手动复制进去的插件会按预期工作。
- `disabled` 的插件不加载任何组件，也不启动 MCP server。
- `plugins.json` 损坏时：日志报错，Runtime 继续启动，所有插件视为禁用（fail-closed），CLI `plugin list` 显示原因。
- `plugin add` 写入 `enabled: true`；`plugin enable/disable` 只改登记，不动目录。`plugin remove` 删除对应条目。

### 6.5 加载、合并与冲突

加载顺序（先到先得）：

1. home 直接配置：`skills/`、`local-agents.json`、`routines.json`、`DS_AGENT_MCP_SERVERS` / `RuntimeOptions.mcpServers`；
2. 已启用插件，按目录名排序。

冲突规则：

- skill id、local agent id、routine id、MCP server name 在合并后的集合里必须全局唯一。
- 与 home 直接配置冲突：home 赢，插件被跳过并记录 `[plugin] conflict ...`。
- 两个插件互相冲突：目录名靠前的赢，后面的整个插件被跳过。
- 插件内任何一个组件无效（清单、skill、agent、routine、MCP 配置、占位符），**整个插件跳过**，不做部分加载；其他插件和 Runtime 不受影响。
- 所有跳过都写一条 `[plugin] skipped id=<id> reason=<...>`，并计入 `plugin.skipped` 指标；`ds-agent plugin list` 显示同样的原因。

这样 owner 一眼能看出"为什么我的插件没生效"，而不会出现半个插件在工作。

### 6.6 CLI

```bash
ds-agent plugin list [--json]
ds-agent plugin add <dir> [--force]
ds-agent plugin enable <id>
ds-agent plugin disable <id>
ds-agent plugin remove <id> --force [--purge]
ds-agent plugin validate <dir>
```

- `list`：显示 id、版本、启用状态、组件数量、加载错误。离线，不需要模型。
- `add`：先 `validate`，再复制到 `<home>/plugins/<id>`。复制时拒绝符号链接，跳过 `.git/`、`node_modules/`，总量上限 100 MB。目标已存在时没有 `--force` 就失败，不覆盖。
- `remove`：必须带 `--force`；删除插件目录和登记项。默认保留 `plugin-data/<id>`；`--purge` 一并删除。
- `validate`：只读校验清单、组件、占位符和冲突（不启动 MCP server，不联网）。
- 所有命令只通过 CLI 暴露，不注册为模型工具。

### 6.7 MCP 客户端增强（基于 #142）

在合并 #142 的基础上补三件事：

1. **完整 JSON Schema**：`ToolSpec.parameters` 放宽为完整 JSON Schema；`specsFor` 改为异步。MCP 工具的 array/enum/required 原样透传。
2. **工作区内的媒体输出**：`McpToolSource.invoke(name, args, context?)` 接收 `{ workspaceDir?: string }`。
   - image / audio / resource 二进制块写到 `<workspaceDir>/mcp/<server>/`；没有 `workspaceDir` 时回退到 `<home>/mcp/<server>/`（保持 #142 行为）。
   - `EnvPort` 增加可选方法 `workspaceFor?(workerId, opts?: EnvRunOptions): string`；`LocalEnv` 实现为 `opts.isolated ? isolatedWorkspace(id) : workspace(id)`。其他 `EnvPort` 实现可以不给，走回退路径。
   - speculative 工单在 v1 **不调用任何 MCP 工具**（见 6.8），因此 workdir 的提交/丢弃逻辑只需要覆盖非 speculative 工单；`promoteIsolated` / `discardIsolated` 仍然保留给 bash/write。
3. **server 返回文件的导入契约**：只认 MCP `resource_link` 内容块，不递归扫描文本 JSON。
   - `resource_link.uri` 必须是 `file://` 绝对路径；路径必须在解析后的 `outputDir` 之下，且是普通文件（非符号链接）。
   - 符合条件时复制到 `<workspaceDir>/mcp/<server>/imported/<basename>`，单文件上限 500 MB；超过上限不复制，只返回原始大小和路径。
   - 模型可见的结果是 `{ text, files: [{ path, hostPath, mimeType, bytes }] }`：
     - `path` 是**工作区相对路径**（例如 `mcp/jimeng/imported/video.mp4`），可以直接交给 `read_file`；
     - `hostPath` 是宿主绝对路径，供 `report_to_router` 在回复里给出可打开的地址；
     - 没有 `workspaceDir` 时，`path` 就是绝对路径。
   - 文本 JSON 里的路径（包括 `outputDir` 之外的绝对路径）**原样作为文本**返回，不读取、不复制、不加 `untrustedPath` 字段。server 想让 ds-agent 导入文件，必须发 `resource_link`。
   - 不把 base64 或二进制写进模型消息；文本结果超过 64 KB 走 spill（#142 已有）。

其他保持 #142 的行为：worker-only、`mcp__<server>__<tool>`、每个 server 的连接/调用超时、子进程环境白名单、`ROUTER_ONLY_OPS` 不扩大、`Runtime.finish()` 关闭所有子进程。

### 6.8 角色暴露与 approval

- MCP 工具：只给 Worker。Router 和 Watchdog 永远看不到第三方 server。
- 插件 skill：与 home skill 一样，索引给 Router + Worker，`read_skill` 可读。
- 插件 local agent：合并进现有 `LocalAgentRegistry`；`list_local_agents` 仍对 Router + Worker 可见（与 home agent 一致），`delegate_agent` 只给 Worker。这样"Worker-only"只约束执行，不隐藏配置列表。
- 插件 routine：作为 owner-authored trigger 进入 `Runtime.ingest`，仍走准入、规则、沙箱和 approval。
- `approval: "always"` 的 MCP server：
  - 只有 `approvalTools` 里的工具（默认全部）走审批；其余工具直接调用。
  - 调用前，`ToolRegistry` 检查当前 ticket 的 `collab.approvals` 是否存在 `status === "approved"` 且 `action` 等于 `mcp:<server>:<tool>` 的条目。
  - 不存在时抛 `UserError`，消息明确要求 Worker 先用 `request_approval`，action 写成 `mcp:<server>:<tool>`，把参数和成本说明放在 `reason` 里（匹配只看 action，不看 reason）。
  - 存在时允许调用；该 approval 覆盖本 ticket 对该工具的后续调用（包括超时后用 `jimeng_task` 续查之前的 `jimeng_generate_video`），不新增"一次性 token"状态。
  - 媒体插件包默认只把 `jimeng_generate_video` 设进 `approvalTools`，状态查询和任务续查不需要批准。
- speculative 工单：v1 **拒绝所有 MCP 调用**，错误提示 Worker 改为 report，由非 speculative 工单执行。MCP server 可能已经产生不可回滚的外部副作用（扣额度、发请求），不能靠工作区回滚来抵消。
- 没有 ticket 的调用（理论上只有 Worker 有 MCP，Worker 总有 ticket）直接拒绝。
- 已结束的 ticket 拒绝 MCP 调用，与 `mutableMode` 的现有规则一致。

### 6.9 Seedance MCP server（新仓库 `jimeng-mcp`）

独立 TypeScript 包，stdio MCP server，任何 MCP 客户端可挂载。

配置（环境变量）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ARK_API_KEY` | 无 | 调用时必需；缺失返回 `AUTH_REQUIRED` |
| `ARK_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | 方舟 API 根 |
| `JIMENG_MODEL` | `doubao-seedance-2-0-fast-260128` | 可换成质量档或 Ark endpoint |
| `DS_AGENT_MCP_OUTPUT_DIR` | 无 | ds-agent 自动注入；优先级最高 |
| `JIMENG_OUTPUT_DIR` | `~/.jimeng-mcp/output` | 下载目录；有 `DS_AGENT_MCP_OUTPUT_DIR` 时以它为准 |
| `JIMENG_INPUT_ROOTS` | output dir + cwd | 允许读取的本地图片根；ds-agent 插件设为 `${home}/workspaces` |
| `JIMENG_DOWNLOAD_HOSTS` | `byteimg.com`、`volces.com`、`volccdn.com`、`ibyteimg.com` 后缀 | 下载 URL 的 host 允许列表；缺省拒绝其他 host |
| `JIMENG_POLL_MS` | 2000 | 轮询间隔 |
| `JIMENG_WAIT_SEC` | 120 | 单次工具调用的等待上限 |
| `JIMENG_MAX_DOWNLOAD_BYTES` | 500 MB | 下载上限 |

工具：

| 工具 | 输入 | 输出 |
|---|---|---|
| `jimeng_status` | 无 | key 是否存在、base URL、默认模型、输出目录（不回显 key） |
| `jimeng_generate_video` | `prompt`；可选 `imageUrl` / `imagePath` / `imageRole`（`first_frame` / `last_frame` / `reference_image`）、`model`、`ratio`、`resolution`、`duration`、`seed`、`watermark`、`generateAudio`、`waitSec` | 成功：`{taskId,status:"succeeded",videoPath,videoUrl,bytes,model,duration,ratio,resolution}`；等待超时：`{taskId,status:"running",pollWith:"jimeng_task"}` |
| `jimeng_task` | `taskId`，可选 `download` | 状态；成功时下载并返回同样的字段 |

API 流程（已核实）：

```text
POST /contents/generations/tasks        Authorization: Bearer $ARK_API_KEY
GET  /contents/generations/tasks/{id}   Authorization: Bearer $ARK_API_KEY
```

- 创建 body：`{model, content:[{type:"text",text}, ...], ratio?, resolution?, duration?, seed?, watermark?, generate_audio?}`；`ratio`、`resolution`、`duration` 的可用值随模型变化，server 只做类型/范围校验，非法值由 Ark 错误原样返回。
- 图片输入：`{type:"image_url", image_url:{url}, role:"first_frame"|"last_frame"|"reference_image"}`。
- 状态：`queued` / `running` 继续轮询；`succeeded` 取 `content.video_url`；`failed` / `cancelled` / `expired` 停止并报告。
- 下载：只允许 HTTPS 和 `JIMENG_DOWNLOAD_HOSTS` 中的 host/suffix；每一跳重定向都重新校验；流式写盘并限制字节数；文件写到 `<output>/<yyyy-mm-dd>/<taskId>/video.mp4`。未知 host 报 `INVALID_INPUT`，提示 owner 显式加入允许列表，不静默放行。
- `imagePath`：只允许 `JIMENG_INPUT_ROOTS` 下的普通文件，大小上限 10 MB；转成 `data:` URL 发给 Ark。若 live 验证发现 Ark 不接受 data URL，则 v1 只支持 `imageUrl`，在 README 和错误里写清楚；ds-agent 的图生视频验收因此要么走 https URL，要么等 Ark 确认。
- 返回给 MCP 客户端：一条 text JSON + 一个 `resource_link` 指向 `file://<videoPath>`；视频本体绝不内联。ds-agent 会把该文件导入 Worker 工作区并给出 `path` / `hostPath`；Claude Code / Codex 等客户端自行决定如何展示。
- 错误以 `isError: true` 返回，code 为 `AUTH_REQUIRED` / `QUOTA_EXHAUSTED` / `TASK_FAILED` / `TIMEOUT` / `NETWORK` / `INVALID_INPUT`。
- 不引入方舟 SDK；用 `fetch`，通过注入的 `HttpPort` 做离线测试。

### 6.10 Krene 的本次范围：复用现有分支，完成 login + capture

Krene 生图协议实现不在本期；本期只把现有 `feat/krene-mcp-server` 分支收尾到"能登录、能抓包、能脱敏、能离线测试"：

- 复用该分支已有的 `src/cli.ts`、`src/auth/login.ts`、`src/auth/session.ts`、`src/browser.ts`、`src/capture/recorder.ts`、`src/capture/sanitize.ts`、`src/http/client.ts`、`src/config.ts` 和测试；不重写。
- `krene-mcp login`：Playwright 有头打开 Krene，用户手动完成验证码；程序轮询 `localStorage.userInfo` 拿 token，调 `/api/member/info` 校验，写 `~/.krene-mcp/session.json`（0600）。
- `krene-mcp capture`：只记录原始 HTTP 请求/响应和 WebSocket 帧到 `captures/<timestamp>/`；用户手动做一次设计对话和一次生图。
- `krene-mcp sanitize <capture-dir>`：独立命令，读取原始抓包，脱敏后写 `fixtures/*.jsonl` 与 `docs/protocol-notes.md`。**capture 不自动生成 fixture**，避免原始 token/cookie 被误提交。
- 脱敏：token、cookie、用户标识、手机号/邮箱、图片 URL 签名参数一律移除；测试用合成帧证明不会泄漏。
- `krene-mcp serve` 本期只暴露 `krene_status` 和 `krene_login`（状态/提示，不弹浏览器）；生图工具等抓到 fixture、更新设计后再实现。
- Playwright 是可选依赖，只在 login/capture 需要；CI 不安装浏览器、不联网。
- 该分支已经包含"用已安装 Chrome + 持久 profile"和"绕过损坏系统代理"的修复，直接保留。

### 6.11 示例插件包与 skill

仓库内提供两个可复制的示例（不自动安装）：

```text
examples/plugins/
  video-jimeng/
    plugin.json
    skills/seedance-video/SKILL.md
  image-krene/
    plugin.json
    skills/krene-image/SKILL.md
```

- `video-jimeng`：`mcpServers[0]` 指向 `jimeng-mcp`，`approval: "always"` + `approvalTools: ["jimeng_generate_video"]`，`timeoutMs: 300000`，`outputDir: "${pluginData}/output"`。
- `image-krene`：指向 `krene-mcp serve`，`approval: "always"` + `approvalTools: ["krene_generate_image", "krene_edit_image"]`；skill 明确说明本期只能查状态，生图工具在协议实现后才可用。
- skill 内容：什么时候用、需要先 `request_approval`（action 格式 `mcp:<server>:<tool>`）、如何把返回的 `hostPath` 交给 `report_to_router`、失败时怎么办。
- 安装方式：`ds-agent plugin add examples/plugins/video-jimeng`。
- **server 二进制的安装**：v1 不做 npm 发布，也不把 `dist` 提交进插件目录。`jimeng-mcp` / `krene-mcp` 各自 `pnpm build && pnpm link --global`，插件清单用 PATH 上的可执行名；README 写清这一步。`ds-agent plugin validate` 在 command 不在 PATH 时给出警告（不阻止安装，因为 server 可能稍后才装）。如果以后要发布 npm 或把 server vendored 进插件，只需要改清单的 `command`，不改加载器。

## 7. 数据、错误与可观测性

新增指标：

- `plugin.loaded`、`plugin.skipped`（按原因不拆，日志里写原因）。
- 沿用 #142 的 `mcp.connect`、`mcp.connect_error`、`mcp.call`、`mcp.call_error`、`mcp.call_timeout`。
- 可选：`mcp.output_copied`、`mcp.output_rejected`（路径越界/符号链接/超限）。

日志前缀：

- `[plugin] loaded id=<id> components=...`
- `[plugin] skipped id=<id> reason=<...>`
- `[mcp] ...`（#142 已有）

错误分类：

- 插件清单/组件错误：加载期跳过，不抛到 Runtime 构造。
- MCP 连接失败：跳过该 server，其他 server 正常。
- MCP 调用失败/超时：作为工具错误返回给模型，由 Worker 决定是否重试或报告。
- 媒体路径越界：工具错误，不读取、不复制。
- 视频任务失败/超时：Seedance server 返回结构化错误；超时保留 `taskId` 供 `jimeng_task` 续查。

## 8. 安全边界

- 安装/启用/删除只走 CLI；模型没有 `install_plugin` 之类的工具。
- 插件的 MCP server 和 local agent 都是 owner 明确安装的可执行程序，信任级别等同于 owner 自己的脚本；文档写明。
- MCP 子进程只继承 `PATH`、`HOME`、`LANG`、`TZ` 和代理变量，加上 manifest 显式声明的 `env`；密钥不进日志。
- `plugin.json` 只引用环境变量，不保存密钥；`plugin add` 不做任何网络请求。
- 插件目录复制拒绝符号链接，避免安装时把宿主路径带进 home。
- MCP 媒体输出只写工作区；server 返回的文件只在 `outputDir` 内导入，拒绝符号链接和越界路径。
- speculative 工单不调用任何 MCP 工具，避免不可回滚的外部副作用。
- Seedance 下载只允许 HTTPS + host 允许列表，限制大小，避免 SSRF 和磁盘打满。
- Krene capture 的 fixture 在落盘前脱敏；session 文件 0600。

## 9. 测试与验收

### ds-agent

- 插件清单：合法/非法 JSON、未知 key、缺字段、版本格式、组件为空、上限、占位符解析、未设置环境变量。
- 加载器：home + 插件合并；skill/agent/routine/MCP 冲突；坏插件隔离；`plugins.json` 损坏时全部禁用。
- CLI：临时 home 下 `add/list/enable/disable/remove/validate`；符号链接拒绝；`--force`；`--purge`；`--json`。
- Runtime：假插件（skill + 假 MCP server + agent + routine）启动后，Worker 的 `specsFor` 包含 `mcp__fake__echo`，Router 不包含；prompt 包含插件 skill；`ds-agent agents` 包含插件 agent；fake-clock routine 触发。
- MCP 媒体：image 块落到工作区；`resource_link` 的 `file://` 文件从 `outputDir` 导入并返回 `path` + `hostPath`；文本 JSON 里的路径不被导入；越界路径/符号链接被拒绝；超限文件不复制；大文本走 spill。
- speculative：speculative 工单调用任何 MCP 工具都被拒绝，错误提示改为 report，由非 speculative 工单执行。
- approval：`approvalTools` 里的工具在无 approved 条目时拒绝并提示 `request_approval`；同一 server 的其他工具不需批准；批准后同一 ticket 可重复调用。
- 配置：`DS_AGENT_MCP_OUTPUT_DIR` 被注入子进程；`outputDir` 不在 `<home>` 之下时插件加载失败；`plugins.json` 缺条目时插件仍启用。
- 回归：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm test:coverage` 全绿。

### jimeng-mcp

- 离线：create → running → succeeded → download 的 fixture 回放；模型 id/参数透传；缺 key；任务 failed/expired；超时返回 taskId；host 不在允许列表；超过下载上限；`imagePath` 越界。
- live（显式 `JIMENG_LIVE=1`）：用真实 key 生成一段 5 秒视频，验证文件存在、大小合理、路径可打开；证据写进 PR。这一步需要 owner 提供 `ARK_API_KEY` 并亲自执行；没有 key 时 PR 只能声明"离线 fixture 通过"，不能声明"已能生视频"。

### krene-mcp

- 脱敏函数对合成 HTTP/WS 帧的单元测试；session 文件权限；capture 目录结构。
- 不做 live 测试；协议实现前不声称生图可用。

### 端到端验收

```text
ds-agent worker 收到任务
→ 调用 mcp__jimeng__jimeng_generate_video
→ 返回 videoPath
→ report_to_router 在回复里给出路径
→ 文件在 Worker 工作区可被 read_file / bash 打开
```

不接受"日志里出现工具名"作为验收；必须有落盘文件和路径证据。

## 10. 交付顺序（PR 拆分）

1. **ds-agent / MCP 客户端**：rebase #142 到当前 `main`，解决冲突；补完整 JSON Schema、异步 `specsFor`、`close()`；保持 worker-only。合并后 `main` 有一条可用的 MCP 客户端。
2. **ds-agent / MCP 媒体输出**：`EnvPort.workspaceFor`、工作区输出、`outputDir` 导入、approval 检查、指标和测试。
3. **ds-agent / 插件包**：`src/plugins.ts`、Runtime 组合、`plugin` CLI、`docs/PLUGINS.md`、README、MODULES.md、测试。
4. **jimeng-mcp / 新仓库**：Seedance server、离线 fixture、README（Claude Code / Codex / ds-agent 三种挂载示例）。
5. **ds-agent / 示例插件包**：`examples/plugins/video-jimeng`、`examples/plugins/image-krene` + skill；端到端验收。
6. **krene-mcp / login + capture**：在现有 `feat/krene-mcp-server` 分支上收尾：确认 login / capture / sanitize / 测试通过，补 README 和 fixture 目录约定；生图协议留到 owner 完成真实抓包后的下一次设计更新。

每个 PR 一个关注点；第 4、6 步是独立仓库，不阻塞 ds-agent 的 1–3。

## 11. 明确不在本次范围

- 把图片/视频发到 Feishu/iMessage，或在模型消息里内联媒体。
- MCP HTTP/SSE 传输、远程托管、多账号轮换。
- 插件市场、网络安装、自动更新、版本回滚、依赖解析。
- Claude Code 式 hooks、slash commands、subagent markdown。
- per-tool approval 策略编辑器；v1 只有 per-server `always` / `never`。
- Krene 生图/改图协议实现（等真实 fixture）。
- 视频编辑、视频延长、音频输入等 Seedance 高级能力；v1 只做文生视频和图生视频。

## 12. 留给实现者决定

- 插件加载器的内部类型划分、复制实现细节、原子写 `plugins.json` 的方式。
- MCP 文件导入的去重/命名规则、复制失败时的回退。
- Seedance server 的 HTTP 客户端抽象、重试/退避、日志字段。
- 示例 skill 的具体措辞（但必须写明 approval action 格式和路径交付方式）。
- Krene capture 的浏览器上下文配置和脱敏脚本实现。

## 13. Owner checkpoints 与本设计的默认

必须由 owner 本人完成的步骤：

1. **Seedance live 验收**：提供 `ARK_API_KEY`，本机运行一次 `JIMENG_LIVE=1` 的 5 秒生成，确认文件和路径。没有这一步，PR 4 只能以离线 fixture 验收。
2. **Krene 抓包**：按你的选择放在后面。capture 工具交付后，需要你本人跑 `login` → `capture`（一次设计 + 一次生图）→ `sanitize`，才能进入生图协议实现。

本设计直接采用的默认（如无异议，不再单独确认）：

- 新仓库名 `jimeng-mcp`；工具前缀 `jimeng_`。
- 默认模型 `doubao-seedance-2-0-fast-260128`；质量档通过参数切换。
- `video-jimeng` 默认对 `jimeng_generate_video` 开启 `approval: "always"`。
- `plugin add` 只支持本地目录复制，不支持 `git` URL。
- `krene-mcp` 复用现有 `feat/krene-mcp-server` 分支，不重写。
