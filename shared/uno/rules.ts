import { isHandItem, isStunBat, type UnoCardData } from './types.ts'

/**
 * Backpack stack only (numbers). Item cards never enter the stack
 * and are not subject to color/rank order.
 */
export function canStackOn(top: UnoCardData, next: UnoCardData): boolean {
  if (isHandItem(next) || isHandItem(top)) return false
  if (!top.color || !next.color) return false
  return next.color === top.color || next.rank === top.rank
}

/** Field item pickup: only into empty hand slot (not backpack); free of stack order. */
export function canPickupItem(hasItem: boolean, card: UnoCardData): boolean {
  return isHandItem(card) && !hasItem
}

export { isHandItem, isStunBat }
