/**
 * Server-side AI: pick numbers / items → deposit → raid; use mace to chase & swing.
 */
import { maxSpeedForCarry, BASE_MAX_SPEED } from '../shared/config/movement.ts'
import { TRAINING_DUMMY_ID } from '../shared/config/dummy.ts'
import { canStackOn, canPickupItem } from '../shared/uno/rules.ts'
import {
  isHandItem,
  isStunBat,
  isSkipTrap,
  ATTACK_RANGE,
} from '../shared/uno/types.ts'
import { getHomeSlot } from '../shared/config/home.ts'
import type { GameSim } from './GameSim.ts'
import type { Seat } from './Room.ts'

const ARRIVE_EPS = 0.65
const MAX_CARRY = 3
/** How far bots will chase a target while holding a mace. */
const MACE_CHASE_RANGE = 11
/** Start wind-up when this close (slightly inside attack range). */
const MACE_ENGAGE = ATTACK_RANGE * 0.9

export const BOT_STAND_Y = 0.35 + 0.4
export const BOT_HOME_STAND_Y = 0.25 + BOT_STAND_Y

type BotMode = 'seek_field' | 'go_home' | 'raid' | 'wander' | 'hunt'

export class BotController {
  readonly seatId: string
  private mode: BotMode = 'seek_field'
  private targetX = 0
  private targetZ = 0
  private retargetT = 0
  private raidCooldown = 0
  private attackCooldown = 0
  private attackWindup = -1
  private windupTargetId: string | null = null

  constructor(seatId: string) {
    this.seatId = seatId
  }

  tick(
    dt: number,
    seat: Seat,
    game: GameSim,
    poseMap: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (!seat.pose) {
      const sp = getHomeSlot(seat.homeIndex).spawn
      seat.pose = { x: sp.x, y: BOT_HOME_STAND_Y, z: sp.z, yaw: 0, seq: 0 }
    }

    const st = game.getPlayerState(this.seatId)
    if (!st) return

    this.retargetT += dt
    this.raidCooldown = Math.max(0, this.raidCooldown - dt)
    this.attackCooldown = Math.max(0, this.attackCooldown - dt)

    if (this.retargetT > 0.28) {
      this.retargetT = 0
      this.chooseTarget(seat, game, st.stack.length, st.homeIndex, poseMap)
    }

    const px = seat.pose.x
    const pz = seat.pose.z
    const dx = this.targetX - px
    const dz = this.targetZ - pz
    const dist = Math.hypot(dx, dz)
    const standY = standingYForBot(px, pz, st.homeIndex)

    if (game.isStunned(this.seatId)) {
      seat.pose = { ...seat.pose, y: standY }
      seat.lastPoseAt = Date.now()
      return
    }

    if (dist > ARRIVE_EPS) {
      const speed = maxSpeedForCarry(st.stack.length, BASE_MAX_SPEED)
      const step = Math.min(dist, speed * dt)
      seat.pose = {
        x: px + (dx / dist) * step,
        y: standY,
        z: pz + (dz / dist) * step,
        yaw: Math.atan2(dx, dz),
        seq: (seat.pose.seq ?? 0) + 1,
      }
    } else {
      seat.pose = {
        ...seat.pose,
        y: standY,
        seq: (seat.pose.seq ?? 0) + 1,
      }
    }
    seat.lastPoseAt = Date.now()

    poseMap.set(this.seatId, {
      x: seat.pose.x,
      y: seat.pose.y,
      z: seat.pose.z,
    })
    this.tryUseItem(dt, seat, game, poseMap)
  }

  /**
   * Use hand item: place skip near foes, or wind-up + swing mace at chase target.
   */
  private tryUseItem(
    dt: number,
    seat: Seat,
    game: GameSim,
    poseMap: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (this.attackCooldown > 0) {
      this.attackWindup = -1
      this.windupTargetId = null
      return
    }
    const st = game.getPlayerState(this.seatId)
    if (!st?.item || !seat.pose) {
      this.attackWindup = -1
      this.windupTargetId = null
      return
    }

    // Skip: drop at feet when an enemy is nearby
    if (isSkipTrap(st.item)) {
      let nearEnemy = false
      for (const [id, pos] of poseMap) {
        if (id === this.seatId || id === TRAINING_DUMMY_ID) continue
        if (game.isStunned(id)) continue
        const d = Math.hypot(pos.x - seat.pose.x, pos.z - seat.pose.z)
        if (d > 0.3 && d < 3.5) {
          nearEnemy = true
          break
        }
      }
      if (!nearEnemy) {
        this.attackWindup = -1
        return
      }
      if (this.attackWindup < 0) {
        this.attackWindup = 0.2 + Math.random() * 0.35
        return
      }
      this.attackWindup -= dt
      if (this.attackWindup > 0) return
      game.tryAttack(this.seatId, seat.pose.yaw, poseMap)
      this.attackWindup = -1
      this.attackCooldown = 0.7 + Math.random() * 0.5
      return
    }

    if (!isStunBat(st.item)) {
      this.attackWindup = -1
      this.windupTargetId = null
      return
    }

    const px = seat.pose.x
    const pz = seat.pose.z
    let bestId: string | null = null
    let bestD = Infinity
    let bestDx = 0
    let bestDz = 0

    for (const [id, pos] of poseMap) {
      if (id === this.seatId) continue
      if (game.isStunned(id)) continue
      const dx = pos.x - px
      const dz = pos.z - pz
      const d = Math.hypot(dx, dz)
      if (d < 0.15 || d > ATTACK_RANGE * 1.05) continue
      const other = game.getPlayerState(id)
      // Prefer humans with cards; still hit dummy/bots
      let weight = d
      if (id === TRAINING_DUMMY_ID) weight += 0.4
      if (other && other.stack.length > 0) weight -= 1.0
      if (weight < bestD) {
        bestD = weight
        bestId = id
        bestDx = dx
        bestDz = dz
      }
    }

    if (!bestId) {
      this.attackWindup = -1
      this.windupTargetId = null
      return
    }

    const yaw = Math.atan2(bestDx, bestDz)
    seat.pose = { ...seat.pose, yaw, seq: (seat.pose.seq ?? 0) + 1 }

    if (this.windupTargetId !== bestId || this.attackWindup < 0) {
      this.windupTargetId = bestId
      // Shorter wind-up so mace sees use in tests
      this.attackWindup = 0.28 + Math.random() * 0.45
      return
    }

    this.attackWindup -= dt
    if (this.attackWindup > 0) return

    game.tryAttack(this.seatId, yaw, poseMap)
    this.attackWindup = -1
    this.windupTargetId = null
    this.attackCooldown = 0.7 + Math.random() * 0.6
  }

  private chooseTarget(
    seat: Seat,
    game: GameSim,
    stackLen: number,
    homeIndex: number,
    poseMap: Map<string, { x: number; y: number; z: number }>,
  ): void {
    const home = getHomeSlot(homeIndex).spawn
    const px = seat.pose!.x
    const pz = seat.pose!.z
    const st = game.getPlayerState(this.seatId)!

    // Holding mace: hunt enemies (unless bag is full — deposit first)
    if (st.item && isStunBat(st.item) && stackLen < MAX_CARRY) {
      const prey = nearestPrey(this.seatId, px, pz, game, poseMap)
      if (prey) {
        this.mode = 'hunt'
        this.targetX = prey.x
        this.targetZ = prey.z
        return
      }
    }

    if (stackLen >= MAX_CARRY) {
      this.mode = 'go_home'
      this.targetX = home.x
      this.targetZ = home.z
      return
    }

    // Empty hand: often go for a mace first (combat AI)
    if (!st.item) {
      const mace = nearestMace(game, px, pz)
      if (mace && (stackLen === 0 || Math.random() < 0.55)) {
        this.mode = 'seek_field'
        this.targetX = mace.x
        this.targetZ = mace.z
        return
      }
    }

    if (stackLen >= 1 && stackLen < MAX_CARRY && this.raidCooldown <= 0) {
      const raid = this.findRaid(st, homeIndex, game)
      if (raid && Math.random() < 0.35) {
        this.mode = 'raid'
        this.targetX = raid.x
        this.targetZ = raid.z
        this.raidCooldown = 6
        return
      }
    }

    const field = nearestLegalField(game, this.seatId, px, pz)
    if (field) {
      this.mode = 'seek_field'
      this.targetX = field.x
      this.targetZ = field.z
      return
    }

    if (stackLen > 0) {
      this.mode = 'go_home'
      this.targetX = home.x
      this.targetZ = home.z
      return
    }

    // No cards: hunt with mace if any, else wander
    if (st.item && isStunBat(st.item)) {
      const prey = nearestPrey(this.seatId, px, pz, game, poseMap)
      if (prey) {
        this.mode = 'hunt'
        this.targetX = prey.x
        this.targetZ = prey.z
        return
      }
    }

    this.mode = 'wander'
    this.targetX = home.x + (Math.random() * 10 - 5)
    this.targetZ = home.z + (Math.random() * 10 - 5)
  }

  private findRaid(
    st: { stack: { color?: string | null; rank: string }[]; stolenFromHomes: Set<number> },
    homeIndex: number,
    game: GameSim,
  ): { x: number; z: number } | null {
    if (!st.stack.length) return null
    const top = st.stack[st.stack.length - 1]!
    for (const h of game.listHomePiles()) {
      if (h.homeIndex === homeIndex) continue
      if (!h.top || h.count <= 0) continue
      if (st.stolenFromHomes.has(h.homeIndex)) continue
      if (!canStackOn(top as never, h.top)) continue
      const slot = getHomeSlot(h.homeIndex)
      return { x: slot.center.x, z: slot.center.z }
    }
    return null
  }
}

function standingYForBot(x: number, z: number, homeIndex: number): number {
  const home = getHomeSlot(homeIndex).center
  if (Math.abs(x - home.x) < 4.5 && Math.abs(z - home.z) < 4.5) {
    return BOT_HOME_STAND_Y
  }
  return BOT_STAND_Y
}

function nearestMace(
  game: GameSim,
  px: number,
  pz: number,
): { x: number; z: number } | null {
  let best: { x: number; z: number; d: number } | null = null
  for (const g of game.listGround()) {
    if (!isStunBat(g.card)) continue
    const d = Math.hypot(g.x - px, g.z - pz)
    if (!best || d < best.d) best = { x: g.x, z: g.z, d }
  }
  return best
}

/** Prefer live players with cards; dummy as last resort. */
function nearestPrey(
  selfId: string,
  px: number,
  pz: number,
  game: GameSim,
  poseMap: Map<string, { x: number; y: number; z: number }>,
): { x: number; z: number } | null {
  let best: { x: number; z: number; d: number } | null = null
  for (const [id, pos] of poseMap) {
    if (id === selfId) continue
    if (game.isStunned(id)) continue
    const d = Math.hypot(pos.x - px, pos.z - pz)
    if (d > MACE_CHASE_RANGE) continue
    const other = game.getPlayerState(id)
    let score = d
    if (id === TRAINING_DUMMY_ID) score += 2.5
    if (other && other.stack.length > 0) score -= 2.0
    // Soft floor so we still approach engage distance
    if (d < MACE_ENGAGE * 0.5) score -= 0.5
    if (!best || score < best.d) best = { x: pos.x, z: pos.z, d: score }
  }
  return best
}

/**
 * Nearest field target:
 * numbers when stack-legal; items if hand empty.
 * Prefer mace over skip; numbers still preferred when carrying stack.
 */
function nearestLegalField(
  game: GameSim,
  seatId: string,
  px: number,
  pz: number,
): { x: number; z: number } | null {
  const st = game.getPlayerState(seatId)
  if (!st) return null
  const top = st.stack.length ? st.stack[st.stack.length - 1]! : null

  let bestNum: { x: number; z: number; d: number } | null = null
  let bestMace: { x: number; z: number; d: number } | null = null
  let bestSkip: { x: number; z: number; d: number } | null = null

  for (const g of game.listGround()) {
    const d = Math.hypot(g.x - px, g.z - pz)
    if (isHandItem(g.card)) {
      if (!canPickupItem(!!st.item, g.card)) continue
      if (isStunBat(g.card)) {
        if (!bestMace || d < bestMace.d) bestMace = { x: g.x, z: g.z, d }
      } else if (isSkipTrap(g.card)) {
        if (!bestSkip || d < bestSkip.d) bestSkip = { x: g.x, z: g.z, d }
      }
      continue
    }
    if (top && !canStackOn(top, g.card)) continue
    if (!bestNum || d < bestNum.d) bestNum = { x: g.x, z: g.z, d }
  }

  // Empty bag: mace > number > skip
  if (!top) {
    if (bestMace) return bestMace
    if (bestNum) return bestNum
    if (bestSkip) return bestSkip
    return null
  }
  // Carrying: finish stack path first, else mace
  if (bestNum) return bestNum
  if (bestMace) return bestMace
  if (bestSkip) return bestSkip
  return null
}
