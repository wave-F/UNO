import { isStunBat, type UnoCardData } from './types.ts'

/**
 * Backpack stack only (numbers). Item/stun cards never enter the stack
 * and are not subject to color/rank order.
 */
export function canStackOn(top: UnoCardData, next: UnoCardData): boolean {
  if (isStunBat(next) || isStunBat(top)) return false
  if (!top.color || !next.color) return false
  return next.color === top.color || next.rank === top.rank
}

/** Field item pickup: only into empty hand slot (not backpack); free of stack order. */
export function canPickupItem(hasItem: boolean, card: UnoCardData): boolean {
  return isStunBat(card) && !hasItem
}
