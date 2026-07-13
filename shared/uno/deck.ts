import type { UnoCardData, UnoColor, UnoRank } from './types.ts'

const COLORS: UnoColor[] = ['red', 'yellow', 'green', 'blue']
const NUMBERS: UnoRank[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

let idSeq = 0

function nextId(): string {
  idSeq += 1
  return `card_${idSeq}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Number cards only (4 colors × 0–9).
 */
export function createRandomCards(count: number, rng = Math.random): UnoCardData[] {
  const pool: UnoCardData[] = []

  for (const color of COLORS) {
    for (const rank of NUMBERS) {
      pool.push({ id: nextId(), color, rank })
      if (rank !== '0') {
        pool.push({ id: nextId(), color, rank })
      }
    }
  }

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }

  return pool.slice(0, count).map((c) => ({ ...c, id: nextId() }))
}
