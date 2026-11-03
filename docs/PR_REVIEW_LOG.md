# PR review log

Independent reviews by the Chief Engineer. A passing CI run is necessary but not
sufficient. Verdicts: **APPROVE** (may carry non-blocking follow-ups) /
**REQUEST_CHANGES** / **REJECT** / **BLOCKED**.

Provenance: this log records the orchestrator's independent review verdicts.
GitHub review objects were not submitted for #75–#84; the external evidence is
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

## PR #74 — `docs: record the final 2026-11-03 audit on main`

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

## PR #74 — `docs: record the final audit on main`

- **Author:** LofiSu (agent-assisted)
- **State at review:** initial head `cb6cdf2` (+34/−8); corrections pushed as
  `3119369` (+36/−9); docs/ROADMAP.md and docs/MODULES.md only; CI passed on
  both heads.
- **Independent review:** **REQUEST_CHANGES**. The revision row claimed
  "#75–#84 merged" although #83 is still open, and the `34aef25` headline
  evidence is not in `docs/PROJECT_AUDIT.md` on `main` (main's audit doc still
  carries the `bb11c96` baseline). The numbers match #83's unmerged audit, so
  they are not fabricated, but they are not yet the documented main-tree
  evidence.
- **Resolution:** merge #83 first, then rebase/refresh #74 on the new `main` and
  re-run the scoped review. Also correct "§1 status board" to §7, mark §5 as
  last fully re-checked at `fa974ca`, and update the PR body diff counts.
- **Verdict:** **REQUEST_CHANGES** (re-review pending).

## Pending reviews

- PR #74 re-review after #83 merges
- PR #85 (`agent/P1-6-restart-recovery`)
