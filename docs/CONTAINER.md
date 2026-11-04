# Container profile for workers

This document gives a **host-side** container profile for running ds-agent or
its worker execution with a default-deny read surface. It is not a second
sandbox implementation inside the product.

There are two layers, and they do different jobs:

| Layer | Owned by | What it confines | What it does not do |
|---|---|---|---|
| Container runtime / host policy (this document) | Operator | Host filesystem, network namespace, capabilities, devices, process count, memory | Cannot see the model's intent or per-command arguments. |
| `LocalEnv` worker sandbox (`src/env/seccomp.ts`) | This repository | Every worker `bash` call: writes to the worker workspace, network unless the policy allows it, and reads when strict mode is on | Does not isolate the Node process, the SQLite database, or credentials from the agent itself. |

Both are required for the strongest available profile. Neither replaces the
other. Host vault policy, Kubernetes admission policy, SELinux/AppArmor
profiles, and egress firewalls also remain outside this repository.

## What the repository's sandbox does

Every worker `bash` call is wrapped:

- macOS: `sandbox-exec` with a profile that permits writes only under the
  worker workspace and `/tmp`, and denies network unless `allowNetwork` is
  set.
- Linux: `bubblewrap` (`bwrap`). The compatibility profile uses
  `--ro-bind / /`; `DS_AGENT_SANDBOX_READ_ISOLATION=strict` binds only system
  roots, `/dev`, `/proc`, `/tmp`, and the worker workspace.
- If the wrapper is missing, the call fails. There is no unsandboxed fallback.

`DS_AGENT_SANDBOX_READ_ISOLATION=strict` is opt-in. It refuses `/` and an
entire home directory as read roots. In strict mode a worker cannot read
`<stateDir>/ds-agent.db`; in the default compatibility mode it can, because
both platforms still allow broad reads. That is exactly the gap this
container profile closes at the host boundary.

`LocalEnv` also passes an allowlisted environment to the child and redacts
secret-named values of at least 8 characters from output. That is data-loss
prevention, not a process boundary.

## Reference worker container

Build a non-root image. This is a sketch, not a Dockerfile maintained by the
repository:

```dockerfile
FROM node:22-bookworm-slim

# bubblewrap is required for worker bash on Linux.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin worker

WORKDIR /app
COPY --chown=worker:worker package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false
COPY --chown=worker:worker dist ./dist

USER 10001:10001
ENV DS_AGENT_HOME=/state
ENTRYPOINT ["node", "dist/cli/main.js"]
```

Run the agent with a read-only root filesystem and no network:

```bash
docker volume create ds-agent-state

docker run --rm -it \
  --name ds-agent-worker \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --network none \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --memory=1g \
  --mount type=volume,src=ds-agent-state,dst=/state \
  -e DS_AGENT_HOME=/state \
  -e DS_AGENT_SANDBOX_READ_ISOLATION=strict \
  ds-agent:local tasks
```

Properties:

- **Non-root.** `--user 10001:10001`; the image declares the same numeric UID.
- **Read-only root.** Only `/tmp` (tmpfs) and `/state` (writable volume) are
  written. The application code in `/app` cannot be modified at runtime.
- **No network by default.** `--network none` removes interfaces other than
  loopback. A profile that must call a model API needs an explicit host
  network/egress policy; do not add it to a pure worker executor.
- **No capabilities and no privilege escalation.** `--cap-drop=ALL` plus
  `no-new-privileges`. Do not use `--privileged` to make bubblewrap work.
- **Bounded resources.** PID and memory limits cap a runaway command.

The state volume is writable because the agent writes SQLite, logs, and
worker workspaces there. Worker `bash` sees only its workspace when strict
read isolation is on. If the container is dedicated to remote worker
execution and does not need store state at all, omit the `/state` mount
entirely.

## Model/network note

A single all-in-one container with `--network none` cannot reach a hosted
model endpoint. Use one of these:

1. A control-plane process with a deliberately restricted egress policy
   (host firewall or Kubernetes NetworkPolicy) and no inbound listener beyond
   loopback, plus a separate worker executor container with `--network none`.
2. A local model endpoint reachable over a host bridge or Unix socket, still
   with the agent process non-root and the root filesystem read-only.

Do not open inbound ports to compensate. Network listeners in this project
bind loopback by default and require explicit opt-in to expose remotely.

## Verify the profile

Worker bash must find and be allowed to use bubblewrap:

```bash
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --user 10001:10001 ds-agent:local \
  bwrap --ro-bind / / --unshare-net -- /bin/true
```

If that probe fails, the container policy blocks unprivileged user
namespaces. Worker `bash` will fail closed with a clear error; that is the
intended behavior. Fix the host policy or run the worker executor on a host
that permits `bwrap`, rather than disabling the per-command sandbox.

Useful checks from the host:

```bash
docker inspect ds-agent-worker --format '{{.HostConfig.ReadonlyRootfs}}'
docker inspect ds-agent-worker --format '{{.HostConfig.NetworkMode}}'
docker inspect ds-agent-worker --format '{{.Config.User}}'
```

Expected: `true`, `none`, and `10001:10001`.

## What this profile does not protect

- The agent process itself is trusted with the state volume. A worker command
  is not the agent, but the model-driven Node process still reads and writes
  the database.
- Credentials mounted into the container are visible to that process. Keep
  vault and provider keys out of images and out of worker environments.
- A writable state volume contains prompts, messages, replies, and spill
  bodies. Back it up with the WAL-safe procedure in
  [UPGRADE.md](./UPGRADE.md), and treat the backup as sensitive data.
- Without `DS_AGENT_SANDBOX_READ_ISOLATION=strict`, the in-process worker
  sandbox still permits broad reads inside the container, including the state
  volume.
