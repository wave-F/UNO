/** World card spawn / density (client + server). */
export const cardSpawnConfig = {
  /** Cards on field when match starts (includes more stun bats for testing). */
  initialCount: 8,
  maxOnField: 16,
  /** Seconds between spawn waves. */
  spawnIntervalSec: 3.5,
  /** Cards per wave. */
  spawnPerWave: 3,
} as const

/** Horizontal pickup radius (meters, XZ). */
export const CARD_PICKUP_RADIUS = 2.0
