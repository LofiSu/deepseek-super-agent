/**
 * Test-harness fault injection only (CI + marked homes).
 * Production users cannot forge receipts via this path without CI env + home prefix.
 */
export function assertEvolutionTestFault(home: string, phase: 'hang_after_claim'): never | void {
  if (process.env.CI !== 'true') return
  if (process.env.DS_AGENT_EVOLUTION_TEST_FAULT !== phase) return
  if (!home.includes('evo-fault-')) return
  if (phase === 'hang_after_claim') {
    process.exit(86)
  }
}
