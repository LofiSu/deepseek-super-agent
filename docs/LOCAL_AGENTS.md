# Local specialist agents

DeepSeek Super Agent is a super agent in the literal sense: the Router
coordinates work, Workers execute it, and a Worker can hand a self-contained
task to a local specialist agent already installed on the machine. The
specialist is a normal CLI process (Claude Code, Codex, OpenCode, Hermes, or a
custom agent). ds-agent does not embed those agents or reimplement their
models.

Delegation is **opt-in and owner-configured**. The model never supplies a
command, argv, working directory, or environment. It can only name a
configured agent id and pass a task string.

## Configure

Create `local-agents.json` in the agent home (`$DS_AGENT_HOME`, by default
`~/.ds-agent`):

```json
{
  "agents": [
    {
      "id": "claude",
      "command": "claude",
      "args": ["-p", "{task}"],
      "description": "Claude Code for repository work",
      "timeoutMs": 300000,
      "env": ["ANTHROPIC_API_KEY"]
    },
    {
      "id": "codex",
      "command": "codex",
      "args": ["exec", "{task}"],
      "description": "OpenAI Codex",
      "timeoutMs": 300000,
      "env": ["OPENAI_API_KEY"]
    },
    {
      "id": "opencode",
      "command": "opencode",
      "args": ["run", "{task}"],
      "description": "OpenCode"
    }
  ]
}
```

A deployer can seed the same list with `DS_AGENT_LOCAL_AGENTS` (JSON). The file
wins over the environment seed. An empty or missing configuration disables
delegation; a malformed entry fails at startup instead of being ignored.

Check what is configured without starting a model:

```bash
pnpm ds-agent agents
pnpm ds-agent agents --json
```

### Fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lower-case id the model may name (`^[a-z][a-z0-9_-]{0,31}$`). |
| `command` | yes | Absolute path, `~/...`, or a bare executable name on `PATH`. Never a shell string. |
| `args` | no | Argv template. `{task}` and `{workspace}` are replaced as whole arguments. If no arg contains `{task}`, the task is appended. |
| `description` | no | One line shown by `list_local_agents`; helps the model choose. |
| `timeoutMs` | no | Per-run timeout, 50–600000 ms. Default 120000. |
| `maxOutputBytes` | no | Per-stream capture cap, 100–1000000 bytes. Default 200000. |
| `env` | no | Extra environment names copied from the parent, e.g. `ANTHROPIC_API_KEY`. |

At most 16 agents may be configured. Two runs may execute concurrently by
default; further calls fail with a clear "slots are busy" error rather than
queueing without bound.

## How a Worker uses it

The Worker sees two tools when at least one agent is configured:

- `list_local_agents` returns the configured ids and descriptions.
- `delegate_agent` takes `{ agent, task }`, runs the agent in the Worker's
  workspace, and returns `{ code, stdout, stderr, timedOut, truncated }`.

The Router can list agents but cannot delegate. Only a Worker with a ticket
can run one, so delegation stays inside the same audit trail as the rest of the
ticket's tools.

The task must be self-contained: the specialist does not see the Worker's
conversation, memory, or ticket. Put the relevant context, constraints, and
expected output in the task string.

The task is one literal argv entry (`{task}` substitution does not reinterpret
`$&` or other replacement patterns). A task whose first character is `-` is
refused, because the specialist CLI would parse model-authored text as its own
options; start such a payload with a word (for example `Task: - step one`).
Delegation is also refused once the ticket has ended and for speculative
tickets: a local specialist runs outside the Worker sandbox, so it cannot be
isolated or discarded.

## Security model

| Boundary | Behavior |
|---|---|
| Opt-in | No agent runs unless the owner configured it. |
| No shell | `spawn(command, argv)` with `shell: false`. A task containing `$(...)`, `;`, or backticks is one literal argument. |
| Workspace | `cwd` is the Worker's workspace (`workspaces/<sessionId>`). |
| Environment | The base allowlist (`PATH`, `HOME`, `LANG`, `TMPDIR`, …) plus names the owner explicitly listed. Unrelated secrets are not copied. |
| Limits | Timeout, output cap, and concurrency cap. A timeout kills the process group, not only the top process. |
| Redaction | Tool output passes through the same secret redactor as every other tool result. |
| Authority | A local agent is another tool, not a second owner. Outward-facing, destructive, or expensive actions still need the owner's explicit go-ahead; the Worker must verify what the specialist did before reporting it as done. |

The specialist's own permissions are part of the trust decision. If `claude` or
`codex` can write outside the workspace, or reach the network, that is the
specialist's policy, not ds-agent's sandbox. Configure the specialist's
approval mode deliberately. The OS sandbox that wraps Worker `bash` does not
wrap an arbitrary CLI agent.

## Not included

- Built-in browser, email, calendar, or payment connectors. Those remain
  channel/connector work, not delegation.
- Free-form agent-to-agent chat. A delegation is one bounded request/response.
- Remote agents. The command runs on the same machine as the Worker; the mesh
  and A2A transports are separate.
- Automatic installation or discovery of CLIs. The owner names the command.
