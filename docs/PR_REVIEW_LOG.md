# PR review log

Independent reviews by the Chief Engineer. A passing CI run is necessary but not
sufficient. Verdicts: **APPROVE** (may carry non-blocking follow-ups) /
**REQUEST_CHANGES** / **REJECT** / **BLOCKED**.

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
  `fa974ca`; `main` has since merged `#64` (`bb11c96`), `#78` (`cb32a17`), and
  `#75`/`#76`/`#77` (`03a4c02`). The 302 tests / 82.40% coverage evidence is
  stale, and the header and §2/§3 matrices still say `fa974ca`.
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
- **Non-blocking findings:** token-file reads follow symlinks
  (`src/gateway/token.ts:25-63`); fail-closed chmod, SSE header, identical-401,
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
- **Verdict:** pending independent review. Re-check the aggregation query, page
  boundary behavior, missing/ambiguous metadata, and that a group message can
  never become `direct`.

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
- **Verdict:** pending independent review. Check queue drain vs settle, promise
  resolution, release ordering, duplicate starts, and the direct-write removal.

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

## Pending reviews

- PR #81 iMessage group aggregation
- PR #79 mesh capacity/backpressure
- GATEWAY-TOKEN-SYMLINK follow-up
- `docs/final-audit` refresh after P1-3
- `agent/P1-6-restart-recovery` after P1-3
