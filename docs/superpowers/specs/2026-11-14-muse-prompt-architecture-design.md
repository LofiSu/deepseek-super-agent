# Muse-style prompt architecture for ds-agent

- **Date:** 2026-11-14
- **Status:** proposed
- **Target branch:** `feat/muse-prompt-architecture` (branch off `main`)
- **Related:** `src/harness/prompts.ts`, `docs/PROMPTS.md`, `docs/MODULES.md` (M1)

## Intent

Replace ds-agent's twelve-layer prompt stack with the architecture used by the
leaked Muse agent workspace: **one composed system prompt in dependency order**
plus **a set of owner/agent-editable runtime files injected into it**. The
Router, Worker, and Watchdog contracts survive as the final `role` section.

The text is written for ds-agent's own runtime. It is **not** a verbatim copy
of the leaked Muse prompt, which is Meta-proprietary and mostly describes
product surfaces ds-agent does not have.

## Why this shape

The current stack is honest but compressed. Identity, discretion, evolution,
proactivity, environment, filesystem, and security all live inside a handful
of generic layers. The final text has no visible structure, so an owner cannot
tell which part to edit, and a reviewer cannot see whether a capability is
described or imagined.

Muse's design answers one question per section, names the runtime files that
carry owner/agent state, and keeps identity and values before task detail. That
is a better owner surface and a better review surface. The existing
`docs/PROMPTS.md` already claims this comparison; this change makes it true.

## Goals

1. One composed system prompt whose sections follow Muse's order (identity and
   values → owner → work style → personalization and memory → context → writing
   style → environment and tools → team/subagents → scheduled work → channels →
   runtime files → filesystem → security → safety → role).
2. A runtime file set: `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`,
   `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `PROACTIVE_PREFERENCES.md`.
3. Router / Worker / Watchdog contracts preserved as the last section, with the
   existing tested behavior (`reply_user`, `report_to_router`, no shell work,
   evidence rules) intact.
4. `ds-agent prompt`, `--layers`, and `--json` keep working and show every
   section, its length, and its source.
5. The stable prefix stays byte-identical across calls and free of clock,
   ticket id, principal, channel, and recall text.
6. Docs, READMEs, and competitive-gap table updated; tests rewritten to assert
   the new architecture.

## Non-goals

- No verbatim import of the 73 KB leaked Muse prompt or any Meta-specific
  product docs (`wallet`, `feed`, `spaces`, `Muse Spark`, `muse.*` tools).
- No new capabilities: no browser, wallet, payments, feed, spaces, device
  pairing, connector catalogue, or background self-improvement jobs.
- No behavioral wiring of `HEARTBEAT.md` into `RoutineScheduler`, and no
  behavioral wiring of `PROACTIVE_PREFERENCES.md` into the proactive engine.
  Both are injected context in this change.
- No per-principal tiers. ds-agent still has one owner; other senders remain
  input, not principals.
- No product-docs reference library in the agent home. `docs/` stays developer
  documentation; the prompt only references what the runtime actually has.

## Anti-goals

- A prompt that claims a tool, channel, or background job that does not exist.
- A system block that grows without a bound or changes between identical calls.
- A role contract that an owner file can override.
- A migration that silently drops an existing owner file.

## Constraints

- MIT repository. Leaked proprietary text must not be copied.
- Node.js 22+, pnpm. `pnpm typecheck`, `pnpm lint`, and `pnpm test` must pass
  offline before a PR is opened.
- One concern per PR; branch off current `main`.
- Prompt files are passed through the same redactor as the rest of the turn.
- Prompt files are read once at `Runtime.create`; restart applies edits.
- Owner input is capped; the role contract and safety sections are never
  truncated.

## Approaches considered

| | Approach | Why not |
|---|---|---|
| **A** | **Architecture replacement, original text (chosen).** Adopt Muse's file set, section order, and responsibilities; rewrite the prose for ds-agent. | Matches the request, avoids the IP problem, and keeps the runtime honest. |
| B | Verbatim port of the leaked prompt, renamed tools. | Meta-proprietary text in an MIT repo; most sections describe surfaces ds-agent does not have; tests and docs would be misleading. |
| C | Reorder the existing sections only, keep the three-file owner surface. | Smallest diff, but does not deliver Muse's runtime-file architecture or its editable surface. |

The owner chose A.

## Design

### 1. Runtime file set

Nine files in the agent home (`DS_AGENT_HOME`, default `./.ds-agent`). Each is
read at `Runtime.create`, capped, and injected as its own `<file>` block at a
fixed position in the system prompt.

| File | Section id | Written by | Purpose |
|---|---|---|---|
| `SOUL.md` | `soul` | owner | Persona, tone, warmth, register. Replaces `PERSONA.md`. |
| `IDENTITY.md` | `identity` | owner | Name, character, vibe, signature emoji. |
| `USER.md` | `user` | owner | Who the owner is, what to call them, timezone, context. |
| `INSTRUCTIONS.md` | `standing-instructions` | owner | Standing rules for everyday work. ds-agent extension; retains the current `instructions` capability. |
| `AGENTS.md` | `agents-manual` | owner | Workspace operating manual: conventions, tool quirks, lessons. |
| `MEMORY.md` | `memory` | owner | Curated durable memory: facts, preferences, commitments. |
| `TOOLS.md` | `tools-notes` | owner | Environment-specific tool notes: aliases, device nicknames, quirks. |
| `HEARTBEAT.md` | `heartbeat` | owner | Recurring checks the owner wants kept in view. |
| `PROACTIVE_PREFERENCES.md` | `proactive-preferences` | owner | What to surface, what never, when, and how. |

No runtime file has an agent write path. The Worker `write_file` and `bash`
tools are confined to the worker workspace (`LocalEnv` rejects parent, home,
and symlink escapes), and the Router has no write tool. The agent may propose
an edit in conversation, but the prompt must not claim it can write these
files. This change is injection-only; adding a home-file write surface is a
separate change with its own sandbox and approval design.

`MEMORY.md` is the curated layer, not a replacement for recall. Typed recall
entries still arrive per turn and remain the authoritative provenance path;
the prompt says so explicitly.

`HEARTBEAT.md` is a checklist, not a scheduler. `routines.json` remains the
only mechanism that fires work. The prompt says that plainly so the agent does
not promise a check nothing will run.

`PROACTIVE_PREFERENCES.md` guides composition of proactive messages. The
scheduler itself stays owner-configured.

### 2. Section order

The system block is assembled in this order. Built-in sections are original
prose. File-backed sections carry the matching file.

| # | Section id | Kind | Question it answers |
|---|---|---|---|
| 1 | `who-you-are` | built-in | Who am I, at the highest level? |
| 2 | `values` | built-in | What do I value when no rule covers the case? |
| 3 | `soul` | built-in default, else `SOUL.md` (or `PERSONA.md`) | How does my owner want me to sound? |
| 4 | `identity` | `IDENTITY.md` | What name, character, and vibe do I present? |
| 5 | `built-by` | built-in | Who built me, and what am I not? |
| 6 | `who-you-work-for` | built-in | Whose agent am I, and who is not my principal? |
| 7 | `user` | `USER.md` | Who is my owner? |
| 8 | `standing-instructions` | `INSTRUCTIONS.md` | What standing rules did my owner give me? |
| 9 | `discretion` | built-in | How do I handle private access and alignment? |
| 10 | `external-parties` | built-in | What may I say to people outside this conversation? |
| 11 | `how-you-work` | built-in | How resourceful, honest, and accountable am I? |
| 12 | `how-you-evolve` | built-in | How do I learn and improve? |
| 13 | `agents-manual` | `AGENTS.md` | What did we learn about working in this workspace? |
| 14 | `proactivity` | built-in | When do I surface something unasked? |
| 15 | `proactive-preferences` | `PROACTIVE_PREFERENCES.md` | What does my owner want to hear about? |
| 16 | `personalization` | built-in | How do I build understanding over time? |
| 17 | `memory` | `MEMORY.md` | What durable facts do I carry? |
| 18 | `contextual-awareness` | built-in | How do I handle time, dates, and location? |
| 19 | `conversation-context` | built-in | How do I manage recall, journals, and long threads? |
| 20 | `writing-style` | built-in | How do I write? |
| 21 | `environment` | built-in | What is my runtime: channels, workers, sandbox, workspace? |
| 22 | `tools` | built-in | How do I use tools truthfully and safely? |
| 23 | `tools-notes` | `TOOLS.md` | What is unique about this installation? |
| 24 | `team` | built-in + configured ids | Who can carry work? |
| 25 | `skills` | `skills/*/SKILL.md` index | What playbooks can I load? |
| 26 | `scheduled-work` | built-in | How does recurring work run? |
| 27 | `heartbeat` | `HEARTBEAT.md` | What recurring checks are on the owner's list? |
| 28 | `channels` | built-in | How do I behave on each channel? |
| 29 | `runtime-files` | built-in | Which files are mine, and how do I edit them? |
| 30 | `filesystem` | built-in | Where do durable files and workspaces live? |
| 31 | `security` | built-in | Secrets, sandbox, approvals, anti-phishing. |
| 32 | `safety` | built-in | What are my hard stops? |
| 33 | `role` | built-in | What is this session's specific contract? |

`soul` is always present: `DEFAULT_PERSONA` is the built-in default when no
file or seed exists, preserving today's behavior. `DEFAULT_PERSONA` stays
exported from `harness/index.ts`.

The `role` section is always last. `safety` is always immediately before it.
Owner files never appear after `safety`.

### 3. Composition rules

- **One renderer.** `describePromptSections(input)` returns
  `{ id, source, text }[]`; `buildSystemPrompt` joins their text with blank
  lines. The turn still sends one `system` message.
- **File sections.** Each file is wrapped as `<file id="soul">…</file>` inside
  a section with an intro that names the source and its authority. Headings
  inside the file are demoted one level (fenced code untouched). Every
  `<file …>` and `</file>` tag is stripped from file bodies, regardless of id,
  so a file cannot close its block and open another.
- **Subordination is explicit.** Every file-backed section says it cannot
  change `security`, `safety`, or `role`.
- **Owner budget.** Per-file cap 4,000 characters before rendering; total
  owner-file budget 20,000 characters of rendered section text (intro, `<file>`
  wrapper, and demoted body). Core file sections are rendered first and always
  fit: `soul`, `identity`, `user`, `standing-instructions` (4 × 4,000 = 16,000
  maximum). Optional file sections are then considered in priority order:
  `memory`, `agents-manual`, `tools-notes`, `heartbeat`,
  `proactive-preferences`. A section that does not fit the remaining budget is
  omitted whole, never truncated. Environment seeds count as file text.
  Built-in sections, `safety`, and `role` never count against this budget and
  are never truncated.
- **Stable prefix.** No clock, ticket id, principal, channel, recall text, or
  task text in the system block. The existing turn layers stay turn data:
  principal, channel, memory recall, now, task.
- **Determinism.** Two calls with the same input produce byte-identical text.
- **Redaction.** The assembled prompt goes through the existing redactor at the
  call site; prompt files never bypass it.

### 4. Loader and compatibility

`PROMPT_FILES` becomes:

```ts
const PROMPT_FILES = {
  soul: 'SOUL.md',
  identity: 'IDENTITY.md',
  user: 'USER.md',
  instructions: 'INSTRUCTIONS.md',
  agents: 'AGENTS.md',
  memory: 'MEMORY.md',
  tools: 'TOOLS.md',
  heartbeat: 'HEARTBEAT.md',
  proactivePreferences: 'PROACTIVE_PREFERENCES.md',
} as const
```

Loading rules:

1. A file wins over its environment seed. A blank file is treated as absent.
2. `PERSONA.md` is read as a fallback for `SOUL.md` when `SOUL.md` is absent.
   The fallback logs one line: `[prompt] PERSONA.md is deprecated; rename it to
   SOUL.md`. `DS_AGENT_PERSONA` remains a deprecated seed for `soul`.
3. `DS_AGENT_INSTRUCTIONS` now seeds `INSTRUCTIONS.md`.
   `DS_AGENT_OWNER` still seeds `USER.md`.
4. New seeds: `DS_AGENT_SOUL`, `DS_AGENT_IDENTITY`.
   `MEMORY.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, and
   `PROACTIVE_PREFERENCES.md` are file-only: they are workspace state, not
   deployer configuration.
5. A missing, blank, unreadable, or non-regular file is ignored rather than
   failing the runtime. No path traversal: names are fixed constants.
6. Files are loaded once at `Runtime.create`; restart applies edits.

**Programmatic API.** `PromptFiles` keeps the nine canonical keys and accepts
the legacy `persona`, `instructions`, and `owner` keys as deprecated aliases
mapped to `soul`, `standing-instructions`, and `user`. `loadPromptFiles`
returns the nine canonical keys. `RuntimeOptions.prompts` still bypasses file
reads, so the `PERSONA.md` fallback and the non-regular-file check do not apply
to it, but `Runtime.create` normalizes overrides through the same renderer and
applies the same per-file and total caps. A programmatic value is already a
string; the file-safety checks apply only to the loader.

`loadPrompts(home, env, warn)` returns `{ files, sources }`; `sources` carries
the `--layers` label for each file-backed value (`<home>/SOUL.md`,
`env:DS_AGENT_SOUL`, or the deprecated fallback). `loadPromptFiles` remains the
files-only entry point. `describePromptSections` accepts an optional `sources`
map so the CLI can report the origin without re-reading files.

### 5. Role contracts

The semantic content of the Router, Worker, and Watchdog contracts is
unchanged. They move into the final `role` section, rewritten only for
consistency with the new sections. The tested phrases stay:

- Router: `reply_user`, no shell work, one acknowledgement, direct-chat rules.
- Worker: `report_to_router`, evidence rules, approval hold, ticket scope.
- Watchdog: no user replies, no ticket work.

`team` still names configured local specialists by id and description only;
`skills` still lists id and one-line description only.

### 6. Turn layers

Unchanged and documented as turn data: `principal`, `channel`, memory recall,
`now`, `task` (`TASK`, `FOLLOWUP`, `REPORT`, `RESUME`, `WATCHDOG`). This keeps
the system prefix cacheable.

### 7. CLI

- `ds-agent prompt` prints the composed prompt for `--role`, after redaction.
- `ds-agent prompt --layers` prints one row per section: id, length, source.
  The flag name stays for compatibility; the output calls them sections.
- `ds-agent prompt --layers --json` keeps the current public shape: an array of
  `{ id, source, text }` objects, so existing scripts keep working.
- Source labels: `built-in`; `<home>/SOUL.md`; `env:DS_AGENT_SOUL`;
  `<home>/PERSONA.md (deprecated fallback)`; `local-agents.json` for the team
  section. A seed reports its env var, not a file path it did not read.
- The command redacts with the same secret list the runtime uses
  (`secretValues(process.env)` plus MCP server envs parsed from
  `DS_AGENT_MCP_SERVERS`), so a credential in a prompt file cannot be printed
  to a terminal or captured in `--json`.
- No new flag is required. `--sections` may be added as an alias if it costs
  one line; not required for this change.

### 8. Docs

- Rewrite `docs/PROMPTS.md` around the new file set and section table, the
  owner budget, the compatibility rules, and the turn layers.
- Update the M1 paragraph in `docs/MODULES.md`.
- Update the prompt bullet in `README.md` and `README.zh-CN.md`.
- Update the prompt, voice, memory, and proactivity rows in
  `docs/COMPETITIVE_GAP.md`.
- Update the `PERSONA.md` reference in `docs/SKILLS.md` to `SOUL.md` (with the
  fallback noted).
- Add a short prompt-files section to `docs/UPGRADE.md`: no database migration;
  rename `PERSONA.md` to `SOUL.md`; standing rules move to `INSTRUCTIONS.md`.

### 9. Tests

Rewrite `test/prompts.test.ts` to assert:

- the exact section id order, including `role` last and `safety` before it;
- each of the nine files is read and injected at its section;
- `PERSONA.md` fallback and the deprecation path;
- per-file cap and total owner budget;
- blank, missing, and unreadable files are ignored;
- file headings are demoted and fences untouched;
- wrapper tags cannot escape their block;
- byte-identical output across calls;
- no clock/ticket/recall text in the system block;
- role contracts keep their tested phrases.

Update `test/skills.test.ts` for the new section ids and ordering. Update
`test/router-prompt.test.ts` only if the role text is lightly edited; the
behavioral assertions must stay. Update `test/cli-prompt.test.ts` for the new
section ids, source labels, the unchanged `{ id, source, text }` JSON shape,
and redacted output.

### 10. Migration

No database migration. The change is prompt-only and file-based.

| Before | After | Behavior |
|---|---|---|
| `PERSONA.md` | `SOUL.md` | `PERSONA.md` still loads as a fallback; a deprecation line is logged. |
| `AGENTS.md` (owner standing rules) | Injected as `agents-manual`; standing rules move to `INSTRUCTIONS.md` | Existing text still reaches the prompt. The authority label changes; the file is still followed. |
| `DS_AGENT_PERSONA` | Seed for `soul` | Still works; deprecated. |
| `DS_AGENT_INSTRUCTIONS` | Seed for `INSTRUCTIONS.md` | Same value, new file. |
| `DS_AGENT_OWNER` | Seed for `USER.md` | Unchanged. |

No existing file is deleted or rewritten by the code.

## Calls I made for review

1. **`INSTRUCTIONS.md` is a deliberate ds-agent extension.** Muse has no
   separate standing-instructions file. Dropping the layer would silently lose
   a capability, and folding rules into `USER.md` would mix facts with
   authority. Keeping a named layer is clearer.
2. **`PERSONA.md` is a fallback, not a hard rename.** Existing installs keep
   working; the log line tells the owner what to rename.
3. **State files are file-only.** `MEMORY.md`, `AGENTS.md`, `TOOLS.md`,
   `HEARTBEAT.md`, and `PROACTIVE_PREFERENCES.md` do not get environment
   seeds; they are workspace state, not deployer config.
4. **Injection only for heartbeat and proactive preferences.** Wiring them to
   the scheduler or the engine is a separate change with its own tests.
5. **No product-docs library.** The prompt references only ds-agent's runtime
   and repository docs that exist.
6. **Caps: 4,000 per file, 20,000 total.** Keeps the system block bounded and
   leaves the role contract intact. The default prompt is well under this.
7. **Clean rename with a compatibility alias.** `PromptSection` is the type;
   `PromptLayer` and `describePromptLayers` remain as deprecated aliases so
   `harness/index.ts` consumers do not break in one release.
8. **Legacy `PromptFiles` keys are aliases, not removals.** `persona`,
   `instructions`, and `owner` map to the new keys. `loadPromptFiles` returns
   the nine canonical keys.
9. **The `soul` section always renders.** `DEFAULT_PERSONA` stays the default,
   so a fresh install keeps today's voice and the exact-order test is stable.
10. **No agent write path is claimed.** The table says the owner writes the
    files; the prompt says the agent may propose edits, not perform them.
11. **All `<file>` wrapper tags are stripped.** Stripping only the current id
    would leave the injection escape the design forbids.
12. **Budget rule is explicit.** Core sections always fit; optional sections
    are omitted whole in a fixed priority order; seeds count as file text.
13. **CLI JSON stays `{id, source, text}`.** `--layers` prints id/length/source;
    source labels distinguish file, env seed, and deprecated fallback.
14. **CLI output is redacted.** The inspection surface uses the runtime's
    secret list, not just the turn path.
15. **`loadPrompts` carries source labels.** `describePromptSections` accepts
    an optional `sources` map so the CLI can report whether a section came
    from a file, a seed, or the deprecated fallback without re-reading files.

## What is left to the builder

- Write the original prose for the built-in sections. Keep each section short,
  use plain language, and describe only what the runtime does.
- Choose the final section ids and helper signatures; keep the order above.
- Implement the loader, caps, fallback, and deprecation log.
- Rewrite the tests and docs; update the READMEs and the gap table.
- Keep the role contracts semantically identical.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm ds-agent prompt --layers
pnpm ds-agent prompt --role worker
pnpm ds-agent prompt --layers --json
```

Expected: all checks pass offline; every section has a source; `role` is last;
two `ds-agent prompt` runs are byte-identical.

## Risks

- **Prompt length.** The new block is larger than the old one. The owner budget
  and per-file caps bound it; the role contract is never truncated.
- **Test churn.** Section ids and order change, so prompt tests must be
  rewritten. Role behavior tests should not need semantic changes.
- **Documentation drift.** `docs/PROMPTS.md`, `docs/MODULES.md`, the READMEs,
  and `docs/COMPETITIVE_GAP.md` all describe the old stack; they must change in
  the same PR.
- **Misleading capability claims.** Every new section must be checked against
  the actual runtime; a section that promises a scheduler, browser, or memory
  write the code cannot perform is a defect.
