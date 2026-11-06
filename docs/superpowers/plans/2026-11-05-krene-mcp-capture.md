# krene-mcp — Finish Login, Capture, Sanitize, and the Status MCP Server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the existing `feat/krene-mcp-server` branch so it can log in once, capture real HTTP/WebSocket traffic, sanitize it into fixtures, and serve `krene_status` / `krene_login` over MCP. Image generation stays out of scope until the owner runs a real capture.

**Architecture:** Reuse the existing CLI, browser login, session storage, capture recorder, sanitizer, and HTTP client. Add one MCP server module that exposes only status and a login hint; it never opens a browser. The capture and sanitize commands stay separate so raw traffic is never committed.

**Tech Stack:** Node.js 22+, TypeScript, ESM, pnpm, vitest, `@modelcontextprotocol/sdk`, optional Playwright for login/capture.

**Spec:** `deepseek-super-agent/docs/superpowers/specs/2026-11-05-plugin-bundles-and-media-mcp-design.md` (section 6.10)

**Target repo:** `krene-mcp` (existing; branch `feat/krene-mcp-server`)

## Global Constraints

- Reuse the existing branch; do not rewrite login, capture, sanitize, session, or HTTP client.
- Node.js 22+; ESM TypeScript; pnpm.
- Offline tests only. Playwright is an optional dependency and must not run in CI.
- Never log or commit tokens, cookies, phone numbers, emails, or signed image URLs.
- Session file is `~/.krene-mcp/session.json`, mode 0600.
- `capture` records raw traffic only; `sanitize` writes fixtures. Never auto-sanitize inside `capture`.
- The MCP server never opens a browser and never waits for human input.
- No image/design tools until a real fixture exists and the design is updated.
- Owner-only repository: only LofiSu commits; no non-LofiSu co-author trailers.

## Review Focus

- A captured frame contains a token, cookie, phone number, or email: expect `[redacted]` in the sanitized output.
- `capture` records no WebSocket frames: expect a loud failure, not an empty fixture.
- `session.json` exists with loose permissions: expect `0600` after a write.
- `krene_status` runs with no session: expect `{ loggedIn: false }` and a login hint, not a crash.
- `krene_login` is called from a Worker: expect a status/hint response, never a browser launch.

---

### Task 1: Verify the existing branch baseline

**Files:**
- Verify: `package.json`, `src/cli.ts`, `src/auth/*`, `src/capture/*`, `src/http/client.ts`, `test/*`

**Interfaces:**
- Consumes: nothing new.
- Produces: a green baseline on `feat/krene-mcp-server`.

- [ ] **Step 1: Run the existing checks**

```bash
git checkout feat/krene-mcp-server
pnpm install
pnpm typecheck
pnpm test
```

Expected: typecheck exits 0; the existing tests pass (session, config, HTTP client, capture format, sanitize, verdict, browser helper).

- [ ] **Step 2: Record the baseline**

Write the command output summary in the task report: test count, skipped count, and any existing failure. If a test fails, fix it before adding the MCP server; do not build on a red baseline.

- [ ] **Step 3: Commit any baseline fix**

If a fix was needed:

```bash
git add <fixed files>
git commit -m "fix: restore the krene-mcp baseline"
```

---

### Task 2: Add the `krene_status` / `krene_login` MCP server

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/tools.ts`
- Modify: `src/cli.ts`
- Test: `test/mcp-server.test.ts`

**Interfaces:**
- Consumes: `Config`, `assertSession`, `readSession`, `KreneHttp`.
- Produces:
  - `interface KreneToolDeps { config: Config; http?: KreneHttp }`
  - `kreneStatus(deps: KreneToolDeps): Promise<{ loggedIn: boolean; user?: string; points?: number; hint?: string }>`
  - `kreneLogin(deps: KreneToolDeps): { status: 'OK' | 'AUTH_REQUIRED'; message: string }`
  - `createServer(deps: KreneToolDeps): Server`
  - `runServe(config: Config): Promise<void>`

- [ ] **Step 1: Write the failing server tests**

Create `test/mcp-server.test.ts`:

```ts
it('lists krene_status and krene_login')
it('reports loggedIn: false and a login hint when no session exists')
it('reports the member name and points when a session exists')
it('maps an expired token to AUTH_EXPIRED in the status text')
it('returns a status hint from krene_login without a session')
it('does not import Playwright from the MCP server module')
```

Use `KreneHttp` with a fake `fetchImpl` for the session case. For the last test, read `src/mcp/server.ts` and `src/mcp/tools.ts` and assert neither source contains `playwright` or `loginWithBrowser`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run test/mcp-server.test.ts
```

Expected: FAIL because `src/mcp/server.ts` does not exist.

- [ ] **Step 3: Implement the tools**

`src/mcp/tools.ts`:

```ts
export async function kreneStatus(deps: KreneToolDeps) {
  const session = readSession(deps.config)
  if (!session) return { loggedIn: false, hint: 'run `krene-mcp login` on the host' }
  try {
    const info = await (deps.http ?? new KreneHttp({ config: deps.config, session })).memberInfo()
    return { loggedIn: true, user: info.userName ?? session.displayName ?? info.uuid, points: info.points }
  } catch (error) {
    if (error instanceof UserError && error.message.startsWith('AUTH_EXPIRED')) {
      return { loggedIn: false, hint: 'session expired; run `krene-mcp login` on the host' }
    }
    throw error
  }
}

export function kreneLogin(_deps: KreneToolDeps) {
  return {
    status: 'AUTH_REQUIRED' as const,
    message: 'Browser login only runs from the CLI: `krene-mcp login`. This tool never opens a browser.',
  }
}
```

`src/mcp/server.ts`:
- `Server({ name: 'krene-mcp', version: '0.1.0' }, { capabilities: { tools: {} } })`.
- `tools/list`: `krene_status` (no input), `krene_login` (no input).
- `tools/call`: dispatch to the two functions; text JSON; `isError: true` only for unexpected failures.
- No image/design tools.

- [ ] **Step 4: Wire `serve` in the CLI**

Replace the current stub:

```ts
case 'serve':
  await runServe(config)
  return
```

`runServe` connects the server to `StdioServerTransport` and exits on stdin end.

- [ ] **Step 5: Run the tests**

```bash
pnpm exec vitest run test/mcp-server.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools.ts src/cli.ts test/mcp-server.test.ts
git commit -m "feat: serve krene status over MCP"
```

---

### Task 3: Document the capture → sanitize → fixture workflow

**Files:**
- Create: `docs/CAPTURE.md`
- Modify: `README.md`
- Test: no new test; the existing sanitize tests are the gate.

**Interfaces:**
- Consumes: `capture`, `sanitize`, `login`.
- Produces: an owner-run workflow that yields `fixtures/*.jsonl` and `docs/protocol-notes.md`.

- [ ] **Step 1: Write `docs/CAPTURE.md`**

Cover:
- `krene-mcp login` opens the installed Chrome with a persistent profile; complete the captcha manually.
- `krene-mcp capture --out captures/<ts>` records raw HTTP + WebSocket frames; do one design conversation and one image generation.
- `krene-mcp capture` fails loudly when no WebSocket frames were recorded.
- `krene-mcp sanitize captures/<ts> fixtures/<name>` writes sanitized JSONL and a manifest; it refuses to write into the raw directory.
- Never commit `captures/`; only commit sanitized `fixtures/`.
- Playwright is optional; install it only for login/capture.

- [ ] **Step 2: Update the README**

Add:
- status and scope (login/capture only; image tools not implemented);
- the three commands and the raw-vs-sanitized rule;
- an MCP mount snippet for ds-agent:
  `{"name":"krene","command":"krene-mcp","args":["serve"]}`;
- the note that `krene_login` is a status tool, not a browser launcher.

- [ ] **Step 3: Run the existing sanitize tests**

```bash
pnpm exec vitest run test/capture-sanitize.test.ts test/capture-format.test.ts test/capture-verdict.test.ts
```

Expected: PASS; the sanitized fixture contains no `SECRET123`, phone number, or email.

- [ ] **Step 4: Commit**

```bash
git add docs/CAPTURE.md README.md
git commit -m "docs: document the capture and sanitize workflow"
```

---

### Task 4: Owner-run capture checkpoint (not automatable)

**Files:**
- No source changes.

**Interfaces:**
- Consumes: a real Krene account and a manual login.
- Produces: `fixtures/` and `docs/protocol-notes.md` for the later image-generation design.

- [ ] **Step 1: Run the interactive login**

```bash
krene-mcp login
```

Expected: the browser opens; complete the captcha; the CLI prints the logged-in user.

- [ ] **Step 2: Capture one design and one image generation**

```bash
krene-mcp capture --out captures/$(date +%Y%m%d-%H%M%S)
```

In the browser: one design conversation, one image generation. Close the window. Expected: the capture reports WebSocket frames.

- [ ] **Step 3: Sanitize into fixtures**

```bash
krene-mcp sanitize captures/<ts> fixtures/initial
```

Expected: `frames.jsonl`, `http.jsonl`, `manifest.json`; no secrets.

- [ ] **Step 4: Review and commit only the sanitized output**

```bash
git status
git add fixtures/initial docs/protocol-notes.md
git commit -m "test: add sanitized Krene capture fixtures"
```

Do not commit `captures/`.

- [ ] **Step 5: Stop**

Do not implement image generation in this plan. The next design update uses the fixtures to define the protocol, tools, and tests.

---

## Execution Notes

- Task 1 must be green before Task 2; the existing branch already covers the hard browser and capture work.
- Task 2 is the only code task. It must not import Playwright or call `loginWithBrowser`.
- Task 4 is an owner checkpoint. If the owner has not run it, the branch can merge Tasks 1–3 but must not claim image generation.
- The later image-generation work needs a new spec section or a new plan; do not improvise the private WebSocket protocol from memory.
