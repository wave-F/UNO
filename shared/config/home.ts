/**
 * Up to 4 player homes at arena corners (XZ plane).
 * Slot order is fixed so clients/servers agree without extra sync.
 *
 *   slot 2 (−x,+z)  |  slot 3 (+x,+z)
 *   ----------------+----------------
 *   slot 0 (−x,−z)  |  slot 1 (+x,−z)
 */
export const HOME_SLOT_COUNT = 4

export type HomeSlotDef = {
  index: number
  /** World center of platform. */
  center: { x: number; y: number; z: number }
  /** Body spawn above platform. */
  spawn: { x: number; y: number; z: number }
  /** Platform + accent (soft-play palette). */
  platformColor: number
  accentColor: number
  flagColor: number
  /** Short corner name for labels. */
  cornerName: string
}

const CORNER = 14
const SPAWN_Y = 2.2

export const homeSlots: readonly HomeSlotDef[] = [
  {
    index: 0,
    center: { x: -CORNER, y: 0, z: -CORNER },
    spawn: { x: -CORNER, y: SPAWN_Y, z: -CORNER },
    platformColor: 0xfbbf24,
    accentColor: 0xf97316,
    flagColor: 0xef4444,
    cornerName: '西南',
  },
  {
    index: 1,
    center: { x: CORNER, y: 0, z: -CORNER },
    spawn: { x: CORNER, y: SPAWN_Y, z: -CORNER },
    platformColor: 0x60a5fa,
    accentColor: 0x2563eb,
    flagColor: 0x3b82f6,
    cornerName: '东南',
  },
  {
    index: 2,
    center: { x: -CORNER, y: 0, z: CORNER },
    spawn: { x: -CORNER, y: SPAWN_Y, z: CORNER },
    platformColor: 0xa78bfa,
    accentColor: 0x7c3aed,
    flagColor: 0x8b5cf6,
    cornerName: '西北',
  },
  {
    index: 3,
    center: { x: CORNER, y: 0, z: CORNER },
    spawn: { x: CORNER, y: SPAWN_Y, z: CORNER },
    platformColor: 0x34d399,
    accentColor: 0x059669,
    flagColor: 0x10b981,
    cornerName: '东北',
  },
] as const

/** Death lock after stepping into an active home electric fence (ms). */
export const HOME_FENCE_DEATH_MS = 5000

export const homeConfig = {
  /** Shared platform half-extent (full size = halfSize * 2). */
  halfSize: 4.2,
  /** Keep field spawns outside this radius from each home center. */
  cardSpawnClearRadius: 7,
  /** Offline / default slot (SW). */
  defaultSlot: 0,
  /** @deprecated use getHomeSlot(0).center — kept for short call sites */
  center: homeSlots[0]!.center,
  spawn: homeSlots[0]!.spawn,
  /** Respawn delay after fence electrocution. */
  fenceDeathMs: HOME_FENCE_DEATH_MS,
} as const

export function getHomeSlot(index: number): HomeSlotDef {
  const i = ((index % HOME_SLOT_COUNT) + HOME_SLOT_COUNT) % HOME_SLOT_COUNT
  return homeSlots[i]!
}

export function isInsideHomeSlot(slotIndex: number, x: number, z: number): boolean {
  const { center } = getHomeSlot(slotIndex)
  const h = homeConfig.halfSize
  return Math.abs(x - center.x) <= h && Math.abs(z - center.z) <= h
}

/** Any of the 4 corner homes (spawn exclusion / zone checks). */
export function isInsideAnyHome(x: number, z: number): boolean {
  for (let i = 0; i < HOME_SLOT_COUNT; i++) {
    if (isInsideHomeSlot(i, x, z)) return true
  }
  return false
}

/** Offline single-player: only the default corner is "your home". */
export function isInsideHome(x: number, z: number): boolean {
  return isInsideHomeSlot(homeConfig.defaultSlot, x, z)
}

/** True if (x,z) is inside `slotIndex` home and not another player's. */
export function isInsideOwnedHome(slotIndex: number, x: number, z: number): boolean {
  return isInsideHomeSlot(slotIndex, x, z)
}
