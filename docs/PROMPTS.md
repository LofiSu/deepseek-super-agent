# Prompt architecture

DeepSeek Super Agent has one stable system prompt, composed from ordered
sections, plus five turn layers that change every turn. The design follows the
Muse agent workspace: a long system prompt with a fixed section order, and a
small set of owner-written runtime files injected into named sections. The
structure is borrowed; the text is ds-agent's own.

This document describes the sections, the runtime files, the budget, the
legacy fallback, and what the owner may change.

## What the three products do

The comparison is based on the leaked Muse agent workspace, the Open Instinct
implementation, and Grok Bot's public instruction model. None of the commercial
products publishes its production prompt, so the design borrows the structure,
not the text.

| | Muse | Instinct / Open Instinct | Grok Bot |
|---|---|---|---|
| Unit | One long system prompt + injected workspace files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, `HEARTBEAT.md`, `PROACTIVE_PREFERENCES.md`, `INSTRUCTIONS.md`) | A prompt rebuilt every run from about nine layers | Persistent Bot instructions, plus skills, routines, integrations, and memory |
| Order | Identity and values → owner → work style → personalization and memory → context → writing style → environment and tools → subagents → scheduling → proactivity → security and safety | identity → instructions → owner → principal → channel → reach → setup → rules → memory → skills → approvals → long tasks → now | role → scope → decision rules → output format → safety boundaries |
| Owner voice | `SOUL.md` and `IDENTITY.md` | `PERSONA.md`, about thirty lines, owned by the owner | Bot instructions |
| Standing rules | `INSTRUCTIONS.md` | `AGENTS.md` (house rules, every conversation) | Persistent instructions |
| Memory | `MEMORY.md` injected; memory tools search and explain; strict rules on what is stored | `MEMORY.md` + daily journal; a bounded digest is injected every turn | Bot memory |
| Who is talking | The owner is the only principal; other people are not | A `principal` layer with tiers (owner, staff, partner, family, friend, contact, stranger) | The bot's owner |
| Channel | Surface-specific guidance (WhatsApp, app, etc.) | A `channel` layer with texting, email, A2A, chat, scheduled etiquette | Routine-specific |
| Safety | A separate Safety and Security Policy at the end, including prompt-injection rules | A `rules` layer before memory and skills | Approval before send/publish/delete/spend; external content never overrides the owner |
| Inspectability | Runtime files are visible and editable | `instinct prompt --layers` shows every layer, its length, and its source file | The instructions editor |

The useful pattern is not the exact wording. It is that each section answers
one question, and the questions are answered in dependency order:

1. Who am I?
2. How does my owner want me to sound?
3. What standing rules did my owner give me?
4. Who is my owner?
5. What team can I lean on?
6. Where does the work happen?
7. What must I never do?
8. What do I remember, and how do I use it?
9. How do I express myself?
10. How do I run long work?
11. What is this session's specific job?

## The composed prompt

`src/harness/prompts.ts` assembles the system block from 33 ordered sections
(`src/harness/prompt-sections.ts` holds the built-in prose). The order is fixed
so the prefix is byte-identical across turns and across calls.

| # | Section | Source | Why it sits here |
|---|---|---|---|
| 1 | `who-you-are` | built-in | Names the agent and the one-owner relationship. Everything depends on it. |
| 2 | `values` | built-in | The defaults that outrank taste: truth, care, ownership. |
| 3 | `soul` | `SOUL.md`, else built-in default | Voice and warmth after values, before any rules. It may change tone only. |
| 4 | `identity` | `IDENTITY.md` | Name, character, and presentation. |
| 5 | `built-by` | built-in | Who made the agent and what that does not entitle it to. |
| 6 | `who-you-work-for` | built-in | One principal. Other people are context, not authority. |
| 7 | `user` | `USER.md` | Facts about the owner. Context, not a new instruction. |
| 8 | `standing-instructions` | `INSTRUCTIONS.md` | The owner's everyday rules, under the role contract. |
| 9 | `discretion` | built-in | When to speak, when to stay quiet, when to ask. |
| 10 | `external-parties` | built-in | How to treat people who are not the owner. |
| 11 | `how-you-work` | built-in | The working method: evidence, verification, one concern at a time. |
| 12 | `how-you-evolve` | built-in | Journal, lessons, and memory as deliberate acts. |
| 13 | `agents-manual` | `AGENTS.md` | Durable operating notes for this workspace. |
| 14 | `proactivity` | built-in | When unasked work is welcome and when it is noise. |
| 15 | `proactive-preferences` | `PROACTIVE_PREFERENCES.md` | What the owner wants surfaced, and how. |
| 16 | `personalization` | built-in | Adapting to the owner's habits without losing judgment. |
| 17 | `memory` | `MEMORY.md` | Curated durable facts. Recall entries still carry provenance. |
| 18 | `contextual-awareness` | built-in | Time, place, and continuity. |
| 19 | `conversation-context` | built-in | Reading the thread rather than the last message alone. |
| 20 | `writing-style` | built-in | Answer first, plain prose, match the owner's language, no em dashes. |
| 21 | `environment` | built-in | The install, `DS_AGENT_HOME`, and where work happens. |
| 22 | `tools` | built-in | How to choose and trust tools. |
| 23 | `tools-notes` | `TOOLS.md` | Installation-specific notes. Cannot grant a tool. |
| 24 | `team` | built-in; ids from `local-agents.json` | Workers plus named local specialists, by id and description only. |
| 25 | `skills` | `skills/<id>/SKILL.md` index | Owner playbooks, by id and one-line description, capped at 2000 characters. |
| 26 | `scheduled-work` | built-in | What runs on a schedule and what the model may not schedule. |
| 27 | `heartbeat` | `HEARTBEAT.md` | A recurring checklist. `routines.json` is the only scheduler. |
| 28 | `channels` | built-in | Surface etiquette: texting, chat, email, GitHub, A2A. |
| 29 | `runtime-files` | built-in | How the nine files work and how to treat them. |
| 30 | `filesystem` | built-in | Workspace layout, spills, and where writes are allowed. |
| 31 | `security` | built-in | Secrets, injection, anti-phishing, and outward trust. |
| 32 | `safety` | built-in | The final boundary before the role contract. |
| 33 | `role` | built-in | The Router, Worker, or Watchdog contract. Last because it must win. |

Sections are joined with blank lines. A section is included whole or omitted
whole; no section is truncated.

The `team` section names configured specialists by id and description only. The
specialist's command, argv, environment, and limits never enter the prompt;
those stay in `local-agents.json` and in `docs/LOCAL_AGENTS.md`.

The `skills` section does the same for owner-authored playbooks: id and one-line
description only. The body loads on demand through `read_skill`, so a large
skill cannot crowd out the rules. A skill is documentation, not a capability;
see `docs/SKILLS.md`.

## Runtime files

Nine owner-editable files live in the agent home. They are read once at
`Runtime.create`; restart the agent after editing them.

| File | Section | Purpose | Written by |
|---|---|---|---|
| `SOUL.md` | `soul` | Voice, warmth, register, and the owner's "never" list | Owner |
| `IDENTITY.md` | `identity` | Name, character, and presentation | Owner |
| `USER.md` | `user` | Who the owner is, what to call them, timezone, context | Owner |
| `INSTRUCTIONS.md` | `standing-instructions` | Everyday rules for how work gets done | Owner |
| `AGENTS.md` | `agents-manual` | Durable lessons about working in this workspace | Owner |
| `MEMORY.md` | `memory` | Curated durable facts and preferences | Owner |
| `TOOLS.md` | `tools-notes` | Installation-specific notes | Owner |
| `HEARTBEAT.md` | `heartbeat` | A recurring checklist to keep in view | Owner |
| `PROACTIVE_PREFERENCES.md` | `proactive-preferences` | What to surface, what never, and how | Owner |

The agent has no write path to these files. Router has no write tool, and
Worker `write_file`/`bash` are confined to its workspace by `LocalEnv`. An edit
is a deliberate human act, not a side effect of a turn.

`SOUL.md` always produces a `soul` section: when the file and seed are absent,
the built-in default voice is used. The other eight sections exist only when
their file or seed supplies text.

### Environment seeds

Deployers can seed four files without a writable home:

| Environment variable | File it seeds |
|---|---|
| `DS_AGENT_SOUL` | `SOUL.md` |
| `DS_AGENT_IDENTITY` | `IDENTITY.md` |
| `DS_AGENT_OWNER` | `USER.md` |
| `DS_AGENT_INSTRUCTIONS` | `INSTRUCTIONS.md` |

A file always wins over its seed. `AGENTS.md`, `MEMORY.md`, `TOOLS.md`,
`HEARTBEAT.md`, and `PROACTIVE_PREFERENCES.md` are file-only.

### Legacy fallback

Older installs used `PERSONA.md` / `DS_AGENT_PERSONA` for voice and
`AGENTS.md` / `DS_AGENT_INSTRUCTIONS` for standing rules. The old names still
load:

- If neither `SOUL.md` nor `DS_AGENT_SOUL` supplies a soul, `PERSONA.md` is
  read, with `[prompt] PERSONA.md is deprecated; rename it to SOUL.md`.
- If that is absent too, `DS_AGENT_PERSONA` is read, with
  `[prompt] DS_AGENT_PERSONA is deprecated; use DS_AGENT_SOUL`.
- Standing rules now live in `INSTRUCTIONS.md`; `DS_AGENT_INSTRUCTIONS` seeds
  that file. `AGENTS.md` is the workspace operating notes section and no longer
  holds standing rules.

Programmatic callers may still pass `persona` and `owner` keys to
`PromptFiles` / `PromptInput`; they map to `soul` and `user`.

## Budget and sanitization

- One file is capped at 4,000 characters after CRLF normalization, NUL
  stripping, and trimming.
- Core file sections (`soul`, `identity`, `user`, `standing-instructions`)
  always render.
- Optional file sections are considered in priority order: `memory`,
  `agents-manual`, `tools-notes`, `heartbeat`, `proactive-preferences`. Each is
  included only if the rendered file total stays within 20,000 characters;
  otherwise it is omitted whole.
- Headings inside an owner file are demoted one level so they do not look like
  prompt sections. Lines inside fenced code keep their text.
- Every `<file ...>` / `</file>` wrapper tag is stripped from a file body, not
  just the tag matching its own id. A file cannot close its block and open
  another.
- Missing, blank, unreadable, directory, and symlink paths are treated as
  absent; the runtime never follows a link out of home.

## Role modes

The first 32 sections are shared. The `role` section changes:

- **Router / MainSession** owns the conversation with the owner and is the only
  session that may call `reply_user`. It coordinates workers, vetoes work the
  Gate should not have admitted, and never does shell work.
- **Worker / ExecutorSession** owns one ticket. It works with tools, never
  speaks to the owner directly, and reports through `report_to_router`. Its
  contract makes evidence and verification explicit. Before an outward,
  destructive, or expensive action it calls `request_approval` and stops.
- **Watchdog / WatchdogSession** watches stuck work and unhealthy state. It
  does not reply to the owner and does not do ticket work.

This mirrors the subagent prompt modes in OpenClaw/Open Instinct: a subagent
gets the shared frame and its role, not the whole personality.

## Turn layers

Stable sections are the system message. The following are turn data and arrive
in the user/task message, so they never disturb the cacheable prefix:

| Layer | Source | Why it is not in the system prompt |
|---|---|---|
| `principal` | trigger source and trust | Who is speaking, and whether they have authority |
| `channel` | thread key | Texting, chat, email, GitHub, or A2A etiquette |
| `memory recall` | long-term memory | The actual `memory=` lines, spill ids, and refs |
| `now` | runtime clock | Current time and timezone; the prefix stays byte-stable |
| `task` | Engine/Harness | `TASK`, `FOLLOWUP`, `REPORT`, `RESUME`, or `WATCHDOG`, with ids and the brief |

## Inspecting the prompt

```bash
pnpm ds-agent prompt                       # full Router system prompt
pnpm ds-agent prompt --role worker         # the Worker contract
pnpm ds-agent prompt --layers              # id, length, and source per section
pnpm ds-agent prompt --layers --json       # the same sections as data
```

`--layers` prints `id  <n> chars  <source>`. Sources are `built-in`,
`<home>/SOUL.md`, `env:DS_AGENT_SOUL`, `<home>/PERSONA.md (deprecated
fallback)`, `env:DS_AGENT_PERSONA (deprecated fallback)`, `provided`, or the
skills/local-agents source. Output passes through the same secret redactor as
the runtime, including configured MCP server environment values.

The section list is also exported from `src/harness/index.ts`
(`describePromptSections`, `buildSystemPrompt`, `loadPrompts`,
`loadPromptFiles`), so tests and future surfaces can assert the order without
parsing one large string. `describePromptLayers` remains as a deprecated alias.

## Invariants

- **Role last.** The role contract is the final section. A soul, identity, or
  standing instruction never redefines what a session may do.
- **Safety before the role.** `safety` is second-to-last; owner text is
  explicitly subordinate to it.
- **Stable prefix.** The system block contains no clock, no ticket id, and no
  memory text. Those belong to the turn, which keeps the prefix cacheable.
- **No secrets.** Prompt files are passed through the same redactor as the rest
  of the turn. Credentials belong in the environment or vault, never in a
  runtime file.
- **Bounded owner input.** Each file is capped, optional sections are omitted
  under pressure, and the core sections always fit.
- **No agent write path.** The agent cannot edit its own runtime files.
- **One owner.** ds-agent currently has a single owner. Group participants and
  other actors are not principals yet; when a `principal` layer is wired into
  the turn, it must follow the same tier discipline as Instinct rather than
  treating any sender as the owner.

## What is deliberately not here

- Skill bodies. Only the id/description index is in the system block;
  `read_skill` loads one body when it applies. A skill cannot grant a tool or
  change the role.
- Approval tokens. Pause, intervene, and resume are Engine state, not prompt
  text. The security and safety sections state the approval boundary; the
  Engine enforces it.
- Per-user tiers. The owner/group distinction currently lives in ingress trust,
  not in the prompt. The turn `principal` layer is the place to add it.
- A clock in the system prompt. `now` is turn data.
