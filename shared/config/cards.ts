/** World card spawn / density (client + server). */
export const cardSpawnConfig = {
  /** Cards on field when match starts (numbers only; no auto mace/Skip). */
  initialCount: 10,
  maxOnField: 18,
  /** Seconds between spawn waves. */
  spawnIntervalSec: 4,
  /** Cards per wave. */
  spawnPerWave: 2,
} as const

/** Horizontal pickup radius (meters, XZ). */
export const CARD_PICKUP_RADIUS = 2.0
