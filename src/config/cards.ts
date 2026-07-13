/** World card spawn / density. */
export const cardSpawnConfig = {
  /** Cards present when the match starts. */
  initialCount: 6,
  /** Max cards allowed on the field at once. */
  maxOnField: 14,
  /** Seconds between spawn waves. */
  spawnIntervalSec: 4.5,
  /** How many new cards per wave (clamped by maxOnField). */
  spawnPerWave: 2,
} as const
