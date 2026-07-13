/**
 * Simple server-side AI: walk → pick legal field cards → deposit at home
 * → occasionally raid other homes (UNO rules).
 * Stun cards: free pickup into hand slot only; never treated as stack targets.
 */
import { maxSpeedForCarry, BASE_MAX_SPEED } from '../shared/config/movement.ts'
import { canStackOn, canPickupItem } from '../shared/uno/rules.ts'
import { isStunBat, ATTACK_RANGE } from '../shared/uno/types.ts'
import { getHomeSlot } from '../shared/config/home.ts'
import type { GameSim } from './GameSim.ts'
import type { Seat } from './Room.ts'

const ARRIVE_EPS = 0.65
const MAX_CARRY = 3
/**
 * Body-center Y when standing on the arena floor.
 * Must match client capsule: halfHeight + radius (not spawn.y=2.2 which is fall-in height).
 */
export const BOT_STAND_Y = 0.35 + 0.4
/** Body-center on home platform (platform top ≈ 0.25). */
export const BOT_HOME_STAND_Y = 0.25 + BOT_STAND_Y

type BotMode = 'seek_field' | 'go_home' | 'raid' | 'wander'

export class BotController {
  readonly seatId: string
  private mode: BotMode = 'seek_field'
  private targetX = 0
  private targetZ = 0
  private retargetT = 0
  private raidCooldown = 0
  /** After a swing: must wait before considering another attack. */
  private attackCooldown = 0
  /**
   * Wind-up while a target is in range. -1 = not aiming.
   * Counts down; only tryAttack when reaches 0.
   */
  private attackWindup = -1
  private windupTargetId: string | null = null

  constructor(seatId: string) {
    this.seatId = seatId
  }

  /**
   * Advance bot pose on seat; interaction runs via Room game.tick poses.
   * @param poseMap all connected player/bot positions (for melee).
   */
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

    if (this.retargetT > 0.35) {
      this.retargetT = 0
      this.chooseTarget(seat, game, st.stack.length, st.homeIndex)
    }

    const px = seat.pose.x
    const pz = seat.pose.z
    const dx = this.targetX - px
    const dz = this.targetZ - pz
    const dist = Math.hypot(dx, dz)
    // Always pin Y to standing height (bots have no gravity/physics).
    const standY = standingYForBot(px, pz, st.homeIndex)
    // Stunned: freeze in place
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

    // Update pose map with our new position, then maybe swing stun card
    poseMap.set(this.seatId, {
      x: seat.pose.x,
      y: seat.pose.y,
      z: seat.pose.z,
    })
    this.tryUseStun(dt, seat, game, poseMap)
  }

  /**
   * Holding stun + enemy in range: face target, random wind-up, then swing.
   * Not instant on the first frame they enter range.
   */
  private tryUseStun(
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
    if (!st?.item || !isStunBat(st.item) || !seat.pose) {
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
      if (d < 0.2 || d > ATTACK_RANGE * 0.92) continue
      const other = game.getPlayerState(id)
      const weight = d - (other && other.stack.length > 0 ? 0.8 : 0)
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
      // Random reaction / aim time before swing
      this.attackWindup = 0.5 + Math.random() * 1.0 // 0.5–1.5s
      return
    }

    this.attackWindup -= dt
    if (this.attackWindup > 0) return

    // Wind-up done — swing
    game.tryAttack(this.seatId, yaw, poseMap)
    this.attackWindup = -1
    this.windupTargetId = null
    // Random cooldown so bots don't chain-attack instantly after picking another bat
    this.attackCooldown = 0.9 + Math.random() * 0.8 // 0.9–1.7s
  }

  private chooseTarget(
    seat: Seat,
    game: GameSim,
    stackLen: number,
    homeIndex: number,
  ): void {
    const home = getHomeSlot(homeIndex).spawn
    const px = seat.pose!.x
    const pz = seat.pose!.z
    const st = game.getPlayerState(this.seatId)!

    // Deposit when full or no field targets while carrying
    if (stackLen >= MAX_CARRY) {
      this.mode = 'go_home'
      this.targetX = home.x
      this.targetZ = home.z
      return
    }

    // Raid sometimes
    if (stackLen >= 1 && stackLen < MAX_CARRY && this.raidCooldown <= 0) {
      const raid = this.findRaid(st, homeIndex, game)
      if (raid && Math.random() < 0.4) {
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
  // On own platform footprint use home height; else arena floor.
  if (Math.abs(x - home.x) < 4.5 && Math.abs(z - home.z) < 4.5) {
    return BOT_HOME_STAND_Y
  }
  return BOT_STAND_Y
}

/**
 * Nearest field target the bot can actually pick up:
 * - number: empty stack or canStackOn(top, card)
 * - stun: only if hand item slot empty (not stack order)
 * Prefer numbers over stun so bots don't park on useless stun piles.
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
  let bestStun: { x: number; z: number; d: number } | null = null

  for (const g of game.listGround()) {
    const d = Math.hypot(g.x - px, g.z - pz)
    if (isStunBat(g.card)) {
      if (!canPickupItem(!!st.item, g.card)) continue
      if (!bestStun || d < bestStun.d) bestStun = { x: g.x, z: g.z, d }
      continue
    }
    if (top && !canStackOn(top, g.card)) continue
    if (!bestNum || d < bestNum.d) bestNum = { x: g.x, z: g.z, d }
  }

  // Prefer number cards; only chase stun when no legal number and hand free
  if (bestNum) return bestNum
  if (bestStun) return bestStun
  return null
}
