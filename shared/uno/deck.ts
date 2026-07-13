import {
  isStunBat,
  type UnoCardData,
  type UnoColor,
  type UnoRank,
} from './types.ts'

const COLORS: UnoColor[] = ['red', 'yellow', 'green', 'blue']
const NUMBERS: UnoRank[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

/** Default field mix: mace disabled for now; skip occasional. */
export const DEFAULT_STUN_FRACTION = 0
export const DEFAULT_SKIP_FRACTION = 0.08

let idSeq = 0

function nextId(): string {
  idSeq += 1
  return `card_${idSeq}_${Math.random().toString(36).slice(2, 8)}`
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

function randomColor(rng: () => number): UnoColor {
  return COLORS[Math.floor(rng() * COLORS.length)]!
}

function randomNumberCard(rng: () => number): UnoCardData {
  const color = randomColor(rng)
  const rank = NUMBERS[Math.floor(rng() * NUMBERS.length)]!
  return { id: nextId(), color, rank, kind: 'number' }
}

/** Colorless special — hand item (狼牙棒). */
function randomStun(_rng: () => number): UnoCardData {
  return {
    id: nextId(),
    color: null,
    rank: 'stun',
    kind: 'stun_bat',
  }
}

/** Colorless special — hand item (Skip trap). */
function randomSkip(_rng: () => number): UnoCardData {
  return {
    id: nextId(),
    color: null,
    rank: 'skip',
    kind: 'skip_trap',
  }
}

/**
 * Field spawn mix.
 * Default ~8% stun + ~8% skip (no forced minimums); rest numbers.
 * Pass stunFraction:0 and skipFraction:0 for pure numbers (e.g. training dummy).
 */
export function createRandomCards(
  count: number,
  rng = Math.random,
  opts?: { stunFraction?: number; skipFraction?: number },
): UnoCardData[] {
  if (count <= 0) return []

  const stunFraction = opts?.stunFraction ?? DEFAULT_STUN_FRACTION
  const skipFraction = opts?.skipFraction ?? DEFAULT_SKIP_FRACTION

  let stunCount = stunFraction > 0 ? Math.round(count * stunFraction) : 0
  let skipCount = skipFraction > 0 ? Math.round(count * skipFraction) : 0

  // Fit into count (prefer keeping numbers if over)
  while (stunCount + skipCount > count) {
    if (skipCount >= stunCount && skipCount > 0) skipCount--
    else if (stunCount > 0) stunCount--
    else break
  }

  const numCount = count - stunCount - skipCount
  const result: UnoCardData[] = []
  for (let i = 0; i < numCount; i++) result.push(randomNumberCard(rng))
  for (let i = 0; i < stunCount; i++) result.push(randomStun(rng))
  for (let i = 0; i < skipCount; i++) result.push(randomSkip(rng))

  return shuffle(result, rng)
}

export function createStunBat(): UnoCardData {
  return { id: nextId(), color: null, rank: 'stun', kind: 'stun_bat' }
}

export function createSkipTrap(): UnoCardData {
  return { id: nextId(), color: null, rank: 'skip', kind: 'skip_trap' }
}

export { isStunBat }
