/** Triggers that landed on one thread since the last Eval form one batch. */
export function nextBatch(pending: readonly string[]): string[] {
  return [...pending]
}

export interface BatchHook {
  onQueued(threadKey: string, triggerId: string, pending: readonly string[]): void
}
