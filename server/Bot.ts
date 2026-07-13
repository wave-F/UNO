/**
 * Server-side AI: pick cards, deposit, raid homes often, light slide tackle.
 */
import { maxSpeedForCarry, BASE_MAX_SPEED } from '../shared/config/movement.ts'
import { TRAINING_DUMMY_ID } from '../shared/config/dummy.ts'
import { canStackOn, canPickupItem } from '../shared/uno/rules.ts'
import {
  isHandItem,
  isStunBat,
  isSkipTrap,
  ATTACK_RANGE,
  SLIDE_BASE_DIST,
} from '../shared/uno/types.ts'
import { getHomeSlot } from '../shared/config/home.ts'
import type { GameSim } from './GameSim.ts'
import type { Seat } from './Room.ts'

const ARRIVE_EPS = 0.65
const MAX_CARRY = 3
const MACE_CHASE_RANGE = 11
const MACE_ENGAGE = ATTACK_RANGE * 0.9
/** Bots slide less often than players (5s) — feel present but not oppressive. */
const BOT_SLIDE_COOLDOWN = 8.0
/** Only start slide wind-up when this close. */
const BOT_SLIDE_ENGAGE = Math.min(3.2, SLIDE_BASE_DIST * 0.75)
const BOT_SLIDE_WINDUP_MIN = 0.35
const BOT_SLIDE_WINDUP_MAX = 0.7

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
  private slideCooldown = 0
  private attackWindup = -1
  private windupTargetId: string | null = null
  private slideWindup = -1
  private slideTargetId: string | null = null

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
    this.slideCooldown = Math.max(0, this.slideCooldown - dt)

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

    if (game.isStunned(this.seatId) || game.isActionLocked(this.seatId)) {
      // Still update Y while stunned/sliding; don't overwrite slide path mid-dash
      if (game.isStunned(this.seatId)) {
        seat.pose = { ...seat.pose, y: standY }
        seat.lastPoseAt = Date.now()
      }
      poseMap.set(this.seatId, {
        x: seat.pose.x,
        y: seat.pose.y,
        z: seat.pose.z,
      })
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
    this.trySlide(dt, seat, game, poseMap)
  }

  /** Empty-hand slide: only when close, long CD, prefer targets with backpack. */
  private trySlide(
    dt: number,
    seat: Seat,
    game: GameSim,
    poseMap: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (this.slideCooldown > 0 || this.attackCooldown > 0) {
      this.slideWindup = -1
      this.slideTargetId = null
      return
    }
    const st = game.getPlayerState(this.seatId)
    if (!st || st.item || !seat.pose) {
      this.slideWindup = -1
      this.slideTargetId = null
      return
    }
    if (game.isActionLocked(this.seatId)) return

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
      if (d < 0.25 || d > BOT_SLIDE_ENGAGE) continue
      const other = game.getPlayerState(id)
      // Prefer carriers; still allow dummy/empty for presence
      let w = d
      if (id === TRAINING_DUMMY_ID) w += 1.2
      if (other && other.stack.length > 0) w -= 1.5
      if (other && other.stack.length === 0 && id !== TRAINING_DUMMY_ID) w += 0.6
      if (w < bestD) {
        bestD = w
        bestId = id
        bestDx = dx
        bestDz = dz
      }
    }

    if (!bestId) {
      this.slideWindup = -1
      this.slideTargetId = null
      return
    }

    const yaw = Math.atan2(bestDx, bestDz)
    seat.pose = { ...seat.pose, yaw, seq: (seat.pose.seq ?? 0) + 1 }

    if (this.slideTargetId !== bestId || this.slideWindup < 0) {
      this.slideTargetId = bestId
      this.slideWindup =
        BOT_SLIDE_WINDUP_MIN +
        Math.random() * (BOT_SLIDE_WINDUP_MAX - BOT_SLIDE_WINDUP_MIN)
      return
    }

    this.slideWindup -= dt
    if (this.slideWindup > 0) return

    game.trySlide(this.seatId, yaw, poseMap)
    this.slideWindup = -1
    this.slideTargetId = null
    this.slideCooldown = BOT_SLIDE_COOLDOWN + Math.random() * 2.5 // 8–10.5s
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

    // Prefer raiding when possible (empty stack can steal any top)
    if (stackLen < MAX_CARRY && this.raidCooldown <= 0) {
      const raid = this.findRaid(st, homeIndex, game)
      if (raid) {
        // High chance when holding 0–2 cards
        const p = stackLen === 0 ? 0.75 : stackLen === 1 ? 0.7 : 0.55
        if (Math.random() < p) {
          this.mode = 'raid'
          this.targetX = raid.x
          this.targetZ = raid.z
          this.raidCooldown = 1.8 + Math.random() * 1.2 // 1.8–3s between raid attempts
          return
        }
      }
    }

    // Empty hand: sometimes approach a target to slide (mild aggression)
    if (!st.item && this.slideCooldown <= 0 && stackLen < MAX_CARRY) {
      const prey = nearestPrey(this.seatId, px, pz, game, poseMap, 7)
      if (prey && Math.random() < 0.35) {
        this.mode = 'hunt'
        this.targetX = prey.x
        this.targetZ = prey.z
        return
      }
    }

    if (!st.item) {
      const mace = nearestMace(game, px, pz)
      if (mace && (stackLen === 0 || Math.random() < 0.4)) {
        this.mode = 'seek_field'
        this.targetX = mace.x
        this.targetZ = mace.z
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

    // After field dry: try raid again even if cooldown almost done
    if (stackLen < MAX_CARRY) {
      const raid = this.findRaid(st, homeIndex, game)
      if (raid && this.raidCooldown <= 0.5) {
        this.mode = 'raid'
        this.targetX = raid.x
        this.targetZ = raid.z
        this.raidCooldown = 2
        return
      }
    }

    if (stackLen > 0) {
      this.mode = 'go_home'
      this.targetX = home.x
      this.targetZ = home.z
      return
    }

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
    // Wander near a foreign home sometimes to set up next steal (skip fenced)
    if (Math.random() < 0.45) {
      const fenced = new Set(game.getLastFenceActive())
      let other = (homeIndex + 1 + Math.floor(Math.random() * 3)) % 4
      for (let k = 0; k < 4; k++) {
        const cand = (homeIndex + 1 + k) % 4
        if (!fenced.has(cand)) {
          other = cand
          break
        }
      }
      const c = getHomeSlot(other).center
      this.targetX = c.x + (Math.random() * 4 - 2)
      this.targetZ = c.z + (Math.random() * 4 - 2)
    } else {
      this.targetX = home.x + (Math.random() * 10 - 5)
      this.targetZ = home.z + (Math.random() * 10 - 5)
    }
  }

  /**
   * Find a home to steal from.
   * Empty backpack can take any top (UNO start-of-stack); with cards need canStackOn.
   */
  private findRaid(
    st: {
      stack: { color?: string | null; rank: string }[]
      stolenFromHomes: Set<number>
    },
    homeIndex: number,
    game: GameSim,
  ): { x: number; z: number } | null {
    const top = st.stack.length ? st.stack[st.stack.length - 1]! : null
    let best: { x: number; z: number; score: number } | null = null

    const fenced = new Set(game.getLastFenceActive())
    for (const h of game.listHomePiles()) {
      if (h.homeIndex === homeIndex) continue
      if (!h.top || h.count <= 0) continue
      if (st.stolenFromHomes.has(h.homeIndex)) continue
      // Owner is home → electric fence on; do not raid
      if (fenced.has(h.homeIndex)) continue
      if (top && !canStackOn(top as never, h.top)) continue
      const slot = getHomeSlot(h.homeIndex)
      // Prefer fatter piles
      const score = -h.count + Math.random() * 0.3
      if (!best || score < best.score) {
        best = { x: slot.center.x, z: slot.center.z, score }
      }
    }
    return best
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

function nearestPrey(
  selfId: string,
  px: number,
  pz: number,
  game: GameSim,
  poseMap: Map<string, { x: number; y: number; z: number }>,
  maxRange = MACE_CHASE_RANGE,
): { x: number; z: number } | null {
  let best: { x: number; z: number; d: number } | null = null
  for (const [id, pos] of poseMap) {
    if (id === selfId) continue
    if (game.isStunned(id)) continue
    const d = Math.hypot(pos.x - px, pos.z - pz)
    if (d > maxRange) continue
    const other = game.getPlayerState(id)
    let score = d
    if (id === TRAINING_DUMMY_ID) score += 2.5
    if (other && other.stack.length > 0) score -= 2.0
    if (d < MACE_ENGAGE * 0.5) score -= 0.5
    if (!best || score < best.d) best = { x: pos.x, z: pos.z, d: score }
  }
  return best
}

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

  if (!top) {
    if (bestNum) return bestNum
    if (bestMace) return bestMace
    if (bestSkip) return bestSkip
    return null
  }
  if (bestNum) return bestNum
  if (bestMace) return bestMace
  if (bestSkip) return bestSkip
  return null
}
