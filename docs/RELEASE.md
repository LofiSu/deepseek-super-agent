# Release process

ds-agent releases are **source/tarball releases from GitHub**. There is no
npm registry publish step, no registry token, and no secret in the release
workflow. A release is a reviewed version bump, a green offline check, a
tarball built from the tagged commit, and a GitHub release attached to that
tarball.

`.github/workflows/release.yml` is on `main` (PR #132, merge `a1985c0`). That
PR was owner-gated and merged by another session without recorded owner
approval; the merge is recorded as a process deviation in
`docs/DEVELOPMENT_STATUS.md` and `docs/AGENT_LOG.md`. The workflow itself is
`workflow_dispatch` only: it has no tag trigger, does not publish anything, has
`permissions: contents: read`, and contains no secrets. It checks a selected
ref and uploads the tarball as a workflow artifact. Publishing remains a
deliberate human step.

## 1. Prepare the version

1. Choose semver for the change set:
   - patch for fixes and documentation;
   - minor for backwards-compatible features;
   - major for a breaking CLI, configuration, or on-disk contract.
2. Bump `version` in `package.json`. Do not change the package name, license,
   or author.
3. The current offline suite pins the checked-in version in
   `test/packaging.test.ts` (`expect(pkg.version).toBe('0.1.0')`). Update that
   assertion in the same release PR; otherwise `pnpm test` fails on the new
   version. The release workflow runs the tests, so this is intentional
   evidence that the bump was reviewed.
4. Schema versions are independent of package versions. Do not bump
   `LATEST_SCHEMA_VERSION` for a release-only change. If a migration ships,
   update [UPGRADE.md](./UPGRADE.md) and the compatibility table.
5. `prepack` runs `pnpm build`, so the tarball can never be packed from an
   unbuilt tree by accident. The release check still verifies the built tree
   explicitly.

## 2. CHANGELOG expectations

The repository does not currently ship a `CHANGELOG.md`. A release PR should
add one (or update it) in [Keep a Changelog](https://keepachangelog.com/)
style:

```markdown
# Changelog

## [Unreleased]

## [0.2.0] - 2026-11-20

### Added
- ...

### Changed
- ...

### Fixed
- ...

### Migration
- State schema: 3 -> 3 (no migration) or describe the new version.
- Breaking: list CLI, config, or API removals, or write "none".
```

Include security fixes and any fail-closed behavior change. If the changelog
should ship in the tarball, add it to `package.json` `files` and update
`test/packaging.test.ts`, which asserts the exact file list.

## 3. Run the release gate

From a clean checkout of the release commit, with Node 22 and pnpm 10:

```bash
pnpm install --frozen-lockfile
pnpm lint
git fetch --no-tags --depth=1 origin main
DS_AGENT_FORMAT_BASE=origin/main pnpm format:check
pnpm typecheck
CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 npx vitest run
pnpm build
npx tsx scripts/release-check.ts
```

`scripts/release-check.ts` fails with an actionable message when:

- `package.json` has no semver `version`;
- `bin.ds-agent` is not `./dist/cli/main.js`;
- `files` does not include `dist`;
- `dist/cli/main.js` or the runtime rules asset is missing (run `pnpm build`);
- `npm pack --dry-run --json` fails, ships no `dist/`, or omits the entry
  points.

It accepts `dist/watchdog/rules.json` (the asset this build emits) and the
historical `dist/channels/rules.json` layout.

## 4. Build and inspect the tarball

```bash
rm -f ds-agent-*.tgz
npm pack --json | tee release-pack.json
tar -tzf ds-agent-*.tgz | sort
```

Confirm the tarball contains `package.json`, `dist/cli/main.js`, the rules
asset, `README.md`, `README.zh-CN.md`, `LICENSE`, and the docs listed in
`package.json` `files`. Confirm it contains no `.ds-agent/`, no test files,
no secrets, and no machine-specific path.

## 5. Tag and publish the GitHub release

Use an annotated tag on the exact commit that passed the gate:

```bash
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v${VERSION}" -m "ds-agent v${VERSION}"
git push origin "v${VERSION}"

gh release create "v${VERSION}" ./ds-agent-"${VERSION}".tgz \
  --title "ds-agent v${VERSION}" \
  --notes-file CHANGELOG.md
```

`--notes-file CHANGELOG.md` is only appropriate if the file has a section for
this version; otherwise write release notes directly. Do not move or delete a
published tag to fix a mistake; publish a new patch version.

## 6. Install smoke test

Test the tarball, not the working tree, in a temporary prefix and state home:

```bash
PREFIX="$(mktemp -d)"
STATE="$(mktemp -d)"
npm install --prefix "$PREFIX" ./ds-agent-*.tgz

"$PREFIX/node_modules/.bin/ds-agent" --help
DS_AGENT_HOME="$STATE" "$PREFIX/node_modules/.bin/ds-agent" init
DS_AGENT_HOME="$STATE" "$PREFIX/node_modules/.bin/ds-agent" status

# If the backup/restore CLI integration is present in this release:
DS_AGENT_HOME="$STATE" "$PREFIX/node_modules/.bin/ds-agent" \
  backup --out "$STATE/smoke-backup.db"
```

Expected: `--help` exits 0, `init` prints the state directory, `status` opens
the same database without an error, and the backup file exists. Repeat the
`init`/`status` pair on Node 22, the oldest supported major.

## 7. Rollback a release

Releases are immutable. To roll back:

1. Mark the bad GitHub release as a pre-release and add a note pointing at the
   previous good version; do not retag.
2. Give operators the previous tarball and its checksum.
3. If the release advanced the schema, follow the rollback procedure in
   [UPGRADE.md](./UPGRADE.md): stop the process, install the previous binary,
   and restore the pre-upgrade backup when the older build cannot read the new
   schema.
4. Publish a patched version that fixes forward. Do not edit
   `schema_migrations` by hand.

## Workflow permissions and secrets

`.github/workflows/release.yml` (merged in #132 `a1985c0`) declares
`permissions: contents: read`, runs on `workflow_dispatch`, and contains no
`secrets.*` references. It installs dependencies, runs the offline gate,
builds, runs the release check, and uploads the tarball. Publishing is a
deliberate human step from a reviewed tag.
