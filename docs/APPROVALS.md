# Approvals

An approval is a Worker asking the owner, mid-task, whether it may perform one
exact action that leaves the workspace or is hard to undo: send a message,
publish, delete, spend, or change something outside the sandbox.

The model can request approval. It cannot approve, deny, or edit a request. The
owner decides.

## Flow

1. The Worker is about to do something on the rules layer's approval boundary.
   Instead of doing it, it calls `request_approval` with the exact action and a
   one-line reason.
2. The Engine records a pending approval on the Ticket and the Worker stops.
   This is a **hold**, not a human pause: the Router can still speak, so it can
   ask the question.
3. The tool asks the Router to tell the owner what needs approval. The Router
   gets the action, the reason, and the approval id.
4. The owner runs `ds-agent approvals`, then `ds-agent approve` or
   `ds-agent deny`.
5. The decision is stored with the note and timestamp, guidance is written for
   the Worker, and the Harness starts the normal RESUME turns. The Worker sees
   the decision as guidance before it acts again.

```
Worker ── request_approval ──▶ pending on Ticket ──▶ Router asks owner
   ▲                                                      │
   └──── RESUME + decision guidance ◀── approve / deny ◀──┘
```

## CLI

```bash
ds-agent approvals                     # pending requests across live tickets
ds-agent approvals --json
ds-agent approve <ticketId> <approvalId> [--note "ship it"]
ds-agent deny <ticketId> <approvalId> [--note "use the staging bucket"]
ds-agent collab <ticketId>             # pending and decided requests on one ticket
```

`ticketId` accepts an exact id, a unique prefix, or `latest`.

## Safety semantics

- **One pending request per ticket.** A second request is refused; the Worker
  must wait for the first decision.
- **Requests and pauses are separate.** A human pause (`ds-agent pause`) still
  blocks replies. An approval hold does not, because the question has to reach
  the owner. A paused ticket cannot request approval.
- **The decision is checked, not inferred.** Approving requires the exact
  approval id and only works while it is pending. A second decision is refused.
  Chat text such as "yes, go ahead" does **not** approve anything; the owner
  must run the command. This is deliberate: the model cannot manufacture
  consent from a message it read.
- **Guidance is injected once.** Approved: "Proceed with exactly that action."
  Denied: "Do not perform it; report what you did instead and what you need."
- **The Watchdog treats an approval wait as intentional idle.** A Worker waiting
  on the owner is not a stuck worker and is not failed or nudged as stale.
- **Follow-ups are preserved.** The approval wait is recorded as a resume point,
  so messages the owner sends while the request is pending are included in the
  RESUME prompt.
- **No approval token exists.** The Worker cannot present a token to a tool to
  unlock a capability; the hold is enforced by Worker turns stopping before the
  next model or tool call.

## Limits

- Decisions are CLI-only. A channel adapter cannot approve yet; wiring a
  channel reply to the command requires an authenticated owner identity and a
  signed approval, which is a later change.
- Approving resumes the ticket, which starts model turns. Like `ds-agent resume`,
  `approve` and `deny` require a configured live model; without one the command
  fails before deciding, so guidance is not consumed by a mock. There is no
  "approve but keep paused" mode.
- `ds-agent approvals` lists live tickets only. A pending request on an ended
  ticket is stale and is not shown; `collab` still shows the history.
- The action is a description, not a structured action id. The Worker is trusted
  to describe the action it will perform, and the rules layer still governs what
  tools can do.
- A routine, local specialist agent, or team does not get its own approval
  channel; if the Work needs one, it goes through the same Worker path.
