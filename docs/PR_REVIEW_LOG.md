# PR review log

Independent reviews by the Chief Engineer. A passing CI run is necessary but not
sufficient. Verdicts: **APPROVE** (may carry non-blocking follow-ups) /
**REQUEST_CHANGES** / **REJECT** / **BLOCKED**.

Provenance: this log records the orchestrator's independent review verdicts.
GitHub review objects were not submitted for #75–#87; the external evidence is
each PR's required CI run and its merge SHA. Verdicts below name the reviewed
head so a later reader can separate the reviewed tree from the merged tree.

## PR #75 — `docs: establish the 2026-11-03 engineering state`

- **Author:** LofiSu (chief engineer)
- **State at review:** OPEN, docs-only, based on `924a08b`, later merged
  `main` (`cb32a17`). **Merged as `08ea78f` at `deed616`**, before the final
  reconciliation commit `bdce7ea`; the merged docs still carry the old
  `bb11c96` baseline. The corrections land in the follow-up docs PR.
- **Independent review:** REQUEST_CHANGES on nine findings: (1) the claim that
  the Engine is the only writer was false because `Harness.launch` calls
  `store.putDoc('ticket', ...)`; (2) the iMessage root cause inverted the
  admission order; (3) AUDIT-REFRESH was scheduled in Cycle 1 despite sharing
  docs with P1-3; (4) #64 added 12 test files, not 13; (5) the coverage branch
  figure differed from CI by 0.02 points; (6) the suite file count was
  ambiguous; (7) the open-PR snapshot was stale; (8) "APPROVE WITH FOLLOW-UPS"
  was not in the verdict legend; (9) the admission plan omitted
  `DS_AGENT_IMESSAGE_HANDLE`.
- **Resolution:** baseline moved to `cb32a17`; the deviation is named with
  file:line; the admission explanation now starts from empty default rules; the
  plan orders AUDIT-REFRESH after P1-3; counts and coverage are explicit;
  `DS_AGENT_IMESSAGE_HANDLE` and group aggregation requirements are included.
- **Verdict:** fixes applied; the PR was merged before the final head was
  re-reviewed. The reconciliation is carried by the follow-up docs PR; do not
  treat `08ea78f` as the corrected checkpoint.

## PR #74 — `docs: record the final 2026-11-03 audit on main` (superseded record)

> This is the initial `cb6cdf2` review record. The refreshed-head review and
> merge are recorded in the second `PR #74` section below; this entry is kept
> for append-only history and is not the current verdict.

- **Author:** LofiSu (agent-assisted)
- **State at review:** OPEN, `MERGEABLE`, `BEHIND`, docs-only.
- **CI:** `typecheck and test` success on `ad0fd62`; demo job skipped;
  CodeRabbit status success but its comment is a rate-limit notice, not a review.
- **Scope:** `docs/MODULES.md` (+2/−1), `docs/ROADMAP.md` (+20/−4).
- **Content review:** the diff correctly labels the live Magpie 207/3 line as
  operator-only and unreproduced. The revision row is internally consistent with
  the `fa974ca` base.
- **Blocking finding:** the PR claims an audit of current `main` but its base is
  `fa974ca`; `main` has since merged `#64` (`bb11c96`), `#78` (`cb32a17`), `#75`
  (`08ea78f`), `#76` (`aae182c`), and `#77` (`03a4c02`, the resulting main tip).
  The 302 tests / 82.40% coverage evidence is stale, and the header and §2/§3
  matrices still say `fa974ca`.
- **Verdict:** **REQUEST_CHANGES** — rebase on current `main`, replace the
  evidence with the verified `03a4c02` run, add revision rows for `#64`, `#75`,
  `#76`, `#77`, and `#78`, and state that the gateway/iMessage surface is
  included. Do not merge until green on the refreshed head. Because it edits
  `docs/ROADMAP.md` and `docs/MODULES.md`, it follows P1-3.

## PR #76 — `feat(gateway): harden authentication and exposure boundaries`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN, `MERGEABLE`, `CLEAN`; base advanced to `cb32a17`
  through a main merge; effective diff is 6 files, +223/−13. **Merged as
  `aae182c`.**
- **CI:** `typecheck and test` pass; demo job skipped; CodeRabbit rate-limited.
- **Scope:** `src/gateway/server.ts`, `src/gateway/token.ts`,
  `src/cli/gateway.ts`, `src/gateway/web.ts`, `test/gateway.test.ts`,
  `test/gateway-web.test.ts`.
- **Verified behavior:** length-guarded `timingSafeEqual`; uniform 401 before
  upstream calls; `nosniff` on JSON and SSE paths; `no-store` after auth; empty
  token refused; non-loopback warning; token file re-chmodded 0600; dashboard
  does not embed the token.
- **Non-blocking findings:** token-file reads followed symlinks at the #76
  reviewed head (`src/gateway/token.ts:25-63`; fixed by #82, so those lines
  differ at `34aef25`); fail-closed chmod, SSE header, identical-401,
  and CLI-warning tests are missing; Windows mode enforcement is skipped;
  `Bearer` scheme parsing is stricter than RFC 7235; the CLI can name a token
  file that was not written. Symlink/tests are tracked as
  GATEWAY-TOKEN-SYMLINK.
- **Verdict:** **APPROVE** — no merge blockers; follow-ups must land before use
  with a shared or writable state directory.

## PR #77 — `fix(imessage): fail closed admission and gate group chats`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN, `MERGEABLE`, `CLEAN`; effective diff is 4 files,
  +339/−17; base advanced to `cb32a17` through a main merge. **Merged as
  `03a4c02` before the blocking finding was fixed.**
- **CI:** `typecheck and test` pass; demo job skipped; CodeRabbit rate-limited.
- **Verified behavior:** admission gate refuses empty/whitespace/comma-only
  allowlists; `--allow-any` and `--allow-groups` are explicit; 1:1 messages are
  `direct`, group messages are not; cursor advances past skipped group rows;
  `Runtime.ingest` applies the actor allowlist before `addressed`, so a
  non-allowlisted direct trigger is dropped.
- **Blocking finding:** group metadata is discarded by guid dedupe. A message
  joined to a 1:1 chat first and a group chat second is classified non-group,
  marked `direct`, and ingested with groups closed. A missing chat row also
  defaults to non-group through the `LEFT JOIN`. This violates the requirement
  that a group message is never direct and omits `channel.address.group`.
- **Minor findings:** handle is trimmed for admission but not for SQL; old
  schemas without `chat.style`/`chat.room_name` retry forever; test gaps for
  multi-chat, missing chat row, style 43 with NULL room_name; stale CLI usage
  and comment wording; embedded gateway starts before the admission gate.
- **Verdict:** **REQUEST_CHANGES** — aggregate groupness across all joined rows
  before dedupe, fail closed on missing/ambiguous metadata, trim once for both
  gate and SQL, and add the fixtures. Re-review the fix commit.
- **Process incident:** the merge happened at `03a4c02` before this verdict was
  addressed. `main` therefore contains a known group-classification gap; the
  corrective PR is #81 and must merge before the iMessage surface is called
  fail-closed.

## PR #81 — `fix(imessage): aggregate group metadata and fail closed on unknown chats`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN, based on `03a4c02`; 5 files.
- **Reported behavior:** groupness is aggregated across every joined chat before
  guid dedupe; any style 43 or non-empty room name is a group; missing or
  ambiguous chat metadata is unknown/group and skipped; the group chat GUID is
  retained in `channel.address.group`; ROWID paging keeps all joins visible;
  handle trimming feeds both the gate and SQL; absent `chat.style` /
  `chat.room_name` raises a cached `ImessageSchemaError`; CLI help and docs are
  updated.
- **Reported evidence:** CI `typecheck and test` pass; focused iMessage suite
  29 passed; full offline suite 395 passed / 15 skipped; typecheck, lint (224
  files), and format pass.
- **Independent review:** **APPROVE**. Aggregation is order-independent and
  page-safe: the inner query selects message ROWIDs and the outer query joins
  every chat, so a page cannot split a message's joins. `isGroup` is true if any
  row is style 43 or has a room name, and also when there are no chat rows or
  any non-direct row. Missing metadata is never direct. Handle trimming uses one
  value for gate and SQL; the schema error is cached and rethrown. Cursor
  advancement is preserved. The reviewer verified the multi-chat and no-chat
  tests are non-vacuous.
- **Non-blocking findings:** no test for group-then-1:1 order or page-boundary
  joins; an ambiguous/group row can fall back to another chat's GUID as the
  group id; the CLI poll-loop rethrow is inspection-only; the schema check
  covers only `chat.style`/`chat.room_name`.
- **Merged:** `f4ba77a` (2026-11-03T06:30:31Z). CI green on the updated head.
- **Verdict:** **APPROVE** and merge.

## PR #79 — `feat(harness): enforce worker-mesh capacity and queue`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN; implementer reports CI green.
- **Reported scope:** bounded FIFO (`DS_AGENT_MESH_QUEUE`, default 100); launch
  waits for capacity; full queue rejects without throwing; pump on ticket end
  and Engine assignment-ended; `jobsSettled` waits instead of dropping; explicit
  shutdown drain; mesh metrics; `Engine.assignmentPlaced` is the only writer of
  `Assignment.node`.
- **Reported evidence:** full suite 380 passed / 15 skipped; typecheck, lint,
  format pass; CI `typecheck and test` pass.
- **Independent review:** **REQUEST_CHANGES** after merge. Release hooks fire
  before the terminal ticket `putDoc`; `pump()` re-reads a pre-terminal ticket
  and can start a queued Worker after its ticket ended. A capacity-1
  interleaving with a `deliver()` follow-up reproduces it deterministically.
  The queue bound, FIFO, full-queue resolution, settle-vs-drain split, metrics,
  and Engine-owned placement were verified good.
- **Corrected by:** PR #84, merged `34aef25` after an APPROVE review. The fix
  defers release via `queueMicrotask`, runs hooks after persistence, revalidates
  queue entries at the head and immediately before start, cleans reservations
  on start errors, and adds regressions that fail on the pre-fix base.
- **Merged:** `1dc9500` (2026-11-03T06:21:46Z). The merge preceded the review
  verdict, so the finding is recorded as a post-merge incident.

## PR #82 — `fix(gateway): reject redirected token files and cover security branches`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN head `a39b566`; 6 files; base lagged main by two
  docs commits with no conflict.
- **Independent review:** **APPROVE**. lstat rejects symlinks, hard links, and
  non-regular files; reads use `O_NOFOLLOW` with fstat dev/ino identity; creation
  is exclusive; fail-closed chmod throws `GatewayTokenPermissionError` without
  returning the token; RFC 7235 `Bearer` parsing keeps the credential compare
  constant-time and the 401 uniform; SSE/JSON headers are correct; tests are
  non-vacuous. No new dependencies, no credential logging.
- **Non-blocking findings:** concurrent first-create can return a token that
  differs from the persisted file (EEXIST + empty in-progress file); ELOOP after
  an lstat→open swap is swallowed as "not found"; no dedicated tests for the
  EEXIST path or the explicit-token CLI label; the SSE test cannot fully
  distinguish `writeHead` from the buffered path; the hard-link test covers only
  `readGatewayToken`.
- **Merged:** `1c165ef` (2026-11-03T06:33:52Z). CI green on the updated head.
- **Verdict:** **APPROVE** and merge; follow-ups tracked.

## PR #84 — `fix(harness): defer mesh pump until terminal state is committed`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN head `e8614b9`, parent `1dc9500`; 4 files.
- **Independent review:** **APPROVE**. Hooks run after the terminal `putDoc` on
  normal and discard paths; `Runtime` defers release with `queueMicrotask`;
  `queueState()` rejects missing/ended/paused/no-assignment/terminal entries;
  `startQueued()` re-reads immediately before start and cleans the reservation
  on synchronous failure; programmatic queue limits are sanitized. The two
  regression tests reproduce the capacity-1 and capacity-2 interleavings and
  fail on the pre-fix base. Full offline suite 400 passed / 15 skipped on the
  reviewed head `e8614b9`; CI on the merged `34aef25` tree reports 414 passed /
  15 skipped.
- **Non-blocking findings:** no dedicated `queueState` tests for
  `ended`/`failed`/`blocked`/missing-ticket branches; the non-queued
  `startOrQueue` synchronous error path still lacks cleanup; `mesh.assigned` can
  over-count on a rare cross-process skip.
- **Merged:** `34aef25` (2026-11-03T06:45:36Z). CI green on the updated head.
- **Verdict:** **APPROVE** and merge.

## PR #64 — `feat: iMessage channel + local OpenAI-compatible gateway`

- **State:** merged before this review cycle.
- **Scope:** 46 files, 4,390 insertions, 12 test files.
- **Findings recorded after merge:**
  - IMESSAGE-ADMISSION: iMessage trigger is default-open (`addressed: 'direct'` for every
    message; `--handle`/`DS_AGENT_IMESSAGE_HANDLE` optional; no group detection).
    The default run has no admission rules, so `admissionDeny` denies nothing.
    Compensating control: `DS_AGENT_ACTOR_ALLOWLIST` exists but is not required.
    Fix in `agent/imessage-admission`.
  - GATEWAY-HARDENING: gateway token compare is not constant-time; empty token accepted;
    non-loopback bind unwarned; token file mode not re-checked. Fix in
    `agent/gateway-hardening`.
  - Positive: iMessage text reaches AppleScript through the environment, not
    string interpolation; outbound env is filtered; gateway token is generated
    with 24 random bytes and written 0600; provider credentials are not exposed
    by `/health`.
- **Verdict (retrospective):** **APPROVE** with non-blocking follow-ups. No
  protocol-breaking defect found in the reviewed paths; the admission and auth
  edges must be hardened before this surface is called production-ready.

## PR #83 — `docs: reconcile project state to main 34aef25`

- **Author:** LofiSu (chief engineer)
- **State at review:** initial head `581cc69`; corrections pushed as `e0bee0f`;
  7 docs files, +794/−251; no code or config.
- **Independent review:** **REQUEST_CHANGES** on the initial head for five
  blocking findings:
  (1) `docs/PROJECT_AUDIT.md` still described the pre-#79 direct
  `store.putDoc('ticket', ...)` deviation even though `34aef25` routes placement
  through `Engine.assignmentPlaced` (`src/harness/loop.ts:298`);
  (2) `docs/MASTER_PLAN.md` repeated the same stale constraint;
  (3) `docs/MASTER_PLAN.md` Task 1 still said the group-fix PR was pending when
  #81 merged at `f4ba77a`;
  (4) `docs/PROJECT_AUDIT.md` described default-open `addressed: 'direct'` in
  the present tense and cited the pre-#77 lines (now `src/channels/imessage.ts`
  at 215-225 sets direct only for non-group messages);
  (5) the coverage branch figure was transcribed as 80.05% (2702/3375) while CI
  on the exact commit reports 80.06% (2703/3376).
- **Non-blocking fixes applied:** add #78 to the merged list; label #84's 400
  test count as the reviewed head; qualify the #76 token line citation; correct
  the `docs/MODULES.md` restart citation to 81-82; add review provenance.
- **Re-review:** scoped re-review at `e0bee0f` returned **APPROVE**; all five
  blocking findings verified resolved and the non-blocking fixes confirmed. CI
  `typecheck and test` passed on `e0bee0f` (414 passed / 15 skipped). The head
  run reports 80.07% branches, consistent with the documented one-branch V8
  variance; the audit doc attributes 80.06% to the `34aef25` run.
- **Verdict:** **APPROVE** and merge.
- **Merged:** `cecfba0` (2026-11-03). CI green on `f7e545a`; all review threads
  resolved.

## PR #85 — `feat(harness): recover interrupted assignments on startup`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN heads `4b3ad35` → `04a421e` → `3bff7a5`; final merge
  head `ba405c1`. Files: `src/core/assignments.ts`, `src/core/engine.ts`,
  `src/runtime.ts`, `src/harness/loop.ts` (orchestrator-authorized for prompt
  injection), `test/restart-recovery.test.ts`.
- **Independent review:** **REQUEST_CHANGES** on the first heads. Blocking:
  (1) same-process re-entrancy — a second `Runtime.start()` after the async
  relaunch marked the replacement `running` re-recovered a live assignment,
  producing 3 assignments and 2 RECOVERED inputs; the original test mocked
  launch and masked it. (2) The RECOVERED context was persisted but never
  rendered into the Worker prompt (`Harness.workerTask` did not read
  `ticket.inputs`). Non-blocking: unhandled launch rejection, stranded pending
  replacement, no per-ticket isolation.
- **Re-review:** **APPROVE** at `3bff7a5`/`ba405c1`. Verified per-Runtime
  one-shot guard, prompt injection, sync/async launch-failure isolation,
  crash-boundary relaunch, malformed-ticket isolation, and 11 non-vacuous tests
  that all fail on `34aef25`. Residual non-blocking: a malformed doc that
  throws after a write can commit a partial effect (unreachable from valid
  state); `recoveryAttempted` disables in-process retry after a scan failure.
- **Merged:** `10e9f3c` (2026-11-03). CI green on `ba405c1`.

## PR #74 — `docs: record the final audit on main`

- **Author:** LofiSu (agent-assisted)
- **State at review:** initial head `cb6cdf2` (+34/−8); corrections at
  `3119369` (+36/−9); post-#83 refresh `7a63284`; final coverage fix `6ce1c42`.
  Docs/ROADMAP.md and docs/MODULES.md only; CI passed on every head.
- **Independent review:** **REQUEST_CHANGES** twice. First: the revision row
  claimed "#75–#84 merged" although #83 was still open, and the `34aef25`
  evidence was not yet in `docs/PROJECT_AUDIT.md` on `main`. Second, at
  `7a63284`: both docs still reported branches 80.05% (2702/3375) while the
  merged audit doc and PR body said 80.06% (2703/3376).
- **Resolution:** merge #83 first, merge `main` into the branch, add a
  `cecfba0` revision row, and align the branch figure to 80.06% (2703/3376) in
  `docs/ROADMAP.md:536` and `docs/MODULES.md:289`. Delta re-review APPROVE.
- **Merged:** `299b908` (2026-11-03). CI green on `6ce1c42`.
- **Verdict:** **APPROVE** and merge.

## PR #87 — `fix(gateway): fail closed on token-file create races and ELOOP`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN, `MERGEABLE`, `CLEAN`; head `988e942`; base `main`
  `10e9f3c`. Files: `src/gateway/token.ts`, new `test/gateway-token.test.ts`,
  new `test/cli-gateway.test.ts`; +157/−21; no docs or project-state changes.
- **Independent security review:** **APPROVE**. Verified that the EEXIST race
  with an empty in-progress file throws `GatewayTokenFileError` and leaves the
  winner's bytes untouched; the truncate/overwrite path is removed; ELOOP from
  read and create paths is converted to `GatewayTokenFileError`; symlink,
  hard-link, non-regular, `O_NOFOLLOW`, `O_EXCL`, fstat dev/ino identity,
  fail-closed `0600`, uniform 401, and constant-time bearer behavior are
  unchanged. Both security tests fail on `10e9f3c`; the CLI test asserts no
  token is printed and `tokenPath: null` with an explicit `--token`.
- **Verification:** typecheck, lint (227 tracked files), format pass; focused
  gateway tests 36 passed; full offline suite 429 passed / 15 skipped (444),
  58 files. CI `typecheck and test` passed on the exact head. No live listener,
  network call, or credential value in tests or logs.
- **Residual non-blocking:** the EEXIST winner-reuse branch and the create-path
  ELOOP branch remain untested; a stale empty token file now blocks startup
  until removed manually; the EEXIST wording is imprecise for a non-empty
  unreadable file; a torn single-write winner token remains theoretically
  observable but is accepted by the contract.
- **Merged:** `5fbfb00` (2026-11-03); `main` CI green on the merge commit.

## PR #88 — `[SUPER-AGENT][IMESSAGE-GROUP-EDGES] Fail closed on ambiguous group addresses`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN; heads `7829b27` → `890f238` (after merging `main`
  `5fbfb00`). Files: `src/channels/imessage.ts`,
  `test/channels-imessage.test.ts`, `docs/IMESSAGE.md`.
- **Independent review of `7829b27`:** **REQUEST_CHANGES**. Blocking: the
  address-level fix left `address.handle` set for every group message, and
  `ImessageOutboxAdapter.send` falls back to `{ handle }` (buddy / 1:1 mode)
  when no `chatGuid` is present. An ambiguous group therefore produced
  `{provider, handle}` and its reply would be sent as a DM to the sender. A
  second variant: a positive group row with only `chat_identifier` produced
  `{provider, handle, group}` and still sent buddy mode. The reviewer reproduced
  the trigger→outbox hand-off with zero chat guid.
- **Fix at `890f238`:** group addresses omit `handle`; the adapter refuses any
  `target.group` without `target.chatGuid` before calling `api.send`; tests
  cover ambiguous group rejection with zero sends, identifier-only group
  rejection, a legacy group target carrying a handle, a guid-bearing group
  sent in chat mode, and the unchanged 1:1 buddy fallback. Five regressions
  fail against `7829b27`.
- **Residual non-blocking:** ambiguous-group threads remain keyed
  `handle:<sender>`, so group and 1:1 messages from one sender can share
  context; tracked as IMESSAGE-THREAD-KEY for a later branch. Fail-closed
  groups still create tickets and enqueue rows that retry to `failed`; a
  positive group row with only an identifier can win over a later guid-bearing
  row by join order.
- **Re-review at `890f238`:** **APPROVE**. Verified the group address omits
  `handle`, the adapter rejects `group` without `chatGuid` before any send, the
  five regressions fail against `7829b27`, and `docs/IMESSAGE.md` matches the
  implementation. Focused suite 40 passed; full offline suite 440 passed / 15
  skipped (455), 58 files.
- **Merged:** `d3beb9c` (2026-11-03). CI `typecheck and test` success on the
  exact head `890f238`.

## PR #89 — `[SUPER-AGENT][ENGINEERING-STATE] Reconcile status after #83/#74/#85`

- **Author:** LofiSu (chief engineer)
- **State at review:** OPEN, `CLEAN`; head `5b89ae3`; 7 docs files, +170/−82;
  no code, runtime, or configuration change.
- **Independent docs review:** **REQUEST_CHANGES** on two blocking findings:
  (1) the branch figure was attributed to CI as 80.09% (2748/3431), but the
  `10e9f3c` CI job reports 80.05% (2746/3430); (2) the open-PR snapshot claimed
  "none" and that the cycle-3 branches had no PRs, while #86, #88, and #89 were
  open and #88 was on the named branch. Non-blocking: a duplicate `## PR #74`
  section and self-exclusion of #89 from pending reviews.
- **Resolution:** all figures and PR snapshots refreshed to `main` `d3beb9c`
  (run `41600424146`: 440 passed / 15 skipped (455), 58 files; 82.29%
  statements/lines, 80.57% branches (2787/3459), 89.97% functions); #87 and
  #88 merges recorded, with #88's REQUEST_CHANGES → fix `890f238` → APPROVE
  history; #86 listed as stale; the duplicate #74 section marked superseded;
  scoped re-review pending.
- **Verdict:** corrections applied; not merged at this checkpoint.
- **Post-checkpoint:** scoped re-review at `e4e8768` returned **APPROVE**; the
  two blocking findings and the superseded-#74 note were verified resolved. CI
  passed on the exact head (run `41601373653`). Merged `ed8980d`.

## PR #90 — `[SUPER-AGENT][IMESSAGE-THREAD-KEY] Separate group and 1:1 conversation keys`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN; initial head `322a85d`, reviewed head `e92f87b`
  after merging `main` `ed8980d`. Two later integration merges of `main` —
  `4460a8f` (`1dd426a`) and `59cbd2c` (`60bb9ae`) — changed no task-owned lines;
  the final head is `59cbd2c`. Files: `src/channels/imessage.ts`,
  `test/channels-imessage.test.ts`, `docs/IMESSAGE.md` (+148/−5).
- **Independent review:** **APPROVE**. Verified `imessageThreadFor` maps a chat
  guid to `chat:`, a group without a guid to `group:<identifier>` or
  `group-unknown:<handle>`, and a 1:1 without a guid to `handle:`; group keys
  can never equal a 1:1 key. `imessageTrigger` passes the resolved group flag;
  actor and admission are unchanged. Positive-group guids and identifiers are
  aggregated independently, so an identifier-only row cannot hide a later
  guid. Search found no consumer that assumes the old group `handle:` key.
- **Non-vacuity:** three behavioral tests fail on `d3beb9c` (ambiguous group
  key, identifier key, later-guid aggregation); the guid-thread and 1:1-key
  tests pass on base by design. Focused suite 45/45; full offline 445/15 (460).
- **Residual non-blocking:** same-sender ambiguous groups across distinct group
  chats share `group-unknown:<handle>` (never with 1:1); persisted historical
  group threads under the old key no longer correlate (one-time split, no code
  migration); `imessageThreadFor` checks raw `chatGuid` truthiness while the
  pull path normalizes.
- **Merged:** `8fa3a79` after a final merge of `main` `60bb9ae`; CI green on the
  exact head `59cbd2c`.

## PR #91 — `[SUPER-AGENT][LIVE-SUITE-SALVAGE] Re-land the test-only live-suite determinism changes`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN; head `4f55247`; base `ed8980d`. Four test files,
  +12/−10; no docs or product code.
- **Independent review:** **APPROVE**. The default MockModel refusal is
  unchanged; only `test/credential-sentinel.test.ts` passes `allowMockModel:
  true`, and no other `freshRuntime` caller opts in. `metrics.test.ts` removed
  only the three live/timer-dependent keys from the strict match; all separate
  assertions remain. `team-live.test.ts` changed only deadlines. The four test
  files are byte-identical to PR #86's head.
- **Residual non-blocking:** the replacement `toHaveProperty` assertions for
  `speculate.deliver`/`watchdog.idle` are tautological under the zeroed counter
  map; a future change should assert them deterministically under the offline
  fixture. The live deadline change cannot be exercised offline.
- **Merged:** `1dd426a`. CI green on the exact head (run `41602071864`). PR #86
  was closed as superseded; its docs conflict with current `main` and its
  live-run record was not reproduced.

## PR #92 — `[SUPER-AGENT][MESH-QUEUE-TESTS] Cover queueState skip branches and clean up failed non-queued starts`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN; head `606869a` after merging main `ed8980d`;
  final head `a226cc0` after merging `1dd426a`. Files: `src/harness/loop.ts`
  (+19/−2), `test/worker-mesh.test.ts` (+136/−1).
- **Independent review:** **APPROVE**. Direct tests now cover `store-closed`,
  `ticket-missing`, `no-assignment`, `assignment-ended`, `assignment-failed`,
  and `assignment-blocked`; the existing test covers `ended` and `paused`. Each
  asserts the skip log, no Worker start, and a settling launch. Mutation of the
  six skip branches made all six tests fail, so they pin the branches.
  `startNow()` releases the active marker and picked node on a synchronous
  throw; `releaseNode` is idempotent and the queued path is unchanged.
- **Residual non-blocking:** an asynchronous rejection still rejects
  `harness.launch` and does not release the node from the Harness (unchanged
  from base, outside the synchronous scope); a throw inside `assignmentPlaced`
  or later is not directly exercised; the six tests pin branches via the skip
  log, with the no-start assertions backstopped by the `startQueued` re-read.
- **Merged:** `60bb9ae`. CI green on the exact head (run `41604489526`).

## PR #103 — `[SUPER-AGENT][SUBSCRIPTION-FANOUT-TEST] Script the many-to-many workers so fan-out no longer waits on a live model`

- **Author:** LofiSu (peer session sulin-5f); test-only.
- **State at review:** MERGED at `5e5a28b`; reviewed from the merged diff. Head
  `47342dd`; file `test/subscription.test.ts` (+4/−1).
- **Independent review:** **APPROVE**. The assertion is unchanged — which
  Tickets receive `trg_recent` and which one stops after it ends. The diff only
  gives that runtime a `silentModel()`, so the incidental Worker turns no
  longer call the default live model; fan-out behavior is model-independent and
  the file already mixes scripted and live runtimes. No source or fixture
  changes.
- **Evidence:** PR CI `typecheck and test` green on head `47342dd` (run
  `41792560150`). Post-merge `main` CI run `41792700396`: 464 passed / 15
  skipped (479), 82.82% lines. Peer session's full live suite on `5e5a28b`:
  476 passed / 3 skipped, exit 0. Zero unresolved threads.

## PR #107 — `[SUPER-AGENT][IMESSAGE-GROUP-UNKNOWN] Disambiguate legacy group chats by chat.ROWID`

- **Author:** LofiSu (peer session sulin-3a).
- **State at review:** MERGED at `00665d2`; reviewed head `74c627e` (refreshed
  onto `69b6d3d`). Files: `src/channels/imessage.ts`,
  `test/channels-imessage.test.ts`, `docs/IMESSAGE.md`.
- **Independent review:** **APPROVE**. Thread-key precedence is strict and
  tested: `chat:<guid>` > `group:<identifier>` > `group-rowid:<rowid>` >
  `group-unknown:<handle>`, while 1:1 stays `handle:<handle>`. The ROWID comes
  only from a positive group row (`style = 43` or `room_name`), never from a
  joined 1:1 or ambiguous row, and passes `safeChatRowId` (positive safe
  integer; bigint converted; 0/negatives/fractions/NaN rejected). Outbound is
  unchanged: the group address still derives only from guid/identifier and
  fails closed without one, so a rowid key is thread-only. Tests include a
  real-SQLite two-distinct-groups regression (same sender, no guid/identifier)
  and a joined-1:1 case where the 1:1 row sorts first; both fail against the
  old collapse to `group-unknown:<handle>`. Docs record the per-database
  instability and the `group-unknown` → `group-rowid` upgrade thread split.
- **Merged:** `00665d2`; CI green on `74c627e` (run `41795794639`); zero
  unresolved threads.

## PR #106 — `[SUPER-AGENT][FEISHU-SERVE-LOOP] Run an inbound Feishu poll loop from serve`

- **Author:** LofiSu (implementer agent).
- **State at review:** MERGED at `e9a1978`; head `6c2f1da`. Files:
  `src/cli/feishu.ts` (new), `src/cli/main.ts`, `src/channels/feishu.ts`
  (read-only cursor accessor), `test/cli-serve-feishu.test.ts` (new, 11 tests),
  `docs/REAL_CHANNELS.md`, `docs/MODULES.md`.
- **Independent review:** **APPROVE**. Config is resolved before
  `Runtime.create`, so missing app credentials or a missing `--chat`/
  `FEISHU_CHAT_ID` leaves SQLite and state directories untouched; `--imessage`
  + `--feishu` is rejected before any resource opens. The loop mirrors the
  #101 shape: pull → ingest → persist → `jobsSettled` → outbox flush →
  abortable sleep, with bounded exponential backoff on pull errors. Cursor
  `feishu_cursor/cursor = { chatId, lastCreateTimeMs }` uses precedence
  `--since` > stored-for-this-chat > FeishuSource's now-5min, and is written
  only after ingest and only when advancing. Cross-restart no-replay is proven
  with a fresh Runtime over the same SQLite (stored cursor seeds the source);
  overlap from the source's 1s lookback is deduped by Trigger id in
  `Runtime.ingest`. Admission is not weakened: `addressed='mention'` only on a
  real mention, nothing marked direct, and `channel.address.group = chat_id`
  feeds the normal filter.
- **Residual non-blocking:** an in-flight Feishu pull is not cancellable
  (same class as the iMessage API); a run with no messages does not persist the
  now-5min default, so a restart re-pulls that window (deduped, not
  reprocessed); the 20×50 list page limit under a very large burst is not
  live-exercised; live Feishu acceptance was not performed.
- **Merged:** `e9a1978`; CI green on `6c2f1da` (run `41795247006`); local
  `test/cli-serve-feishu.test.ts` + `test/channels-feishu.test.ts` 28/28; zero
  unresolved threads.

## PR #105 — `[SUPER-AGENT][STALE-GATEWAY-TOKEN] Add ADR-009 for stale empty token recovery`

- **Author:** LofiSu (implementer agent); docs-only.
- **State at review:** MERGED at `69b6d3d`; reviewed heads `eff86fd` →
  `1e0405e` (accuracy fix) → `42d313a` (refreshed). Files:
  `docs/ARCHITECTURE_DECISIONS.md` (+115), `docs/GATEWAY.md` (+68/−1).
- **Independent review:** **APPROVE after correction**. The ADR diagnoses the
  current path accurately: an empty/whitespace token is read as missing, the
  exclusive create hits `EEXIST`, and the re-read throws the misleading
  "was created concurrently and is empty" error before binding; the client
  path silently falls back. The recommended policy — keep fail-closed, never
  auto-regenerate, recover only by explicit operator action, preserve content
  and inode — is the right security call, with the rotate-flag and
  rename-aside options rejected for the stated reasons. The initial draft
  claimed the failing path never chmods; that was wrong because
  `ensurePrivateMode` tightens a loosened mode to 0600 on every read. The
  author confirmed it empirically (0644 → error → 0600, same inode, empty
  content) and the ADR/docs now state mode repair is the standing invariant,
  not recovery, and the follow-up tests assert content/inode unchanged plus
  mode exactly 0600 on POSIX.
- **Residual:** documentation only; the implementation follow-up (distinct
  stale-empty error, fail-closed client read) is not done and remains a
  candidate cycle.
- **Merged:** `69b6d3d`; CI green on `42d313a` (run `41795531295`); zero
  unresolved threads.

## PR #99 — `[SUPER-AGENT][MESH-FAILURE-PUMP] Pump queued Workers after a failed non-queued Worker releases its node`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN; reviewed heads `b2b0e4f` and refreshed `48aa718`.
  Files: `src/harness/loop.ts` (+9/−0), `test/worker-mesh.test.ts` (+53/−0).
- **Independent review:** **APPROVE**. Both `startNow` failure paths — the
  synchronous throw and the asynchronous rejection — now release the picked
  node and then `pump()`, gated on a node having been picked. An ordering
  comment documents why the release-then-pump sequence cannot double-start.
  The regression test is deterministic: a gated A model call, B queued, and a
  targeted `upsertSession` idle rejection for `worker_A`; the base fails with
  `settlesWithin` false, and the test passed 10/10 repeats.
- **Merged:** `6184a27`; CI green on refreshed head `48aa718` (run
  `41791142621`). Post-merge `main` CI run `41791336153`: 456 passed / 15
  skipped (471 tests), statements/lines 82.42% (7846/9519), branches 81.03%
  (2820/3480), functions 90.11%. Zero unresolved threads.

## PR #97 — `[SUPER-AGENT][MESH-ASYNC-RELEASE] Release the mesh node when a non-queued Worker turn rejects`

- **State at review:** OPEN; head `f18e16f` after the cycle-5 follow-up.
  Files: `src/harness/loop.ts` (+9/−2), `test/worker-mesh.test.ts` (+32).
- **Independent review:** **APPROVE**. `startNow()` now attaches a `.catch`
  to the turn promise returned by `startWorkerTurn`, so an asynchronous
  rejection returns the node reserved by `pickNode` and logs
  `[harness] worker failed ticketId=... error=...`; the synchronous path and
  the queued path retain their existing cleanup. `startWorkerTurn`'s
  `.finally` already clears the active marker and pumps, so the catch only
  needs the mesh reservation. The new test throws inside the memory-recall
  callback (inside the scheduled Worker turn) and proves the launch resolves,
  `workerMesh.inFlight` returns to 0, and a later Worker still runs.
- **Residual non-blocking:** swallowing the turn rejection changes
  `Harness.launch` from rejecting to resolving for asynchronous Worker
  failures; the failure is logged, and the queued path already resolved on
  error. Callers that awaited rejection must read the log or ticket state.
- **Follow-up finding:** after a failed non-queued Worker releases its node,
  the Harness does not `pump()`, so an already-queued Worker can stay parked
  with a free node until a later event. Dispatched as MESH-FAILURE-PUMP and
  later merged as #99 (`6184a27`); it is not part of this review.
- **Merged:** `9a0def3`. CI `typecheck and test` green on the reviewed head;
  zero unresolved threads.

## PR #96 — `[SUPER-AGENT][GATEWAY-TOKEN-TESTS] Cover the EEXIST winner-reuse and create-path ELOOP branches`

- **State at review:** OPEN; head `b19e490`; test-only, +58/−0 in
  `test/gateway-token.test.ts`.
- **Independent review:** **APPROVE**. The first test simulates another
  process winning the `O_EXCL` create after the initial read missed, forces
  `EEXIST`, and asserts the returned token is the winner's bytes and the file
  is left untouched. The second forces `ELOOP` from the create itself and
  asserts `GatewayTokenFileError` plus no file and no token. Both mock
  `fs.openSync` only for `O_EXCL` and restore it.
- **Residual non-blocking:** none beyond the existing POSIX-mode caveat.
- **Non-vacuity correction:** the contract expected this EEXIST test to fail on
  pre-#87 `10e9f3c`, but the `if (raced) return raced` branch pre-dates #87 and
  behaves identically, so the test passes on the old base by design. It is
  mutation-verified instead (`return token` mutation fails). The create-path
  ELOOP test does fail on `10e9f3c` with the raw `ELOOP` error.
- **Merged:** `ac1fd79`; CI green on the reviewed head. Zero unresolved
  threads.

## PR #95 — `[SUPER-AGENT][METRICS-ASSERTIONS] Make the live-relaxed counter assertions meaningful offline`

- **State at review:** OPEN; head `11313cd`; test-only, +16/−4 in
  `test/metrics.test.ts`.
- **Independent review:** **APPROVE**. The test now branches on
  `runtime.model.name === 'MockModel'`: offline asserts exact counts for
  `speculate.deliver`, `watchdog.idle`, and `watchdog.nudge`; the live branch
  keeps the prior presence/`>= 1` assertions. This closes the residual
  tautology recorded in the #91 review under the offline fixture.
- **Residual non-blocking:** the live branch remains inherently
  nondeterministic; it is not exercised by CI without credentials.
- **Merged:** `f8554cc`; CI green on the reviewed head. Zero unresolved
  threads.

## PR #109 — `[SUPER-AGENT][STALE-GATEWAY-TOKEN] Implement ADR-009 stale-empty diagnostics and fail-closed client read`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN; head `97fa166`; files `src/gateway/token.ts`,
  `test/gateway-token.test.ts`, `docs/GATEWAY.md`,
  `docs/ARCHITECTURE_DECISIONS.md`. Squash-merged as `064ab06`.
- **Independent review:** **APPROVE**, no blocking findings. `readTokenFile`
  throws the new internal `GatewayTokenEmptyFileError` (a subclass of
  `GatewayTokenFileError`) when the file exists but holds only zero-length or
  whitespace, with a diagnostic that tells the operator to remove it to mint a
  new token. The `writeTokenFile` EEXIST path re-reads and maps only the empty
  subclass to `was created concurrently and is empty`, so a genuine race keeps
  its own message and any other read error propagates. `readGatewayToken` now
  fails closed on a present empty file, while an absent file still falls back
  to minting; an explicit `DS_AGENT_GATEWAY_TOKEN` or CLI override still wins
  and leaves the file alone. Seven regression tests cover both empty shapes,
  the client fail-closed path via `createModelFromEnv`, a valid-token control,
  absent-file fallback, explicit-token bypass, override behavior, and the
  preserved concurrent-race message. The ADR and GATEWAY docs were updated to
  match; `ensurePrivateMode` still tightens a loose mode to 0600 before the
  error, as the reviewed ADR states.
- **Non-blocking observation:** the squash commit subject (`064ab06`) does not
  carry the `[SUPER-AGENT][STALE-GATEWAY-TOKEN]` prefix present in the PR
  title. No CI or branch rule enforces the prefix; noted for process hygiene.
- **Merged:** `064ab06`. CI `typecheck and test` green on the reviewed head
  (run `41797511158`); zero unresolved threads. Post-merge `main` CI run
  `41797671287`: 489 passed / 15 skipped (504), 82.80% statements/lines,
  81.56% branches, 90.98% functions.

## PR #112 — `[SUPER-AGENT][SEMANTIC-LTM] Evaluate semantic and multi-hop long-term memory recall`

- **Author:** LofiSu (implementer agent)
- **State at review:** OPEN; reviewed head `15f7de1`, then updated onto `main`
  (`648eec9`) producing head `c7761ff`. Files:
  `docs/ARCHITECTURE_DECISIONS.md` (+163), `docs/MODULES.md` (+11),
  `docs/ROADMAP.md` (+2/−2), `test/memory-recall-eval.test.ts` (+554).
  Squash-merged as `f6e5972`.
- **Independent review:** **APPROVE**, no blocking findings. ADR-010 is
  evidence-first: it pins an offline corpus (14 redacted entries), 11 labelled
  positive queries across exact, word-order, paraphrase, tag-only, and
  multi-hop, and two negative controls, and it runs the real `query()` path on
  a temp SQLite store with a fixed clock. I reproduced the targeted suites
  locally (20 passed / 2 files) and re-derived the reported baseline from the
  test: macro recall@3 4/11, exact 2/2, word order 2/2, paraphrase 0/3,
  tag-only 0/2, multi-hop 0/2; negative controls empty. Candidate strategies
  are evaluation-only over the same corpus: normalization + synonym map 7/11,
  plus tag-aware one-hop expansion 11/11, mock embedding and hybrid also 11/11
  with zero incremental recall, which justifies keeping embeddings
  unimplemented behind a port boundary. The ADR keeps the security invariants
  explicit (reader ticket required, per-hit spill grant, redaction before
  storage, no id-as-capability) and states the corpus/synthetic and
  month-scale limitations.
- **Non-blocking observations:** the ROADMAP M6 evidence cell names the new
  test in prose but does not add `test/memory-recall-eval.test.ts` to its file
  list; the corpus is small and synthetic, so ADR-010 requires at least 10
  held-out queries and a 1000-entry fixture before the follow-up ships.
- **Merged:** `f6e5972`. CI `typecheck and test` green on the updated head
  `c7761ff` (run `41800074122`); zero unresolved threads.

## PR #123 — `[SUPER-AGENT][A2A-HTTP] Authenticated HTTP transport`

- **Reviewed head:** `9130d4c` / `98020c9`. **Merged:** `7a1d732`.
- **Verdict:** APPROVE (security). HMAC binds peer + timestamp + nonce + body;
  ±60 s skew, 32-byte minimum secret, replay cache, 64 KiB request / 128 KiB
  response caps, deadlines, TLS/loopback guard.

## PR #124 — `[SUPER-AGENT][LIFECYCLE] Persist lifecycle events and replay on restart`

- **Reviewed head:** `7487e5c`. **Merged:** `888f810`.
- **Verdict:** APPROVE after retention/Store API/reporter fixes; schema v3 with
  `schema_migrations`, bounded replay, restart recovery tests.

## PR #126 — `[SUPER-AGENT][SECURITY] Threat model for A2A, mesh, and local UI`

- **Reviewed head:** final docs head before `6db42b7`. **Merged:** `6db42b7`.
- **Verdict:** APPROVE after status/citation corrections. Verified implemented
  A2A and lifecycle citations against merged code; documented the then-planned
  UI requirements. Superseded by the final SECURITY update for merged UI/mesh.

## PR #128 — `[SUPER-AGENT][MODEL-SLOW-PATH] Opt-in model policy with rule fallback`

- **Reviewed head:** `a482d34` after fixes. **Merged:** `788be60`.
- **Verdict:** APPROVE. REQUEST_CHANGES first: model reason strings could inject
  terminal/log control characters, and concurrent `ingestAsync` calls could
  spill twice after the policy await. Fixed with `clampPolicyReason` stripping
  `\p{Cc}\p{Cf}` and a post-await duplicate recheck; verified focused 77 and
  full offline 545 passed/3 skipped. Sync `ingest` and A2A inbound stay
  rules-only; `TriggerTrust.admission` cannot be supplied by trigger metadata.

## PR #130 — `[SUPER-AGENT][MESH] Remote registry, heartbeat, and A2A dispatch`

- **Reviewed head:** `fd18bde`. **Merged:** `d9ded0b`.
- **Verdict:** APPROVE after two fix rounds. Findings: weak secrets accepted,
  URL userinfo leak, unbounded nodes/addresses, future heartbeat pinning,
  stale assignment capacity leak, loopback registration SSRF, and async
  `onAssignment` thenable. Fixed with 32-byte secret enforcement, URL credential
  rejection, `maxNodes`/`maxAddresses` bounds, future-skew rejection, stale
  release, `allowLoopbackRegistration` default false, and a synchronous
  callback type. No default listener.

## PR #131 — `[SUPER-AGENT][OPS] WAL-safe backup/restore, release checks, runbooks`

- **Reviewed head:** `decd33d` / `61128d7`. **Merged:** `d67731a`.
- **Verdict:** APPROVE after fixes. Findings: restore could destroy an existing
  store without force/pre-restore backup; WAL sidecars were removed before the
  rename; no integrity checks; backup could delete a race-created output.
  Fixed with force gating, pre-restore set + rollback, source/temp integrity
  checks, SHA-256, unique temp + `linkSync` install that preserves a race-created
  output, and directory fsync. Focused 30/30; full offline 629 passed/3 skipped.

## PR #129 — `[SUPER-AGENT][LOCAL-UI] Read-only loopback UI`

- **Reviewed head:** `ab73604`. **Merged:** `123ee40`.
- **Verdict:** APPROVE after several rounds. Required token (≥16 chars,
  constant-time digest compare), Host guard, auth-before-routing, GET-only,
  outbox text omission, speculative-ticket filtering (tickets, outbox, events,
  threads), lifecycle-event per-kind whitelist, `referrer-policy: no-referrer`,
  per-request `readMetrics`, and bounded SSE drain/backpressure. CodeRabbit
  findings on the thread subscription leak, stale metrics, and SSE were fixed
  and threads resolved; final head CI green.

## PR #133 — `[SUPER-AGENT][CHANNELS] Run Feishu and iMessage together`

- **Reviewed head:** `ffef7d1`. **Merged:** `0cdea17`.
- **Verdict:** APPROVE. Both configs validate before `Runtime.create`; loops have
  independent abort controllers/cursors/outboxes over one store; both adapters
  are passed to each `Outbox` so rows route by `channel` and `claimOutbox`
  prevents double sends; TCC denial is terminal only for iMessage. Focused 22/22
  and CI green; no live send.

## PR #135 — `[SUPER-AGENT][MODEL-SLOW-PATH] Apply the slow path to channel loops`

- **Reviewed head:** `096e83c`. **Merged:** `268809d`.
- **Verdict:** APPROVE. Both loops now await `Runtime.ingestAsync`; cursor writes
  still occur after the disposition, fallback does not reject or skip, and A2A
  stays sync. The initial head broke two serve-test spies; the agent updated
  them to `ingestAsync` without weakening assertions. CI-equivalent full suite
  709 passed/15 skipped/0 failed.

## PR #136 / #138 — `[SUPER-AGENT][CLI-WIRING] Expose ui, backup, restore`

- **#136 merged:** `1e01862` (squash by another session before the final
  accuracy commit). **#138:** usage accuracy follow-up, reviewed head `33b0941`.
- **Verdict:** APPROVE for the wiring (token/loopback enforcement stays in
  `runUi`; restore force gate untouched). #136's help/README showed `backup
  --out` as optional and `restore --input` rather than positional; #138 fixes
  the text and adds assertions.

- **#138 merged:** `58c410a` after CI green on `33b0941` (run `41845978818`);
  no unresolved threads. #132 remains owner-gated.

## PR #132 — `[SUPER-AGENT][RELEASE] Add manual release-check workflow`

- **Reviewed head:** `21cc421`. **Merged by another session:** `a1985c0`
  (2026-11-04T12:35:21Z).
- **Verdict:** not approved for merge by this session; the PR was owner-gated
  and held. No review or owner approval is recorded on the PR (`reviews: []`).
- **Post-merge audit:** `workflow_dispatch` only; `permissions: contents: read`;
  no `secrets.*`; no publish step; artifact upload only. Exact head
  `typecheck and test` green. The content is low-risk, but the merge is a
  process deviation and is not retroactively approved.

## PR #134 — `[SUPER-AGENT][IMESSAGE] Read nanosecond dates as BigInt`

- **Head:** `56cb001`. **Merged by another session:** `111481d`.
- **Review:** none in this log; merged before this session reviewed it.
  `typecheck and test` green on the exact head. Regression test uses a real
  nanosecond timestamp.

## PR #139 — `[SUPER-AGENT][IMESSAGE] Send non-ASCII replies via argv`

- **Head:** `50cf9d1`. **Merged by another session:** `af6b011`.
- **Review:** none in this log; merged before this session reviewed it.
  `typecheck and test` green on the exact head. The change passes reply text as
  an osascript argv item instead of an env/system-attribute path.

## PR #140 — `[SUPER-AGENT][IMESSAGE] Suppress canned acknowledgement in chats`

- **Head:** `69a243c`. **Merged by another session:** `661e56d`.
- **Review:** none in this log; merged before this session reviewed it.
  `typecheck and test` green on the exact head and in post-merge main CI run
  `41848077717`. Adds a reply-layer guard plus an outbox regression test; no
  live send was performed.

## Pending reviews

- No open implementation PRs. #141 is documentation-only and awaits CI/review.
- Live bake-off and real Feishu acceptance are evidence tasks, not PRs.
