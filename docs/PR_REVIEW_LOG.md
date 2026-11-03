# PR review log

Independent reviews by the Chief Engineer. A passing CI run is necessary but not
sufficient. Verdicts: APPROVE / REQUEST_CHANGES / REJECT / BLOCKED.

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
  `fa974ca`; `main` has since merged `#64` (`bb11c96`, 4,390 lines). The 302
  tests / 82.40% coverage evidence is stale. The header and §2/§3 matrices also
  still say `fa974ca`.
- **Verdict:** **REQUEST_CHANGES** — rebase on `bb11c96`, replace the evidence
  with the verified 372-pass / 80.68%-line run, add a #64 revision row, and state
  that the gateway/iMessage surface is included. Do not merge until green on
  the refreshed head.

## PR #64 — `feat: iMessage channel + local OpenAI-compatible gateway`

- **State:** merged before this review cycle.
- **Scope:** 46 files, 4,390 insertions, 13 test files.
- **Findings recorded after merge:**
  - IMESSAGE-ADMISSION: iMessage trigger is default-open (`addressed: 'direct'` for every
    message; `--handle` optional). Compensating control: `DS_AGENT_ACTOR_ALLOWLIST`
    exists but is not required. Fix in `agent/imessage-admission`.
  - GATEWAY-HARDENING: gateway token compare is not constant-time; empty token accepted;
    non-loopback bind unwarned; token file mode not re-checked. Fix in
    `agent/gateway-hardening`.
  - Positive: iMessage text reaches AppleScript through the environment, not
    string interpolation; outbound env is filtered; gateway token is generated
    with 24 random bytes and written 0600; provider credentials are not exposed
    by `/health`.
- **Verdict (retrospective):** **APPROVE**. No protocol-breaking defect found in
  the reviewed paths. Follow-ups are tracked as IMESSAGE-ADMISSION and
  GATEWAY-HARDENING; both must merge before this surface is called
  production-ready.

## Pending reviews

- `agent/imessage-admission`
- `agent/P1-3-mesh-backpressure`
- `agent/gateway-hardening`
- `docs/final-audit` refresh
- `GATEWAY-REVIEW` (focused security-relevant coverage)
- `agent/P1-6-restart-recovery` (after P1-3)
