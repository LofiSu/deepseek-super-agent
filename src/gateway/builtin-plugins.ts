/**
 * Built-in router-strategy plugin (mirrors Magpie's "rotation" plugin): the
 * routings besides the core Smart order live here, not in the router core.
 *
 * priority — highest provider priority first; cooling providers last.
 * usage    — least-used provider first (from the usage ledger).
 * free     — cheapest provider first (provider `cost`).
 * fast     — lowest observed average latency first.
 */

import type { GatewayPlugin, RouteSeat } from './plugins.ts'

function byPriority(seats: RouteSeat[]): number[] {
  return [...seats]
    .sort((left, right) => {
      if (left.cooling !== right.cooling) return left.cooling ? 1 : -1
      return right.priority - left.priority || left.index - right.index
    })
    .map(seat => seat.index)
}

function orderBy(seats: RouteSeat[], compare: (left: RouteSeat, right: RouteSeat) => number): number[] {
  return [...seats]
    .sort((left, right) => {
      if (left.cooling !== right.cooling) return left.cooling ? 1 : -1
      return compare(left, right) || right.priority - left.priority || left.index - right.index
    })
    .map(seat => seat.index)
}

export function strategyPlugin(): GatewayPlugin {
  return {
    id: 'rotation',
    strategies: {
      priority: seats => byPriority(seats),
      smart: seats => byPriority(seats),
      usage: seats => orderBy(seats, (left, right) => (left.requests ?? 0) - (right.requests ?? 0)),
      free: seats => orderBy(seats, (left, right) => (left.cost ?? 0) - (right.cost ?? 0)),
      fast: seats => orderBy(seats, (left, right) => {
        const leftLatency = left.avgLatencyMs ?? Number.POSITIVE_INFINITY
        const rightLatency = right.avgLatencyMs ?? Number.POSITIVE_INFINITY
        return leftLatency - rightLatency
      }),
    },
  }
}
