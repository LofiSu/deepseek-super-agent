# Prompt stack

DeepSeek Super Agent does not have one system prompt. It has a small stack of
layers, assembled in dependency order, with one stable system block and one
turn block. The design follows the prompt stacks used by Muse, Instinct, and
Grok Bot: identity and relationship before task detail, owner voice before
role contract, safety before capability, and runtime facts after the stable
prefix.

This document describes the stack, why the layers are ordered this way, and
which parts the owner can edit.

## What the three products do

The comparison is based on the leaked Muse agent workspace, the Open Instinct
implementation, and Grok Bot's public instruction model. None of the commercial
products publishes its production prompt, so the design borrows the structure,
not the text.

| | Muse | Instinct / Open Instinct | Grok Bot |
|---|---|---|---|
| Unit | One long system prompt + injected workspace files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, `HEARTBEAT.md`) | A prompt rebuilt every run from about nine layers | Persistent Bot instructions, plus skills, routines, integrations, and memory |
| Order | Identity and values → owner → work style → personalization and memory → context → writing style → environment and tools → subagents → scheduling → proactivity → safety and security | identity → instructions → owner → principal → channel → reach → setup → rules → memory → skills → approvals → long tasks → now | role → scope → decision rules → output format → safety boundaries |
| Owner voice | `SOUL.md` and `IDENTITY.md`, written by the agent and the owner | `PERSONA.md`, about thirty lines, owned by the owner | Bot instructions |
| Standing rules | `AGENTS.md` (operating lessons) | `AGENTS.md` (house rules, every conversation) | Persistent instructions |
| Memory | `MEMORY.md` injected; memory tools search and explain; strict rules on what is stored | `MEMORY.md` + daily journal; a bounded digest is injected every turn | Bot memory |
| Who is talking | The owner is the only principal; other people are not | A `principal` layer with tiers (owner, staff, partner, family, friend, contact, stranger) | The bot's owner |
| Channel | Surface-specific guidance (WhatsApp, app, etc.) | A `channel` layer with texting, email, A2A, chat, scheduled etiquette | Routine-specific |
| Safety | A separate Safety and Security Policy at the end, including prompt-injection rules | A `rules` layer before memory and skills | Approval before send/publish/delete/spend; external content never overrides the owner |
| Inspectability | Runtime files are visible and editable | `instinct prompt --layers` shows every layer, its length, and its source file | The instructions editor |

The useful pattern is not the exact wording. It is that each layer answers one
question, and the questions are answered in dependency order:

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

## The ds-agent stack

The stable layers are assembled by `src/harness/prompts.ts` and sent as the
system message. The turn layers are already part of the Router, Worker, and
Watchdog task prompts, or arrive through them.

| # | Layer | Scope | Source | Why it sits here |
|---|---|---|---|---|
| 1 | `identity` | system | built-in | Defines the agent and the single-owner relationship. Everything else depends on it. |
| 2 | `persona` | system | `PERSONA.md`, else built-in default | Refines the voice after identity, before any rules. It may change tone only. |
| 3 | `instructions` | system | `AGENTS.md` | The owner's standing rules, applied to every conversation. |
| 4 | `owner` | system | `USER.md` | Facts about the owner. Context, not authority. |
| 5 | `team` | system | built-in; configured agent ids from `local-agents.json` | Who can carry work: Workers, plus named local specialists. It depends on the owner and on what is installed. |
| 6 | `reach` | system | built-in | Where replies go and what the owner can be sent to. Depends on the owner and the runtime. |
| 7 | `rules` | system | built-in | Safety, discretion, approval boundaries, and prompt-injection resistance. |
| 8 | `memory` | system | built-in guidance; recall data in the turn | Teaches how to use memory before the recall entries appear. |
| 9 | `style` | system | built-in | Expression rules and examples: answer first, plain prose, match language, no filler. |
| 10 | `long-tasks` | system | built-in | The protocol for work that takes time: one acknowledgement when allowed, one report. |
| 11 | `role` | system | built-in | The specific contract for Router, Worker, or Watchdog. Last because it is the most specific and must win. |
| 12 | `principal` | turn | trigger source and trust | Who is speaking, and whether they have authority. Not part of the cacheable prefix. |
| 13 | `channel` | turn | Thread key | Texting, chat, email, GitHub, or A2A etiquette. |
| 14 | `memory recall` | turn | long-term memory | The actual `memory=` lines, spill ids, and refs. |
| 15 | `now` | turn | runtime clock | Current time and timezone. Keeping it out of the system block keeps that block byte-stable. |
| 16 | `task` | turn | Engine/Harness | `TASK`, `FOLLOWUP`, `REPORT`, `RESUME`, or `WATCHDOG`, with ids and the brief. |

Layers 1-11 are joined with blank lines in the order shown. Layers 12-16 are
turn data and are deliberately not part of the system prefix.

The `team` layer names configured specialists by id and description only. The
specialist's command, argv, environment, and limits never enter the prompt;
those stay in `local-agents.json` and in `docs/LOCAL_AGENTS.md`.

## Role modes

The identity, persona, instructions, owner, reach, rules, memory, style, and
long-task layers are shared. The role layer changes:

- **Router / MainSession** owns the conversation with the owner and is the only
  session that may call `reply_user`. It coordinates workers, vetoes work the
  Gate should not have admitted, and never does shell work.
- **Worker / ExecutorSession** owns one ticket. It works with tools, never
  speaks to the owner directly, and reports through `report_to_router`. Its
  contract makes evidence and verification explicit.
- **Watchdog / WatchdogSession** watches stuck work and unhealthy state. It
  does not reply to the owner and does not do ticket work.

This mirrors the subagent prompt modes in OpenClaw/Open Instinct: a subagent
gets the shared frame and its role, not the whole personality.

## Owner customization

Three files in the agent home are read at `Runtime.create`:

| File | Layer | Purpose |
|---|---|---|
| `PERSONA.md` | `persona` | Voice, warmth, register, and the owner's "never" list |
| `AGENTS.md` | `instructions` | Standing house rules that apply to every conversation |
| `USER.md` | `owner` | Who the owner is, what to call them, timezone, and context |

Each file is capped at 4000 characters. A missing or blank file is omitted
rather than failing the run. Headings inside an owner file are demoted one
level so they do not look like new stack sections, and wrapper tags are
stripped.

Deployers can seed the same layers without writing files:

| Environment variable | File it seeds |
|---|---|
| `DS_AGENT_PERSONA` | `PERSONA.md` |
| `DS_AGENT_INSTRUCTIONS` | `AGENTS.md` |
| `DS_AGENT_OWNER` | `USER.md` |

A file always wins over its environment seed. Files and seeds are loaded once
when the Runtime is created; restart the agent after editing them.

The persona and standing-instruction layers say explicitly that they cannot
change the role contract, the rules, or the safety boundaries. Only tone and
everyday behavior are owner-editable.

## Inspecting the stack

```bash
pnpm ds-agent prompt                       # full Router system prompt
pnpm ds-agent prompt --role worker         # the Worker contract
pnpm ds-agent prompt --layers              # one row per layer: id, length, source
pnpm ds-agent prompt --layers --json       # the same stack as data
```

The layer list is also exported from `src/harness/index.ts`
(`describePromptLayers`, `buildSystemPrompt`, `loadPromptFiles`), so tests and
future surfaces can assert the order without parsing one large string.

## Invariants

- **Role last.** The role contract is the final system layer. A persona or
  standing instruction never redefines what a session may do.
- **Safety before capability.** The rules layer precedes style, memory, and
  role detail. Owner text is explicitly subordinate to it.
- **Stable prefix.** The system block contains no clock, no ticket id, and no
  memory text. Those belong to the turn, which keeps the prefix cacheable.
- **No secrets.** Prompt files are passed through the same redactor as the rest
  of the turn. Credentials belong in the environment or vault, never in
  `PERSONA.md`, `AGENTS.md`, or `USER.md`.
- **Bounded owner input.** Each file is capped; a long persona cannot crowd out
  the role contract or the rules.
- **One owner.** ds-agent currently has a single owner. Group participants and
  other actors are not principals yet; when a `principal` layer is wired into
  the turn, it must follow the same tier discipline as Instinct rather than
  treating any sender as the owner.

## What is deliberately not here

- A skills index. ds-agent's tools are described by their tool specs; a skill
  loader can become a later layer without changing this order.
- Approval tokens. Pause, intervene, and resume are Engine state, not prompt
  text. The rules layer states the approval boundary; the Engine enforces it.
- Per-user tiers. The owner/group distinction currently lives in ingress trust,
  not in the prompt. The turn `principal` layer is the place to add it.
- A clock in the system prompt. `now` is turn data.
