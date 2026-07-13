/** Home base in the bottom-left corner of the arena (min X / min Z). */
export const homeConfig = {
  /** Center of home platform. */
  center: { x: -14, y: 0, z: -14 },
  /** Platform half-size on XZ (full size = 2 * half). */
  halfSize: 4.2,
  /** Player spawn (standing on platform). */
  spawn: { x: -14, y: 2.2, z: -14 },
  /** Soft padding so cards don't spawn inside home. */
  cardSpawnClearRadius: 7,
} as const

export function isInsideHome(x: number, z: number): boolean {
  const { center, halfSize } = homeConfig
  return (
    Math.abs(x - center.x) <= halfSize && Math.abs(z - center.z) <= halfSize
  )
}
