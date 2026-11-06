# Skills

A skill is an owner-authored playbook: a short Markdown file that tells the
agent how to do a recurring job. The agent sees a one-line index of every
skill and loads the full body only when the task matches.

A skill is documentation, not a capability. It cannot add a tool, change a
role, widen an allowlist, or authorize an outward action. The rules layer and
the role contract still win where they conflict.

## Layout

```
<agent home>/
  skills/
    deploy-check/
      SKILL.md
    pr-review/
      SKILL.md
```

The directory name is the skill id and must match
`^[a-z0-9][a-z0-9-]{0,63}$`. Only `SKILL.md` is read, and it must be a regular
file: a symlink is ignored, so a skill cannot become an arbitrary-file read.

## Format

```markdown
---
name: Deploy check
description: Check whether production is healthy after a deploy; report only failures.
---

# Deploy check

1. Run `pnpm smoke --env production`.
2. Compare the result with the last green run.
3. If anything is red, report the failing check, the error line, and the
   commit that introduced it. If everything is green, reply "green" only.
```

- `description` is required. It must be one line of at most 200 characters and
  is the only text that enters the system prompt.
- `name` and other frontmatter keys are accepted and ignored.
- The body is read with `read_skill` and capped at 16,000 characters; a longer
  body is truncated and marked `truncated`.
- Files larger than 256 KB are skipped before reading.
- Up to 64 skills are loaded, in id order. The prompt index has a 2,000
  character budget; skills that do not fit stay available on disk but are not
  advertised.

Skills are loaded once at `Runtime.create`. Restart the agent after editing a
skill, the same as `PERSONA.md`.

## How the agent uses one

1. The `skills` layer lists `id: description` pairs.
2. On a matching task, the agent calls `read_skill` with the id.
3. It follows the body inside the current role, rules, and sandbox.

`read_skill` is available to Router and Worker sessions. The Watchdog cannot
load skills because it does not do ticket work. Delegate tasks handed to a
local specialist are composed by the Worker, so the Worker can read the skill
first and include the relevant steps.

## CLI

```bash
ds-agent skills           # id and description, one per line
ds-agent skills --json    # [{ "id": ..., "description": ... }]
ds-agent prompt --layers  # confirm the skills layer and its source
```

An invalid skill is skipped with a `[skill]` warning on stderr; one bad file
does not stop the agent or hide the other skills.

## Why the index is separate from the body

Injecting every full skill would spend the context window on playbooks that do
not apply. Keeping only the index in the stable system block has three
effects:

- the cacheable prefix stays small and byte-stable;
- a large skills directory cannot crowd out the rules or the role contract;
- the agent must make an explicit choice to load a body, which is visible in
  the session journal as a tool call.

## Relationship to local specialist agents

Use a skill when the procedure should live in the agent's own instructions and
tools. Use `delegate_agent` when a separate CLI agent should do the work in its
own environment. A skill can describe when to delegate, but it cannot grant a
delegation the Worker does not already have.
