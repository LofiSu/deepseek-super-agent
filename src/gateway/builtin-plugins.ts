/**
 * Built-in router-strategy plugin. Mirrors Magpie's "rotation" plugin: the
 * routings besides the core Smart order live here, not in the router core.
 *
 * `priority` — highest provider priority first, cooling providers last.
 * `free`     — cheapest seat first when a seat carries a cost, else priority.
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

export function strategyPlugin(): GatewayPlugin {
  return {
    id: 'rotation',
    strategies: {
      priority: seats => byPriority(seats),
      smart: seats => byPriority(seats),
    },
  }
}
