import { isStunBat, type UnoCardData, type UnoColor, type UnoRank } from './types.ts'

const COLORS: UnoColor[] = ['red', 'yellow', 'green', 'blue']
const NUMBERS: UnoRank[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

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

/** Colorless special function card — not part of UNO color/stack order. */
function randomStun(_rng: () => number): UnoCardData {
  return {
    id: nextId(),
    color: null,
    rank: 'stun',
    kind: 'stun_bat',
  }
}

/**
 * Field spawn mix.
 * Testing-friendly: ~40% stun so they appear often.
 * (Later tune stunFraction down for balance.)
 */
export function createRandomCards(
  count: number,
  rng = Math.random,
  opts?: { stunFraction?: number },
): UnoCardData[] {
  if (count <= 0) return []

  const stunFraction = opts?.stunFraction ?? 0.4
  let stunCount = Math.round(count * stunFraction)
  // Testing floors only when stun is actually wanted (fraction > 0).
  // stunFraction: 0 must stay pure numbers (e.g. training dummy backpack).
  if (stunFraction > 0) {
    // At least 1 stun when spawning 2+ cards; at least 2 when initial 6+
    if (count >= 2) stunCount = Math.max(1, stunCount)
    if (count >= 6) stunCount = Math.max(2, stunCount)
  } else {
    stunCount = 0
  }
  stunCount = Math.min(count, stunCount)
  const numCount = count - stunCount

  const result: UnoCardData[] = []
  for (let i = 0; i < numCount; i++) result.push(randomNumberCard(rng))
  for (let i = 0; i < stunCount; i++) result.push(randomStun(rng))

  return shuffle(result, rng)
}

export function createStunBat(): UnoCardData {
  return { id: nextId(), color: null, rank: 'stun', kind: 'stun_bat' }
}

export { isStunBat }
