---
layout: default
title: Safety
lang: en
nav: safety
alt: /zh/safety/
description: "Where keys live, what the demo writes, and what the harness keeps out of tool text."
---

# Safety

This is a local harness. With a model key it calls a model. With `gh` or Feishu configured, the Router can post outward.

## Keys

Put API keys in the environment. Do not commit them. Do not paste them into an issue or a chat.

`pnpm demo` creates real GitHub issues and comments on `DS_AGENT_GH_REPO`. Point that at a repository you can write to before you run it. Unset, the repo is `LofiSu/deepseek-super-agent`.

The close is best-effort. It runs after each scenario's main work. A failed close is ignored, so the issue can stay open, and the demo does not fail for that. A throw or an early return before the close leaves issues open too. `DS_AGENT_GH_KEEP=1` skips the close. After a run, check the repo. Demo issues use the label `ds-agent-demo`.

## Tool text

The README marks this `[~]`. It is partial.

- The child shell gets an allowlist of environment names. Names that look like keys, tokens, or secrets are dropped even if listed.
- Redaction covers parent env values whose names look like a key, token, secret, password, or credential, and only when the value is at least 8 characters. Those are replaced with `[redacted]` in stdout, stderr, and file reads before they become tool results. A shorter value, or a secret under any other name, stays in the text and can reach the model. Vault values injected into a child are redacted only when they are at least 8 characters as well.
- `FileVault.describe()` returns names only. The vault file is mode `0600`.
- Every worker `bash` call is wrapped. On macOS the wrapper is `sandbox-exec`; on Linux it is `bwrap` (CI installs bubblewrap). If the wrapper is missing, the command fails with a hard error; there is no plain-bash fallback. `DS_AGENT_SANDBOX` no longer changes this.
- By default the wrapper confines writes to the workspace and denies network access unless the policy allows it, but it does **not** provide read confidentiality: macOS allows broad `file-read*` and Linux uses `--ro-bind / /`, so a worker can still read `<stateDir>/ds-agent.db`. `DS_AGENT_SANDBOX_READ_ISOLATION=1|true|strict` opts into strict read confinement (#117), which restricts reads to explicit roots; an invalid value fails closed. Without that opt-in, process-level read isolation remains an external/container boundary.
- **`ds-agent serve` worker bash:** the dedicated per-worker directory under `<stateDir>/workspaces/<workerId>` is a **writable git checkout** (when a worker workspace is empty, serve seeds it with `git clone --no-hardlinks` from `DS_AGENT_WORKSPACE_SOURCE_REPO` if set, otherwise from the serve process current working directory—not a shared worktree). `HOME`, `TMPDIR`, `XDG_CONFIG_HOME`, and `GH_CONFIG_DIR` are remapped into that workspace (a private `tmp/` subtree). **Network is off by default**; set `DS_AGENT_BASH_ALLOW_NETWORK=1` only when you need DNS or similar inside non-isolated bash (invalid values fail closed). Isolated/speculative shells always stay offline. Bash timeout is 5s in the default `LocalEnv` constructor; serve uses `DS_AGENT_BASH_TIMEOUT_MS` (10 minutes default, clamped 1s–30m). On Linux, well-known **host credential directories** (e.g. `~/.config/gh`, `~/.ssh`) are overlaid with `bwrap --tmpfs` after `--ro-bind / /`, so absolute paths to those secrets are not readable from the sandbox; the serve tree itself stays outside `writableRoots`. **Publishing** is not done via unconstrained `git`/`gh` in bash: workers use the host tool `publish_feature_pr` only (fixed repo from `DS_AGENT_GH_REPO`, branch prefix `peanut/`, PR to `main`, no merge/force/tags). Bash policy remains defense in depth for push/merge attempts.

Host vault policy and a host seccomp policy stay outside this repo.

## Who speaks

Only the Router writes to a channel. Workers report upward.

GitHub uses the `gh` login on the machine. Feishu uses the app id and secret you set. Channel details: [docs/REAL_CHANNELS.md]({{ site.repository_url }}/blob/main/docs/REAL_CHANNELS.md).
