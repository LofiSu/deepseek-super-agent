export const REASONS = {
  noise: 'noise',
  noIntent: 'no-intent',
  source: 'source-not-allowlisted',
  accepted: 'accepted',
  speculative: 'speculative',
  handback: 'handback',
} as const

export type ReasonCode = typeof REASONS[keyof typeof REASONS]
