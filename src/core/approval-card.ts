import type { ApprovalRequest } from '../shared/types.ts'
import { approvalActionId } from './collab.ts'

/**
 * The three answers a card accepts. They are CLI commands, not tool calls and
 * not chat replies: a model can put a card in front of the owner, never answer
 * it. `dismiss` closes the card without authorizing; `deny` records a refusal.
 */
export const APPROVAL_ANSWERS = ['approve', 'deny', 'dismiss'] as const

export type ApprovalAnswer = typeof APPROVAL_ANSWERS[number]

/**
 * Render the exact card an owner decides on. The action line is the stored,
 * sanitized text byte-for-byte; `actionId` is derived from it. Callers may
 * re-render at any time and get the same id until the action text changes.
 */
export function formatApprovalCard(approval: ApprovalRequest, indent = ''): string {
  // Legacy cards from before the id existed are rendered with the id the
  // decision would derive, so the display and the check stay consistent.
  const actionId = approval.actionId || approvalActionId(approval.action)
  const lines = [
    `${indent}${approval.id}  [${approval.status}]  ${actionId}`,
    `${indent}  action: ${approval.action}`,
  ]
  if (approval.reason) lines.push(`${indent}  reason: ${approval.reason}`)
  if (approval.note) lines.push(`${indent}  note: ${approval.note}`)
  if (approval.fillState && approval.fillState !== 'completed') {
    lines.push(`${indent}  fill outcome: ${approval.fillState}; request a new owner approval before retrying`)
  }
  if (approval.usedAt) lines.push(`${indent}  used by fill: ${approval.usedAt}`)
  lines.push(`${indent}  answers: ${APPROVAL_ANSWERS.join(' | ')}`)
  return lines.join('\n')
}
