import type { UnoCardData } from './types.ts'

/**
 * Number-only UNO stack rule:
 * next is legal if same color OR same number.
 */
export function canStackOn(top: UnoCardData, next: UnoCardData): boolean {
  return next.color === top.color || next.rank === top.rank
}
