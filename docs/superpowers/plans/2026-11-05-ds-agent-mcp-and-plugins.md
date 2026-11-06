# ds-agent MCP Client, Media Output, and Plugin Bundles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the generic MCP client, route MCP media into the Worker workspace, gate expensive MCP tools behind the existing approval flow, and add owner-installed plugin bundles that compose skills, MCP servers, local agents, and routines.

**Architecture:** M1 owns the MCP transport and tool normalization; M9 owns plugin manifest loading and merges plugin components into the existing skill / local-agent / routine registries; Runtime composes everything and closes MCP children on `finish()`; M11 exposes an owner-only `plugin` CLI. MCP tools stay Worker-only. Media files land in the Worker workspace and are addressed by workspace-relative paths.

**Tech Stack:** Node.js 22+, TypeScript, pnpm, vitest, `@modelcontextprotocol/sdk@1.32.2`.

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-bundles-and-media-mcp-design.md`

**Target repo:** `deepseek-super-agent`

## Global Constraints

- Node.js 22+; ESM TypeScript; pnpm.
- Branch from current `origin/main`; never commit to `main`; never force-push.
- One concern per PR. `pnpm typecheck`, `pnpm lint`, and `pnpm test` must pass before a PR.
- Name features by function and M0–M11 boundary; no directory-based milestone naming.
- Offline tests must not need a live model or network. Live tests are explicit.
- MCP tools are exposed to `worker` only; `router` and `watchdog` never see them.
- No new feature switches. Configuration is data: `plugin.json`, `plugins.json`, MCP server config.
- Secrets never enter the repo, `plugin.json`, logs, or model messages. Plugin `env` values reference `${ENV_NAME}`.
- Owner-only repository: only LofiSu commits; no non-LofiSu co-author trailers.
- Re-fetch and merge `origin/main` after every green CI run; peer sessions may merge first. Never force-push.

## Review Focus

- A speculative ticket calls an MCP tool: expect a `UserError`, not an external call.
- A `resource_link` points outside `outputDir`, at a symlink, or above the size cap: expect no import and an explicit rejection.
- One invalid component in a plugin: expect the whole plugin skipped, a `[plugin] skipped` line, and the Runtime still starting.
- An `approval: "always"` tool without an approved action: expect a `UserError` naming `request_approval` and `mcp:<server>:<tool>`; other tools on the same server still work.
- `${ENV_NAME}` unset or `outputDir` outside `<home>`: expect the plugin skipped with a clear reason, not a Runtime crash.

---

### Task 1: Merge the MCP client branch (#142)

**Files:**
- Modify (by merge resolution): `src/harness/tools.ts`, `src/runtime.ts`
- Verify: `src/harness/mcp.ts`, `src/harness/mcp-config.ts`, `src/harness/model.ts`, `src/harness/loop.ts`, `src/metrics/metrics.ts`, `package.json`, `pnpm-lock.yaml`, `test/mcp-*.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ToolRegistry.specsFor(role: Role): Promise<ToolSpec[]>`, `ToolDeps.mcp?: McpToolSourceLike`, `ToolRegistry.close(): Promise<void>`, `McpToolSource`, `parseMcpServers`, `mcp__<server>__<tool>` naming.

- [ ] **Step 1: Merge current main into the existing branch**

Use the existing worktree if present:

```bash
cd /Users/sulin/.superpowers-worktrees/ds-agent-mcp-client
git fetch origin
git checkout feat/mcp-client
git merge origin/main
```

Expected: conflicts in `src/harness/tools.ts` and `src/runtime.ts` only.

- [ ] **Step 2: Resolve the two conflicts**

In `src/harness/tools.ts`, keep all of:
- `ToolDeps.mcp?: McpToolSourceLike` from #142;
- async `specsFor` that appends `await this.deps.mcp.specs()` only for `role === 'worker'`;
- the `mcp__` branch in `invoke` before the built-in lookup;
- `close()` delegating to `deps.mcp?.close()`;
- the `skills` and `localAgents` tool arrays already on `main`.

In `src/runtime.ts`, keep all of:
- #142's MCP config parsing, secret-named env values merged into the redaction list, `McpToolSource` construction, `tools` field, and `finish()` closing tools;
- `main`'s skills, local agents, routines, approvals, and lifecycle wiring.

- [ ] **Step 3: Verify the merge**

Run:

```bash
pnpm install
pnpm typecheck
pnpm lint
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm test
```

Expected: typecheck and lint exit 0; the offline suite passes with the #142 MCP tests included.

- [ ] **Step 4: Push and update PR #142**

```bash
git push origin feat/mcp-client
```

Wait for `typecheck and test` on PR #142 to pass. Merge only after the check is green. Record the PR URL and the CI run URL in the task report.

- [ ] **Step 5: Commit evidence**

No new commit is required beyond the merge commit. If conflict resolution needed extra edits, commit them with:

```bash
git add src/harness/tools.ts src/runtime.ts
git commit -m "chore: merge main into the MCP client branch"
```

---

### Task 2: Put MCP media in the Worker workspace and import `resource_link` files

**Files:**
- Modify: `src/shared/ports.ts`
- Modify: `src/env/local-env.ts`
- Modify: `src/harness/mcp-config.ts`
- Modify: `src/harness/mcp.ts`
- Modify: `src/harness/tools.ts`
- Modify: `src/metrics/metrics.ts`
- Modify: `test/fixtures/fake-mcp-server.mjs`
- Modify: `test/mcp-invoke.test.ts`
- Test: `test/mcp-media.test.ts`

**Interfaces:**
- Consumes: `McpToolSource` and `parseMcpServers` from Task 1.
- Produces:
  - `EnvPort.workspaceFor?(workerId: string, opts?: EnvRunOptions): string`
  - `McpServerConfig` gains `outputDir?: string`, `approval?: 'never' | 'always'`, `approvalTools?: string[]`
  - `McpCallContext { workspaceDir?: string; ticketId?: string; sessionId: string; speculative: boolean }`
  - `McpToolSourceLike.invoke(name, args, context?)`
  - `McpToolSourceLike.approvalFor?(name: string): string | undefined` (optional in this task; implemented in Task 3)
  - normalized media result `{ text: string; files: McpFile[] }` where `McpFile = { path: string; hostPath: string; mimeType: string; bytes: number }`

- [ ] **Step 1: Write the failing media tests**

Create `test/mcp-media.test.ts` with these cases. Use `freshRuntime()` and `shutdown()` from `test/fixtures.ts`, and start the fake server with `process.execPath` + `test/fixtures/fake-mcp-server.mjs`.

```ts
it('writes an image block into the worker workspace', async () => {
  // invoke mcp__fake__image with { sessionId: 's1', workspaceDir, speculative: false }
  // expect files[0].path to match /^mcp\/fake\/.+\.png$/
  // expect files[0].mimeType to be 'image/png'
  // expect fs.existsSync(path.join(workspaceDir, files[0].path)) to be true
})

it('imports a resource_link under outputDir as a workspace path', async () => {
  // create outputDir/video.mp4
  // set FAKE_RESOURCE_PATH to that file in the server env
  // invoke mcp__fake__resource
  // expect files[0].path to be 'mcp/fake/imported/video.mp4'
  // expect files[0].hostPath to be the copied absolute path
})

it('does not import a resource_link outside outputDir', async () => {
  // point FAKE_RESOURCE_PATH at a file outside outputDir
  // expect result.files to be undefined or empty
  // expect the text to contain the original path
})

it('does not import a symlink inside outputDir', async () => {
  // symlink outputDir/link.mp4 -> outside file
  // expect no files
})

it('does not import a file above maxImportBytes', async () => {
  // source file is 20 bytes; deps.maxImportBytes = 10
  // expect no files and mcp.output_rejected incremented
})

it('injects DS_AGENT_MCP_OUTPUT_DIR into the server process', async () => {
  // fake server env tool returns process.env.DS_AGENT_MCP_OUTPUT_DIR
  // expect it to equal the resolved outputDir
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/mcp-media.test.ts
```

Expected: FAIL because `invoke` does not take a context and the fake server has no `resource` tool.

- [ ] **Step 3: Add the fake `resource` tool**

In `test/fixtures/fake-mcp-server.mjs`, add:

```js
{ name: 'resource', description: 'Return a resource_link to FAKE_RESOURCE_PATH.', inputSchema: { type: 'object', properties: {} } },
{ name: 'env', description: 'Return DS_AGENT_MCP_OUTPUT_DIR.', inputSchema: { type: 'object', properties: {} } },
```

and in the call handler:

```js
if (name === 'resource') {
  return { content: [{ type: 'resource_link', uri: `file://${process.env.FAKE_RESOURCE_PATH}`, name: 'video.mp4', mimeType: 'video/mp4' }] }
}
if (name === 'env') {
  return { content: [{ type: 'text', text: process.env.DS_AGENT_MCP_OUTPUT_DIR ?? '' }] }
}
```

- [ ] **Step 4: Add `workspaceFor` to the Env contract and LocalEnv**

In `src/shared/ports.ts`, add to `EnvPort`:

```ts
/** Absolute Worker workspace for this session; isolated mode uses the scratch dir. */
workspaceFor?(workerId: string, opts?: EnvRunOptions): string
```

In `src/env/local-env.ts`, implement:

```ts
workspaceFor(workerId: string, opts?: EnvRunOptions): string {
  return opts?.isolated === true ? this.isolatedWorkspace(workerId) : this.workspace(workerId)
}
```

- [ ] **Step 5: Extend the MCP config schema**

In `src/harness/mcp-config.ts`, add to `McpServerConfig`:

```ts
outputDir?: string
approval?: 'never' | 'always'
approvalTools?: string[]
```

Validate in `parseMcpServers`:
- `outputDir`, when present, is an absolute string;
- `approval`, when present, is `'never'` or `'always'`;
- `approvalTools`, when present, is an array of non-empty strings;
- `approvalTools` without `approval: 'always'` is accepted but has no effect.

- [ ] **Step 6: Pass the call context from ToolRegistry**

In `src/harness/tools.ts`, inside the `mcp__` branch of `invoke`:

```ts
const ticket = ticketOf(store, ctx)
const mode = ticket?.speculative && env.discardIsolated ? { isolated: true } : { isolated: false }
const workspaceDir = env.workspaceFor?.(ctx.sessionId, mode)
return redactUnknown(await this.deps.mcp.invoke(call.name, call.args, {
  ...(workspaceDir ? { workspaceDir } : {}),
  ...(ctx.ticketId ? { ticketId: ctx.ticketId } : {}),
  sessionId: ctx.sessionId,
  speculative: ticket?.speculative === true,
}), this.redact)
```

`ticketOf` and `env` are already available in `ToolRegistry` via `deps.store` and `deps.env`.

- [ ] **Step 7: Extend `McpToolSource`**

In `src/harness/mcp.ts`:

```ts
export interface McpFile {
  path: string
  hostPath: string
  mimeType: string
  bytes: number
}

export interface McpCallContext {
  workspaceDir?: string
  ticketId?: string
  sessionId: string
  speculative: boolean
}

export interface McpToolSourceLike {
  specs(): Promise<ToolSpec[]>
  invoke(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<unknown>
  approvalFor?(name: string): string | undefined
  close(): Promise<void>
}
```

Add `maxImportBytes?: number` to `McpToolSourceDeps` (default `500 * 1024 * 1024`).

In `invoke(name, args, context?)`, pass `context` to `normalize`. In `normalize`:
- image/audio/resource blobs write to `mcp/<server>/<uuid>.<ext>` under `context.workspaceDir`; fallback to the existing `<home>/mcp/<server>` when absent.
- each written file becomes `{ path, hostPath, mimeType, bytes }`; `path` is workspace-relative when `workspaceDir` exists, else absolute.
- Extend the `McpBlock` interface with `uri?: string` and `name?: string` so `resource_link` blocks type-check.
- `resource_link` blocks: only `file:` URIs are candidates; import only when the resolved path is under `config.outputDir` (or `<home>/mcp/<server>` when absent), `lstatSync(file).isFile()` is true, size ≤ `maxImportBytes`, and the real path has no symlink component. Copy to `mcp/<server>/imported/<basename>`; on any failure, leave the original URI as text and increment `mcp.output_rejected`.
- return `text` when no files, otherwise `{ text, files }`.

Inject the resolved output directory into the child environment in `childEnv` or at transport creation:

```ts
const env = { ...childEnv(config, baseEnv), DS_AGENT_MCP_OUTPUT_DIR: config.outputDir ?? path.join(workspaceDir, config.name) }
```

- [ ] **Step 8: Add metrics**

In `src/metrics/metrics.ts`, add `'mcp.output_copied'` and `'mcp.output_rejected'` to `METRIC_NAMES` and `blankCounters()`.

- [ ] **Step 9: Update the #142 invoke test**

In `test/mcp-invoke.test.ts`, replace assertions on `{ text, paths, mimeTypes }` with `{ text, files }` and assert `files[0].path` / `mimeType`.

- [ ] **Step 10: Run the tests**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/mcp-media.test.ts test/mcp-invoke.test.ts test/mcp-source.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/shared/ports.ts src/env/local-env.ts src/harness/mcp-config.ts src/harness/mcp.ts src/harness/tools.ts src/metrics/metrics.ts test/fixtures/fake-mcp-server.mjs test/mcp-invoke.test.ts test/mcp-media.test.ts
git commit -m "feat(mcp): deliver media into the worker workspace"
```

---

### Task 3: Gate expensive MCP tools and refuse MCP for speculative tickets

**Files:**
- Modify: `src/core/collab.ts`
- Modify: `src/harness/mcp.ts`
- Modify: `src/harness/tools.ts`
- Test: `test/mcp-approval.test.ts`

**Interfaces:**
- Consumes: `McpCallContext`, `McpToolSourceLike.approvalFor` from Task 2.
- Produces:
  - `hasApprovedAction(ticket: Ticket, action: string): boolean`
  - `McpToolSource.approvalFor(name: string): string | undefined`
  - `ToolRegistry.invoke` enforces speculative refusal and approval.

- [ ] **Step 1: Write the failing tests**

Create `test/mcp-approval.test.ts`. Use the `fabricate()` ticket helper pattern from `test/approvals.test.ts` and a stub `McpToolSourceLike`.

```ts
it('refuses an MCP call from a speculative ticket', async () => {
  // ticket.speculative = true
  // expect invoke to reject with /speculative/
  // expect the stub invoke not to have been called
})

it('refuses an approval-gated tool without an approved action', async () => {
  // stub.approvalFor returns 'mcp:fake:echo'
  // ticket has no approved approval
  // expect reject with /request_approval/ and /mcp:fake:echo/
})

it('allows the gated tool after the owner approves that action', async () => {
  // ticket.collab.approvals = [{ id: 'a1', at, action: 'mcp:fake:echo', requestedBy: 'w', status: 'approved' }]
  // expect invoke resolves
})

it('does not gate a tool that is not in approvalTools', async () => {
  // stub.approvalFor returns undefined for mcp__fake__status
  // expect invoke resolves without an approval
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/mcp-approval.test.ts
```

Expected: FAIL because `approvalFor` and the checks do not exist.

- [ ] **Step 3: Add the approval helper**

In `src/core/collab.ts`, export:

```ts
/** True when this ticket has an approved request for exactly this action. */
export function hasApprovedAction(ticket: Ticket, action: string): boolean {
  return (ticket.collab?.approvals ?? []).some(
    approval => approval.status === 'approved' && approval.action === action,
  )
}
```

- [ ] **Step 4: Implement `approvalFor`**

In `src/harness/mcp.ts`:

```ts
approvalFor(name: string): string | undefined {
  const connection = this.resolve(name)
  if (!connection || connection.config.approval !== 'always') return undefined
  const tool = name.slice(mcpToolName(connection.config.name, '').length)
  const gated = connection.config.approvalTools ?? []
  if (gated.length > 0 && !gated.includes(tool)) return undefined
  return `mcp:${connection.config.name}:${tool}`
}
```

- [ ] **Step 5: Enforce in ToolRegistry**

In the `mcp__` branch of `ToolRegistry.invoke`, before calling the source:

```ts
const ticket = ticketOf(store, ctx)
if (ticket?.ended) throw new UserError(`ticket ${ticket.id} has ended (${ticket.ended.outcome})`)
if (ticket?.speculative) throw new UserError(`mcp tool ${call.name} is not available to speculative tickets`)
const action = this.deps.mcp.approvalFor?.(call.name)
if (action && (!ticket || !hasApprovedAction(ticket, action))) {
  throw new UserError(
    `mcp tool ${call.name} requires owner approval; call request_approval with action "${action}" first`,
  )
}
```

- [ ] **Step 6: Run the tests**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/mcp-approval.test.ts test/mcp-registry.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/collab.ts src/harness/mcp.ts src/harness/tools.ts test/mcp-approval.test.ts
git commit -m "feat(mcp): require owner approval for gated tools"
```

---

### Task 4: Load plugin bundles and merge their components

**Files:**
- Create: `src/plugins.ts`
- Modify: `src/env/skills.ts`
- Modify: `src/runtime.ts`
- Modify: `src/metrics/metrics.ts`
- Test: `test/plugins.test.ts`
- Test: `test/plugins-runtime.test.ts`

**Interfaces:**
- Consumes: `loadSkills`, `normalizeLocalAgents`, `normalizeRoutines`, `parseMcpServers`.
- Produces:
  - `loadSkillsFromDir(root: string, warn?): SkillRecord[]`
  - `loadPluginSet(home: string, env?: NodeJS.ProcessEnv, warn?: (line: string) => void): PluginSet`
  - `validatePluginDir(dir: string, opts: { home: string; env?: NodeJS.ProcessEnv; dataDir?: string }): PluginRecord` (reads and validates one source directory without starting MCP servers or writing)
  - `PluginSet { plugins: PluginRecord[]; skills: SkillRecord[]; mcpServers: McpServerConfig[]; agents: LocalAgentSpec[]; routines: RoutineSpec[] }`
  - `PluginRecord { id; dir; dataDir; enabled; version?; description?; error?; skills; mcpServers; agents; routines }`

- [ ] **Step 1: Write the failing loader tests**

Create `test/plugins.test.ts` with a temp home helper. Cover:

```ts
it('loads a plugin with a skill, an MCP server, an agent, and a routine')
it('skips a plugin with an unknown manifest key')
it('skips the whole plugin when one component conflicts with a home skill')
it('keeps an installed plugin enabled when plugins.json has no entry for it')
it('disables every plugin when plugins.json is corrupt')
it('resolves ${pluginDir}, ${pluginData}, ${home}, and ${ENV_NAME}')
it('skips a plugin when ${ENV_NAME} is unset')
it('skips a plugin whose outputDir is outside <home>')
it('keeps a good plugin when a neighboring plugin is broken')
```

Use exact fixture content:

```ts
const manifest = {
  name: 'demo',
  version: '0.1.0',
  description: 'Demo plugin',
  skills: 'skills',
  mcpServers: [{ name: 'fake', command: 'node', args: ['${pluginDir}/server.mjs'], env: { TOKEN: '${DEMO_TOKEN}' }, outputDir: '${pluginData}/output' }],
  agents: [{ id: 'helper', command: 'node', args: ['${pluginDir}/helper.mjs'] }],
  routines: [{ id: 'daily', everyMinutes: 60, prompt: 'check', source: 'cli', thread: 'local' }],
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/plugins.test.ts
```

Expected: FAIL because `src/plugins.ts` does not exist.

- [ ] **Step 3: Split skill loading by root**

In `src/env/skills.ts`, extract:

```ts
export function loadSkillsFromDir(root: string, warn: (line: string) => void = () => {}): SkillRecord[]
```

and make `loadSkills(home, warn)` call `loadSkillsFromDir(path.join(home, SKILLS_DIR), warn)`.

- [ ] **Step 4: Implement the plugin loader**

Create `src/plugins.ts` with:

```ts
export const PLUGINS_DIR = 'plugins'
export const PLUGIN_FILE = 'plugin.json'
export const PLUGINS_FILE = 'plugins.json'
export const PLUGIN_DATA_DIR = 'plugin-data'
export const MAX_PLUGINS = 16
export const MAX_PLUGIN_BYTES = 100 * 1024 * 1024

export interface PluginRecord { /* exact fields above */ }
export interface PluginSet { /* exact fields above */ }

export function loadPluginSet(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = () => {},
): PluginSet
```

Implementation rules:
- Read `<home>/plugins/*/plugin.json` in directory-name order.
- Validate `name` (`^[a-z][a-z0-9-]{0,63}$`, equals directory), `version` (semver-ish), `description` (single line, ≤200), unknown top-level keys, and at least one component.
- Validate `skills` as a single path segment (`^[A-Za-z0-9._-]+$`) that is not `.` or `..`; the resolved directory must stay inside the plugin dir.
- Enforce the combined caps after merging: 64 skills, 16 local agents, 32 routines, 16 MCP servers, 16 plugins. A cap overflow skips the plugin that would exceed it.
- Read `<home>/plugins.json`; absent or missing entry means enabled; `enabled: false` disables; corrupt file disables all and emits one warning.
- Seed conflicts with home first: skill ids from `loadSkillsFromDir(<home>/skills)`, agent ids from `loadLocalAgents`, routine ids from `loadRoutines`, server names from `DS_AGENT_MCP_SERVERS`.
- Resolve `${pluginDir}`, `${pluginData}`, `${home}` in `command`, `args`, `env` values, and `outputDir`; resolve `${ENV_NAME}` only in `env` values. An unresolved `${...}` or unset env var fails the plugin.
- Resolve `outputDir`: manifest value, else `${pluginData}/output`; it must be an absolute path under `home`.
- On any component error, set `record.error`, clear that record's components, log `[plugin] skipped id=<id> reason=<...>`, and continue.
- `PluginSet.skills` / `agents` / `routines` are the **merged** home + plugin lists (home wins conflicts).
- `PluginSet.mcpServers` is **plugin servers only**; Runtime still parses `DS_AGENT_MCP_SERVERS` / `RuntimeOptions.mcpServers` and appends these, skipping duplicate names.
- `PluginRecord` keeps each plugin's own components for `plugin list` and diagnostics.

- [ ] **Step 5: Wire the plugin set into Runtime**

In `src/runtime.ts`:
- Add `'plugin.loaded'` and `'plugin.skipped'` to `METRIC_NAMES` and `blankCounters()`.
- Call `const pluginSet = loadPluginSet(opts.home, baseEnv, line => log.info(line))` once, before skills / agents / routines / MCP parsing.
- Increment `plugin.loaded` for enabled records without `error`, and `plugin.skipped` for records with `error`.
- Use `opts.localAgents ?? pluginSet.agents`, `opts.skills ?? new SkillRegistry(pluginSet.skills)`, `opts.routines ?? pluginSet.routines`.
- For MCP, parse the env/options servers first, then append `pluginSet.mcpServers`, skipping duplicate names already seen; log conflicts.
- Keep `RuntimeOptions` overrides winning.
- Expose the constructed source as `readonly mcp?: McpToolSourceLike` on `Runtime` for diagnostics and tests.

- [ ] **Step 6: Write the runtime composition test**

Create `test/plugins-runtime.test.ts`:

```ts
it('exposes plugin skills, agents, routines, and MCP tools to the configured roles', async () => {
  // temp home with a plugin carrying one skill, one fake MCP server, one agent, one routine
  // freshRuntime({ home, allowMockModel: true })
  // expect runtime.skills.list() to contain the plugin skill
  // expect runtime.localAgents.list() to contain the plugin agent
  // expect runtime.routines.list() to contain the plugin routine
  // expect (await runtime.mcp!.specs()).map(s => s.name) to contain mcp__fake__echo
})
```

Use the public `Runtime` fields (`runtime.skills`, `runtime.localAgents`, `runtime.routines`) and the exposed `runtime.mcp`.

- [ ] **Step 7: Run the tests**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/plugins.test.ts test/plugins-runtime.test.ts test/cli-skills.test.ts test/cli-agents.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/plugins.ts src/env/skills.ts src/runtime.ts src/metrics/metrics.ts test/plugins.test.ts test/plugins-runtime.test.ts
git commit -m "feat(plugin): load bundles into the runtime"
```

---

### Task 5: Add the owner-only `plugin` CLI and docs

**Files:**
- Create: `src/cli/plugins.ts`
- Modify: `src/cli/main.ts`
- Modify: `docs/MODULES.md`
- Create: `docs/PLUGINS.md`
- Modify: `README.md`
- Test: `test/cli-plugins.test.ts`

**Interfaces:**
- Consumes: `loadPluginSet`, `PluginRecord`.
- Produces: `runPluginCommand(home: string, argv: string[]): Promise<void>` wired to `ds-agent plugin ...`.

- [ ] **Step 1: Write the failing CLI tests**

Create `test/cli-plugins.test.ts` using the child-process pattern from `test/cli-agents.test.ts` (`DS_AGENT_HOME`, `NODE_NO_WARNINGS`). Cover:

```ts
it('adds, lists, disables, enables, and removes a plugin')
it('validates a plugin without starting its MCP server')
it('refuses to overwrite without --force')
it('rejects a plugin tree containing a symlink')
it('purges plugin-data only with --purge')
it('prints JSON for list --json')
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/cli-plugins.test.ts
```

Expected: FAIL with `unknown command plugin`.

- [ ] **Step 3: Implement the CLI**

Create `src/cli/plugins.ts` with:

```ts
export async function runPluginCommand(home: string, argv: string[]): Promise<void>
```

Commands:
- `list [--json]`
- `add <dir> [--force]`
- `enable <id>`
- `disable <id>`
- `remove <id> --force [--purge]`
- `validate <dir>`

`add`:
- run the same validation as `loadPluginSet` against the source directory;
- reject any symlink in the tree;
- skip `.git/` and `node_modules/`;
- refuse a total size over 100 MB;
- copy to `<home>/plugins/<id>`; refuse an existing target without `--force`;
- upsert `{ id, enabled: true }` in `<home>/plugins.json` using a temp file + rename.

`remove`:
- require `--force`;
- delete `<home>/plugins/<id>` and the registry entry;
- delete `<home>/plugin-data/<id>` only with `--purge`.

`validate`:
- never starts an MCP server and never writes.

- [ ] **Step 4: Wire the command**

In `src/cli/main.ts`:
- import `runPluginCommand`;
- before the final `throw new Error('unknown command ...')`, add:

```ts
if (cmd === 'plugin') {
  await runPluginCommand(home, process.argv.slice(3))
  return
}
```

- add the usage line:

```text
pnpm ds-agent plugin list|add <dir>|enable <id>|disable <id>|remove <id>|validate <dir>
```

- [ ] **Step 5: Write the docs**

`docs/PLUGINS.md` must cover:
- directory layout and `plugin.json` schema;
- placeholders and secret handling;
- enable/disable semantics, including missing `plugins.json` entries;
- conflict and failure isolation;
- role exposure (MCP worker-only, agents list visible but execution worker-only, routines through ingress);
- `approval` / `approvalTools`;
- the install command and local `pnpm link --global` expectation for MCP servers.

Update `docs/MODULES.md`:
- M1: MCP client, media import, approval.
- M11 Runtime composition: plugin bundle loader in `src/plugins.ts` (it composes M1/M9/M10, so it cannot live in M9).
- M11 CLI: `plugin` command.

Update `README.md` with a short "Plugins" section pointing to `docs/PLUGINS.md`.

- [ ] **Step 6: Run the tests and lint**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/cli-plugins.test.ts
pnpm typecheck
pnpm lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/plugins.ts src/cli/main.ts docs/PLUGINS.md docs/MODULES.md README.md test/cli-plugins.test.ts
git commit -m "feat(plugin): add the owner-only plugin CLI"
```

---

### Task 6: Add the two example plugin packs and the end-to-end test

**Files:**
- Create: `examples/plugins/video-jimeng/plugin.json`
- Create: `examples/plugins/video-jimeng/skills/seedance-video/SKILL.md`
- Create: `examples/plugins/image-krene/plugin.json`
- Create: `examples/plugins/image-krene/skills/krene-image/SKILL.md`
- Test: `test/plugins-examples.test.ts`
- Test: `test/plugins-e2e.test.ts`

**Interfaces:**
- Consumes: the `plugin validate` and runtime composition from Tasks 4–5.
- Produces: two installable example packs; an offline end-to-end test using the fake MCP server.

- [ ] **Step 1: Write the failing example tests**

`test/plugins-examples.test.ts`:

```ts
it('validates the video-jimeng example')
it('validates the image-krene example')
it('gates only jimeng_generate_video in the video example')
```

`test/plugins-e2e.test.ts`:

```ts
it('installs a copy of the example, exposes its skill and MCP tool, and delivers a resource file', async () => {
  // temp home
  // copy examples/plugins/video-jimeng to <home>/plugins/video-jimeng
  // rewrite its mcpServers[0] to the fake server command for this test
  // freshRuntime({ home, allowMockModel: true })
  // assert the skill appears in runtime.skills
  // assert mcp__fake__resource appears in worker specs
  // invoke it and assert the file lands under the worker workspace
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/plugins-examples.test.ts test/plugins-e2e.test.ts
```

Expected: FAIL because the example directories do not exist.

- [ ] **Step 3: Write the example manifests and skills**

`examples/plugins/video-jimeng/plugin.json`:

```json
{
  "name": "video-jimeng",
  "version": "0.1.0",
  "description": "Seedance 2.0 video generation for Workers",
  "skills": "skills",
  "mcpServers": [{
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
  }]
}
```

`examples/plugins/image-krene/plugin.json`:

```json
{
  "name": "image-krene",
  "version": "0.1.0",
  "description": "Krene design and image generation for Workers",
  "skills": "skills",
  "mcpServers": [{
    "name": "krene",
    "command": "krene-mcp",
    "args": ["serve"],
    "timeoutMs": 300000,
    "outputDir": "${pluginData}/output",
    "approval": "always",
    "approvalTools": ["krene_generate_image", "krene_edit_image"]
  }]
}
```

Each `SKILL.md` has valid frontmatter with a single-line `description`, then instructions covering:
- when to use the tool;
- call `request_approval` with `action: mcp:<server>:<tool>` before the first generation;
- pass the returned `hostPath` to `report_to_router`;
- on `TIMEOUT`, poll with the task tool instead of starting a second generation;
- never invent a file path.

- [ ] **Step 4: Run the tests and the offline suite**

```bash
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm exec vitest run test/plugins-examples.test.ts test/plugins-e2e.test.ts
DS_AGENT_ALLOW_MOCK_FIXTURE=1 NODE_NO_WARNINGS=1 pnpm test
pnpm typecheck
pnpm lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/plugins test/plugins-examples.test.ts test/plugins-e2e.test.ts
git commit -m "feat(plugin): add the media example bundles"
```

---

## Execution Notes

- Tasks 1–3 touch MCP files; do not run two tasks that both edit `src/harness/mcp.ts` at the same time.
- Tasks 4–5 touch plugin files; Task 4 must land before Task 5's CLI tests can pass.
- Task 6 depends on Tasks 4–5 and on `jimeng-mcp` existing for a real live run; the offline e2e uses the fake server, so it can land before `jimeng-mcp` is built.
- After each green CI run, merge `origin/main` into the PR branch and wait for CI again before merging. A peer session may merge first.
