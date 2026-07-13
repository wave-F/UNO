/** Shared movement rules (client + bot). */

/** Base max horizontal speed (m/s) — keep in sync with src/config/movement.ts */
export const BASE_MAX_SPEED = 7.5

/** Each card on backpack multiplies speed by (1 - this). Default 5% per card. */
export const CARRY_SPEED_PENALTY_PER_CARD = 0.05

/** Floor: never slower than half speed even with a huge backpack. */
export const CARRY_SPEED_MIN_MULT = 0.5

/** Multiplier for current backpack size: 0 cards → 1, 1 card → 0.98, … */
export function carrySpeedMultiplier(stackCount: number): number {
  const n = Math.max(0, Math.floor(stackCount))
  return Math.max(CARRY_SPEED_MIN_MULT, 1 - CARRY_SPEED_PENALTY_PER_CARD * n)
}

export function maxSpeedForCarry(stackCount: number, base = BASE_MAX_SPEED): number {
  return base * carrySpeedMultiplier(stackCount)
}
