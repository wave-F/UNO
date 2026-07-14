/** World card spawn / density (client + server). */
export const cardSpawnConfig = {
  /** Cards on field when match starts (numbers only; no auto mace/Skip). */
  initialCount: 10,
  maxOnField: 18,
  /** Seconds between spawn waves. */
  spawnIntervalSec: 3,
  /** Inclusive random range for cards per wave. */
  spawnPerWaveMin: 1,
  spawnPerWaveMax: 2,
} as const

/** Random cards for one wave, clamped to remaining field capacity. */
export function cardsForSpawnWave(roomLeft: number): number {
  if (roomLeft <= 0) return 0
  const lo = cardSpawnConfig.spawnPerWaveMin
  const hi = cardSpawnConfig.spawnPerWaveMax
  const roll = lo + Math.floor(Math.random() * (hi - lo + 1))
  return Math.min(roll, roomLeft)
}

/** Horizontal pickup radius (meters, XZ). */
export const CARD_PICKUP_RADIUS = 2.0
