/** World card spawn / density (client + server). */
export const cardSpawnConfig = {
  initialCount: 6,
  maxOnField: 14,
  spawnIntervalSec: 4.5,
  spawnPerWave: 2,
} as const

/** Horizontal pickup radius (meters, XZ). */
export const CARD_PICKUP_RADIUS = 2.0
