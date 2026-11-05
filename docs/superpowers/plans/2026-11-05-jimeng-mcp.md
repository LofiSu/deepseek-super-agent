# jimeng-mcp — Seedance 2.0 MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone stdio MCP server that creates Seedance 2.0 video tasks through Volcengine Ark, polls them, downloads the result, and returns a local file path plus a `resource_link`.

**Architecture:** A small TypeScript package with four units: config, Ark HTTP client, downloader, and MCP tools. Every network call goes through an injected `fetch` so the whole suite runs offline. The server is transport-only: it never admits users, never decides approvals, and never knows about ds-agent.

**Tech Stack:** Node.js 22+, TypeScript, ESM, pnpm, vitest, `@modelcontextprotocol/sdk`.

**Spec:** `deepseek-super-agent/docs/superpowers/specs/2026-11-05-plugin-bundles-and-media-mcp-design.md` (sections 6.9 and 10)

**Target repo:** `jimeng-mcp` (new repository under `LofiSu`)

## Global Constraints

- Node.js 22+; ESM TypeScript; pnpm.
- stdio MCP only. No HTTP/SSE transport.
- No Volcengine SDK; use `fetch`.
- Offline tests must not touch the network. Live tests are `JIMENG_LIVE=1` only.
- Never log `ARK_API_KEY`, image data, or full signed download URLs.
- Downloads: HTTPS only, host allowlist, redirects revalidated, size cap; delete partial files on failure.
- `ARK_API_KEY` is read at call time, not at module load.
- Model IDs and API base are configuration, never hardcoded in tool code.
- Owner-only repository: only LofiSu commits; no non-LofiSu co-author trailers.

## Review Focus

- Missing `ARK_API_KEY`: expect `AUTH_REQUIRED` from the tool, not a crash at startup.
- Task `failed` / `expired` / `cancelled`: expect a structured error carrying `taskId`, not a generic network error.
- Download URL host not allowlisted, or a redirect to an unknown host: expect refusal and no partial file.
- Poll window expires while the task is still `running`: expect `{ status: 'running', taskId, pollWith: 'jimeng_task' }`, not an error.
- `imagePath` outside `JIMENG_INPUT_ROOTS` or over 10 MB: expect `INVALID_INPUT`.

---

### Task 1: Scaffold the package, config, and `jimeng_status`

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/config.ts`
- Create: `src/errors.ts`
- Create: `src/log.ts`
- Create: `src/cli.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `Config { apiKey?: string; baseUrl: string; model: string; outputDir: string; inputRoots: string[]; downloadHosts: string[]; pollMs: number; waitSec: number; maxDownloadBytes: number }`
  - `loadConfig(env?: NodeJS.ProcessEnv): Config`
  - `UserError` with a `code` field (`AUTH_REQUIRED`, `INVALID_INPUT`, `NETWORK`, `TASK_FAILED`, `TIMEOUT`, `QUOTA_EXHAUSTED`)

- [ ] **Step 1: Write the failing config tests**

Create `test/config.test.ts`:

```ts
it('uses the documented defaults')
it('honors ARK_BASE_URL, JIMENG_MODEL, and JIMENG_OUTPUT_DIR')
it('prefers DS_AGENT_MCP_OUTPUT_DIR over JIMENG_OUTPUT_DIR')
it('splits JIMENG_INPUT_ROOTS on the path delimiter')
it('rejects a non-positive JIMENG_POLL_MS or JIMENG_WAIT_SEC')
it('keeps ARK_API_KEY optional so status can report it missing')
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run test/config.test.ts
```

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Create the package skeleton**

`package.json`:

```json
{
  "name": "jimeng-mcp",
  "version": "0.1.0",
  "description": "Seedance 2.0 video generation MCP server",
  "type": "module",
  "bin": { "jimeng-mcp": "./dist/cli.js" },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev": "tsx src/cli.ts",
    "serve": "tsx src/cli.ts serve"
  },
  "dependencies": { "@modelcontextprotocol/sdk": "1.32.2" },
  "devDependencies": { "@types/node": "^22.15.0", "tsx": "^4.20.0", "typescript": "^5.9.0", "vitest": "^3.2.0" }
}
```

`tsconfig.json`: `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `strict true`, `outDir dist`, `rootDir src`, `declaration true`.

- [ ] **Step 4: Implement config and errors**

`src/config.ts`:

```ts
export interface Config {
  apiKey?: string
  baseUrl: string
  model: string
  outputDir: string
  inputRoots: string[]
  downloadHosts: string[]
  pollMs: number
  waitSec: number
  maxDownloadBytes: number
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config
```

Defaults:
- `baseUrl`: `https://ark.cn-beijing.volces.com/api/v3`
- `model`: `doubao-seedance-2-0-fast-260128`
- `outputDir`: `DS_AGENT_MCP_OUTPUT_DIR` → `JIMENG_OUTPUT_DIR` → `~/.jimeng-mcp/output`
- `inputRoots`: `JIMENG_INPUT_ROOTS` split on `path.delimiter`, default `[outputDir, process.cwd()]`
- `downloadHosts`: `JIMENG_DOWNLOAD_HOSTS` split on comma, default `['byteimg.com','volces.com','volccdn.com','ibyteimg.com']`
- `pollMs`: 2000
- `waitSec`: 120
- `maxDownloadBytes`: 500 * 1024 * 1024

`src/errors.ts`: `UserError extends Error` with `code: 'AUTH_REQUIRED' | 'INVALID_INPUT' | 'NETWORK' | 'TASK_FAILED' | 'TIMEOUT' | 'QUOTA_EXHAUSTED'`.

- [ ] **Step 5: Add the CLI skeleton and status command**

`src/cli.ts` supports `serve` and `status`. `status` prints JSON:

```json
{ "apiKey": "present", "baseUrl": "...", "model": "...", "outputDir": "..." }
```

It never prints the key value. `serve` calls `runServe(config)` (added in Task 4); until then, exit 1 with `serve not implemented yet` so the CLI compiles.

- [ ] **Step 6: Run the tests**

```bash
pnpm install
pnpm exec vitest run test/config.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/config.ts src/errors.ts src/log.ts src/cli.ts test/config.test.ts
git commit -m "feat: scaffold jimeng-mcp config and CLI"
```

---

### Task 2: Implement the Ark create/get client

**Files:**
- Create: `src/ark.ts`
- Test: `test/ark.test.ts`
- Create: `test/fixtures/create-task.json`
- Create: `test/fixtures/get-task-succeeded.json`
- Create: `test/fixtures/get-task-failed.json`

**Interfaces:**
- Produces:
  - `ArkClient { createTask(input: CreateTaskInput): Promise<ArkTask>; getTask(id: string): Promise<ArkTask> }`
  - `CreateTaskInput { model: string; content: ArkContent[]; ratio?: string; resolution?: string; duration?: number; seed?: number; watermark?: boolean; generateAudio?: boolean }`
  - `ArkContent = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string }; role?: 'first_frame' | 'last_frame' | 'reference_image' }`
  - `ArkTask { id: string; status: 'queued'|'running'|'succeeded'|'failed'|'cancelled'|'expired'; content?: { video_url?: string }; error?: { code?: string; message?: string } }`
  - `createArkClient(config: Config, fetchImpl?: typeof fetch): ArkClient`

- [ ] **Step 1: Write the failing client tests**

Create `test/ark.test.ts` with a fake `fetch` that records requests and returns fixtures:

```ts
it('POSTs to /contents/generations/tasks with the bearer key and exact body')
it('GETs /contents/generations/tasks/{id}')
it('maps 401 and 403 to AUTH_REQUIRED')
it('maps 402 or a quota body to QUOTA_EXHAUSTED')
it('maps a non-2xx response to NETWORK')
it('maps a failed task body to TASK_FAILED with taskId')
```

The create assertion must include:

```ts
expect(body).toEqual({
  model: 'doubao-seedance-2-0-fast-260128',
  content: [{ type: 'text', text: 'a cat surfing' }],
  ratio: '16:9',
  duration: 5,
  watermark: false,
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run test/ark.test.ts
```

Expected: FAIL because `src/ark.ts` does not exist.

- [ ] **Step 3: Implement the client**

`src/ark.ts`:

```ts
export function createArkClient(config: Config, fetchImpl: typeof fetch = fetch): ArkClient
```

Rules:
- `Authorization: Bearer ${config.apiKey}`; if the key is missing, throw `AUTH_REQUIRED` before calling `fetch`.
- `Content-Type: application/json`.
- Use `AbortSignal.timeout(config.waitSec * 1000)` per request.
- `createTask` posts `{ model, content, ratio, resolution, duration, seed, watermark, generate_audio }`, omitting undefined fields and mapping `generateAudio` to `generate_audio`.
- `getTask` gets `/contents/generations/tasks/${encodeURIComponent(id)}`.
- A `failed`/`cancelled`/`expired` task becomes `UserError` with code `TASK_FAILED`, message including `taskId` and `error.message`.
- HTTP 402, or a body whose error code/message names quota/points/balance, becomes `QUOTA_EXHAUSTED`; pass the provider message through after redaction.
- Never include the key or full response body in the error.

- [ ] **Step 4: Run the tests**

```bash
pnpm exec vitest run test/ark.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ark.ts test/ark.test.ts test/fixtures
git commit -m "feat: add the Ark task client"
```

---

### Task 3: Download videos safely

**Files:**
- Create: `src/download.ts`
- Test: `test/download.test.ts`

**Interfaces:**
- Produces: `downloadVideo(url: string, destDir: string, opts: { hosts: string[]; maxBytes: number; fetchImpl?: typeof fetch }): Promise<{ path: string; bytes: number }>`

- [ ] **Step 1: Write the failing download tests**

Create `test/download.test.ts` with a fake `fetch`:

```ts
it('downloads an HTTPS URL on an allowed host and writes video.mp4')
it('rejects a non-HTTPS URL')
it('rejects a host not in the allowlist')
it('rejects a redirect to a host not in the allowlist')
it('stops at maxBytes and deletes the partial file')
it('accepts a subdomain when the allowlist entry is a suffix')
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run test/download.test.ts
```

Expected: FAIL because `src/download.ts` does not exist.

- [ ] **Step 3: Implement the downloader**

`src/download.ts`:
- Parse the URL; require `https:`.
- Host matches an allowlist entry when it equals the entry or ends with `.${entry}`.
- Use `redirect: 'manual'`; on 3xx, read `location`, validate the new URL, and follow at most 3 hops.
- Stream the body with a byte counter; if it exceeds `maxBytes`, abort, delete the partial file, throw `INVALID_INPUT`.
- Write to `path.join(destDir, 'video.mp4')`; create `destDir` recursively.
- Return the absolute path and byte count.

- [ ] **Step 4: Run the tests**

```bash
pnpm exec vitest run test/download.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/download.ts test/download.test.ts
git commit -m "feat: download generated videos behind a host allowlist"
```

---

### Task 4: Implement the generation tools and the MCP server

**Files:**
- Create: `src/tools.ts`
- Create: `src/server.ts`
- Modify: `src/cli.ts`
- Test: `test/tools.test.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `createArkClient`, `downloadVideo`.
- Produces:
  - `interface ToolDeps { config: Config; ark: ArkClient; download: typeof downloadVideo; now?: () => Date }`
  - `GenerateVideoInput { prompt: string; imageUrl?: string; imagePath?: string; imageRole?: 'first_frame'|'last_frame'|'reference_image'; model?: string; ratio?: string; resolution?: string; duration?: number; seed?: number; watermark?: boolean; generateAudio?: boolean; waitSec?: number }`
  - `GenerateVideoResult { taskId: string; status: string; videoPath?: string; videoUrl?: string; bytes?: number; model?: string; duration?: number; ratio?: string; resolution?: string; pollWith?: 'jimeng_task' }`
  - `generateVideo(input: GenerateVideoInput, deps: ToolDeps): Promise<GenerateVideoResult>`
  - `jimengTask(input: { taskId: string; download?: boolean }, deps: ToolDeps): Promise<GenerateVideoResult>`
  - `createServer(deps: ToolDeps): Server`
  - `runServe(config: Config): Promise<void>`

- [ ] **Step 1: Write the failing tool tests**

Create `test/tools.test.ts` with fake Ark and download functions:

```ts
it('creates, polls, downloads, and returns a local path on success')
it('returns running plus taskId when the poll window expires')
it('returns TASK_FAILED for a failed task')
it('rejects imagePath outside inputRoots')
it('rejects imagePath over 10 MB')
it('accepts an https imageUrl without touching the filesystem')
```

Exact success assertion:

```ts
expect(result).toMatchObject({
  taskId: 'cgt-1',
  status: 'succeeded',
  videoPath: path.join(outputDir, '2026-11-05', 'cgt-1', 'video.mp4'),
  model: 'doubao-seedance-2-0-fast-260128',
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run test/tools.test.ts
```

Expected: FAIL because `src/tools.ts` does not exist.

- [ ] **Step 3: Implement the tools**

`src/tools.ts`:
- `generateVideo` validates input, builds content blocks, calls `createTask`, polls `getTask` every `config.pollMs` until `waitSec`, then downloads on `succeeded`.
- A local `imagePath` is read only when it is a regular file under one of `config.inputRoots` and ≤ 10 MB; convert to `data:${mime};base64,${...}`.
- On timeout return `{ taskId, status: 'running', pollWith: 'jimeng_task' }`.
- `jimengTask` queries once and downloads when `succeeded` and `download !== false`.

`src/server.ts`:
- Create a `Server` with tools:
  - `jimeng_status`: `{ apiKey: 'present'|'missing', baseUrl, model, outputDir }`
  - `jimeng_generate_video`: the schema above.
  - `jimeng_task`: `{ taskId, download? }`.
- Text result: `JSON.stringify(result)`.
- On success with `videoPath`, also return a `resource_link` block:

```ts
{ type: 'resource_link', uri: pathToFileURL(result.videoPath).href, name: path.basename(result.videoPath), mimeType: 'video/mp4' }
```

- On `UserError`, return `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, taskId? }) }] }`.

- [ ] **Step 4: Wire `serve`**

In `src/cli.ts`, `serve` calls `runServe(loadConfig())`; `runServe` connects `createServer` to `StdioServerTransport` and exits on stdin end.

- [ ] **Step 5: Add the server smoke test**

`test/server.test.ts`: start the server in-process with a fake transport or call the registered handlers directly; assert `tools/list` returns the three tools and `tools/call` for `jimeng_status` returns JSON without the key value.

- [ ] **Step 6: Run the tests**

```bash
pnpm exec vitest run test/tools.test.ts test/server.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts src/server.ts src/cli.ts test/tools.test.ts test/server.test.ts
git commit -m "feat: add Seedance tools and the stdio MCP server"
```

---

### Task 5: Add the live test, README, and mount examples

**Files:**
- Create: `test/live.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `generateVideo`, `loadConfig`.
- Produces: a gated live acceptance test and mount snippets for Claude Code, Codex, and ds-agent.

- [ ] **Step 1: Write the gated live test**

`test/live.test.ts`:

```ts
const live = process.env.JIMENG_LIVE === '1'
describe.skipIf(!live)('live Seedance', () => {
  it('generates a 5 second video and writes the file', async () => {
    const config = loadConfig()
    const deps: ToolDeps = {
      config,
      ark: createArkClient(config),
      download: downloadVideo,
      now: () => new Date(),
    }
    const result = await generateVideo({
      prompt: 'a paper boat on a calm pond, slow camera push in',
      duration: 5,
      ratio: '16:9',
      resolution: '720p',
    }, deps)
    expect(result.status).toBe('succeeded')
    expect(result.videoPath).toBeDefined()
    expect(fs.statSync(result.videoPath!).size).toBeGreaterThan(0)
  }, 300_000)
})
```

- [ ] **Step 2: Run the live test only with a real key**

```bash
JIMENG_LIVE=1 ARK_API_KEY=... pnpm exec vitest run test/live.test.ts
```

Expected: PASS with a real file. Record the file path and size. If no key is available, record "live not run" and do not claim the capability.

- [ ] **Step 3: Write the README**

Cover:
- what it is and the Ark endpoint/model defaults;
- config table (the same variables as the spec);
- `pnpm build && pnpm link --global`;
- mount examples:
  - Claude Code `.mcp.json`;
  - Codex `config.toml` `[mcp_servers.jimeng]`;
  - ds-agent `DS_AGENT_MCP_SERVERS` and the `video-jimeng` plugin;
- security notes: host allowlist, size cap, no key logging;
- offline vs live testing.

- [ ] **Step 4: Run the full offline suite**

```bash
pnpm test
pnpm typecheck
```

Expected: PASS; live test skipped.

- [ ] **Step 5: Commit**

```bash
git add test/live.test.ts README.md
git commit -m "docs: document installation and live acceptance"
```

---

## Execution Notes

- Task 1's CLI `serve` is a stub until Task 4; do not publish before Task 4.
- The live acceptance needs the owner's `ARK_API_KEY`; without it, PR evidence is "offline fixture suite passes" only.
- `duration`, `resolution`, and `ratio` values are model-dependent. Do not encode a hard range in the tool; let Ark reject invalid combinations and pass the error through.
- If the live API rejects `data:` image URLs, restrict `imagePath` to an error that tells the caller to use `imageUrl`; update the README and the ds-agent skill accordingly.
