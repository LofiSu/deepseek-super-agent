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
- `DS_AGENT_SANDBOX=1` wraps bash with `sandbox-exec` on macOS. On Linux it uses `bwrap` or `unshare` for a network namespace. If those tools are missing, bash runs without the wrapper.

Host vault policy and a host seccomp policy stay outside this repo. Treat `DS_AGENT_SANDBOX=1` as that light wrapper.

## Who speaks

Only the Router writes to a channel. Workers report upward.

GitHub uses the `gh` login on the machine. Feishu uses the app id and secret you set. Channel details: [docs/REAL_CHANNELS.md]({{ site.repository_url }}/blob/main/docs/REAL_CHANNELS.md).
