import { getHomeSlot, homeConfig, isInsideHomeSlot } from '../../shared/config/home'
import { maxSpeedForCarry } from '../../shared/config/movement'
import { canStackOn } from '../../shared/uno/rules'
import {
  isHandItem,
  KNOCKBACK_DIST,
  KNOCKBACK_DURATION_MS,
  SLIDE_BASE_DIST,
  SLIDE_DURATION_MS,
  SLIDE_HIT_RADIUS,
  SLIDE_RECOVER_MS,
  STUN_DURATION_MS,
  randomSlideDropCount,
  type UnoCardData,
} from '../../shared/uno/types'
import { movementConfig as cfg } from '../config/movement'
import type { CardPickupSystem } from './CardPickupSystem'
import type { HomeYard } from '../entities/HomeBase'
import type { RemotePlayerSystem } from './RemotePlayerSystem'

const MAX_CARRY = 3
const STAND_Y = cfg.capsuleHalfHeight + cfg.capsuleRadius + 0.25
const BOT_SLIDE_CD = 9.0
const BOT_SLIDE_ENGAGE = 3.0

type BotMode = 'seek' | 'home' | 'raid' | 'wander' | 'hunt'

export type OfflinePlayerSnap = {
  x: number
  z: number
  dead: boolean
  stunned: boolean
  onOwnHome: boolean
  homeIndex: number
  /** Backpack card count — used when choosing slide targets. */
  stackCount: number
}

/** Who a bot is sliding toward (player or another bot). */
type SlideTarget = {
  kind: 'player' | 'bot'
  id?: string
  x: number
  z: number
  stackCount: number
}

type OfflineBot = {
  id: string
  name: string
  homeIndex: number
  x: number
  z: number
  yaw: number
  stack: UnoCardData[]
  score: number
  mode: BotMode
  targetX: number
  targetZ: number
  retargetT: number
  stunUntil: number
  deathUntil: number
  stolenFromHomes: Set<number>
  slideCd: number
  raidCd: number
}

export type OfflineBotHitPlayer = {
  fromX: number
  fromZ: number
  toX: number
  toZ: number
  dirX: number
  dirZ: number
  durationMs: number
}

/**
 * Lightweight client-side bots for offline solo (no WebSocket).
 */
export class OfflineBotSystem {
  private bots: OfflineBot[] = []
  private cards: CardPickupSystem | null = null
  private homes: HomeYard | null = null
  private remotes: RemotePlayerSystem | null = null
  private active = false
  private fenced = new Set<number>()
  private onHitPlayer: ((hit: OfflineBotHitPlayer) => void) | null = null
  private onLocalHomeStolen: (() => void) | null = null

  get isActive(): boolean {
    return this.active
  }

  start(
    count: number,
    cards: CardPickupSystem,
    homes: HomeYard,
    remotes: RemotePlayerSystem,
    hooks?: {
      onHitPlayer?: (hit: OfflineBotHitPlayer) => void
      onLocalHomeStolen?: () => void
    },
  ): void {
    this.clear()
    this.cards = cards
    this.homes = homes
    this.remotes = remotes
    this.onHitPlayer = hooks?.onHitPlayer ?? null
    this.onLocalHomeStolen = hooks?.onLocalHomeStolen ?? null
    this.active = true

    const n = Math.max(0, Math.min(3, count))
    // Names by corner so mid-field runners are not confused with "stuck at center"
    const cornerNames = ['东南', '西北', '东北'] as const
    for (let i = 0; i < n; i++) {
      const homeIndex = i + 1
      // Stand on platform center (stable XZ); spawn.y is fall-in height for humans
      const home = getHomeSlot(homeIndex).center
      const id = `offline_bot_${i + 1}`
      const name = cornerNames[i] ?? `Bot${i + 1}`
      const bot: OfflineBot = {
        id,
        name,
        homeIndex,
        x: home.x,
        z: home.z,
        yaw: 0,
        stack: [],
        score: 0,
        mode: 'seek',
        targetX: home.x,
        targetZ: home.z,
        retargetT: 0.9 + Math.random() * 0.4, // brief idle at home so spawn is visible
        stunUntil: 0,
        deathUntil: 0,
        stolenFromHomes: new Set(),
        slideCd: 2 + Math.random() * 3,
        raidCd: Math.random() * 2,
      }
      this.bots.push(bot)
      remotes.upsert(id, name, homeIndex)
      // force=true: pin to corner even if anim leftover
      remotes.pushPoseNow(id, bot.x, STAND_Y, bot.z, bot.yaw, true, 1 / 60, true)
      remotes.setPlayerStack(id, [])
    }
  }

  clear(): void {
    if (this.remotes) {
      for (const b of this.bots) this.remotes.removeById(b.id)
    }
    this.bots = []
    this.cards = null
    this.homes = null
    this.remotes = null
    this.active = false
    this.fenced.clear()
    this.onHitPlayer = null
    this.onLocalHomeStolen = null
  }

  setFencedSlots(slots: readonly number[]): void {
    this.fenced = new Set(slots)
  }

  /** Homes with owner standing on platform (and not dead). */
  computeOwnerFences(player: OfflinePlayerSnap): number[] {
    const active: number[] = []
    if (player.onOwnHome && !player.dead) {
      active.push(player.homeIndex)
    }
    const now = Date.now()
    for (const b of this.bots) {
      if (now < b.deathUntil || now < b.stunUntil) continue
      if (isInsideHomeSlot(b.homeIndex, b.x, b.z)) {
        active.push(b.homeIndex)
      }
    }
    return active
  }

  getScores(
    localId: string,
    localName: string,
    localScore: number,
    localStack: number,
  ): { id: string; name?: string; score: number; stackCount: number }[] {
    const list = [
      {
        id: localId,
        name: localName,
        score: localScore,
        stackCount: localStack,
      },
    ]
    for (const b of this.bots) {
      list.push({
        id: b.id,
        name: b.name,
        score: b.score,
        stackCount: b.stack.length,
      })
    }
    return list
  }

  anyReached(winScore: number): OfflineBot | null {
    for (const b of this.bots) {
      if (b.score >= winScore) return b
    }
    return null
  }

  listPoses(): { id: string; x: number; z: number; stunUntil: number; deathUntil: number }[] {
    return this.bots.map((b) => ({
      id: b.id,
      x: b.x,
      z: b.z,
      stunUntil: b.stunUntil,
      deathUntil: b.deathUntil,
    }))
  }

  /** Player slide hit bot. */
  applyHit(
    botId: string,
    dirX: number,
    dirZ: number,
    attackerX: number,
    attackerZ: number,
  ): number {
    const bot = this.bots.find((b) => b.id === botId)
    if (!bot || !this.cards || !this.remotes) return 0
    const now = Date.now()
    if (now < bot.stunUntil || now < bot.deathUntil) return 0
    return this.knockBot(bot, dirX, dirZ, attackerX, attackerZ, now)
  }

  /** Electrocute bot on fenced foreign home — full drop + death. */
  tryElectrocuteBot(botId: string): boolean {
    const bot = this.bots.find((b) => b.id === botId)
    if (!bot || !this.cards || !this.remotes || !this.homes) return false
    const now = Date.now()
    if (now < bot.deathUntil) return false

    const slot = this.homes.slotAt(bot.x, bot.z)
    if (slot === null || slot === bot.homeIndex) return false
    if (!this.fenced.has(slot)) return false

    this.dropAllBotCards(bot)
    bot.deathUntil = now + homeConfig.fenceDeathMs
    bot.stunUntil = bot.deathUntil
    bot.stack = []
    this.remotes.setPlayerStack(bot.id, [])
    this.remotes.setStunned(bot.id, bot.deathUntil, homeConfig.fenceDeathMs)
    return true
  }

  tick(dt: number, player: OfflinePlayerSnap): void {
    if (!this.active || !this.cards || !this.homes || !this.remotes) return
    const now = Date.now()
    for (const bot of this.bots) {
      // Respawn after fence death
      if (bot.deathUntil > 0 && now >= bot.deathUntil) {
        const home = getHomeSlot(bot.homeIndex).center
        bot.x = home.x
        bot.z = home.z
        bot.deathUntil = 0
        bot.stunUntil = 0
        bot.stack = []
        bot.stolenFromHomes.clear()
        this.remotes.setPlayerStack(bot.id, [])
        this.remotes.pushPoseNow(
          bot.id,
          bot.x,
          STAND_Y,
          bot.z,
          bot.yaw,
          true,
          dt,
          true,
        )
      }

      this.tickOne(bot, dt, player, now)
      // Pass dt so RemotePlayer can drive limb walk from position delta
      this.remotes.pushPoseNow(bot.id, bot.x, STAND_Y, bot.z, bot.yaw, true, dt)
      this.remotes.setPlayerStack(bot.id, bot.stack)
    }
  }

  private tickOne(
    bot: OfflineBot,
    dt: number,
    player: OfflinePlayerSnap,
    now: number,
  ): void {
    if (now < bot.deathUntil) return
    if (now < bot.stunUntil) return

    bot.slideCd = Math.max(0, bot.slideCd - dt)
    bot.raidCd = Math.max(0, bot.raidCd - dt)
    bot.retargetT -= dt
    if (bot.retargetT <= 0) {
      bot.retargetT = 0.32 + Math.random() * 0.22
      this.chooseTarget(bot, player)
    }

    // Occasional slide at any nearby carrier (player or other bot)
    if (bot.slideCd <= 0 && bot.stack.length < MAX_CARRY) {
      const target = this.pickSlideTarget(bot, player, now)
      if (target) {
        const d = Math.hypot(target.x - bot.x, target.z - bot.z)
        if (d < BOT_SLIDE_ENGAGE && d > 0.35 && Math.random() < 0.4) {
          this.botTrySlide(bot, target, now)
          bot.slideCd = BOT_SLIDE_CD + Math.random() * 2.5
          return
        }
      }
    }

    const dx = bot.targetX - bot.x
    const dz = bot.targetZ - bot.z
    const dist = Math.hypot(dx, dz)
    if (dist > 0.05) {
      bot.yaw = Math.atan2(dx, dz)
      const speed = maxSpeedForCarry(bot.stack.length, cfg.maxSpeed) * 0.92
      const step = Math.min(dist, speed * dt)
      bot.x += (dx / dist) * step
      bot.z += (dz / dist) * step
    }

    // Electrocute if stepped into fenced foreign home
    if (this.tryElectrocuteBot(bot.id)) return

    // Deposit at own home
    if (bot.stack.length > 0 && isInsideHomeSlot(bot.homeIndex, bot.x, bot.z)) {
      const n = this.homes!.depositTo(bot.homeIndex, bot.stack)
      bot.score = n
      bot.stack = []
      bot.stolenFromHomes.clear()
      this.remotes!.setPlayerStack(bot.id, [])
      bot.retargetT = 0
      return
    }

    // Steal foreign home (player or other bot homes)
    const foreign = this.homes!.slotAt(bot.x, bot.z)
    if (
      foreign !== null &&
      foreign !== bot.homeIndex &&
      bot.stack.length < MAX_CARRY
    ) {
      this.botTrySteal(bot, foreign)
      return
    }

    // Field pickup
    if (bot.stack.length < MAX_CARRY) {
      const picked = this.cards!.tryPickupAt(bot.x, bot.z, bot.stack)
      if (picked) {
        bot.stack = picked
        this.remotes!.setPlayerStack(bot.id, bot.stack)
        bot.retargetT = 0
      }
    }
  }

  /** Closest worthwhile slide target: carriers only (player or bots). */
  private pickSlideTarget(
    bot: OfflineBot,
    player: OfflinePlayerSnap,
    now: number,
  ): SlideTarget | null {
    let best: SlideTarget | null = null
    let bestScore = Infinity

    const consider = (t: SlideTarget) => {
      if (t.stackCount <= 0) return
      const d = Math.hypot(t.x - bot.x, t.z - bot.z)
      if (d < 0.35 || d > BOT_SLIDE_ENGAGE + 0.5) return
      // Prefer closer + slightly prefer fatter backpacks
      const score = d - Math.min(2, t.stackCount) * 0.35
      if (score < bestScore) {
        bestScore = score
        best = t
      }
    }

    if (!player.dead && !player.stunned && player.stackCount > 0) {
      consider({
        kind: 'player',
        x: player.x,
        z: player.z,
        stackCount: player.stackCount,
      })
    }
    for (const other of this.bots) {
      if (other.id === bot.id) continue
      if (now < other.deathUntil || now < other.stunUntil) continue
      if (other.stack.length <= 0) continue
      consider({
        kind: 'bot',
        id: other.id,
        x: other.x,
        z: other.z,
        stackCount: other.stack.length,
      })
    }
    return best
  }

  private botTrySlide(bot: OfflineBot, target: SlideTarget, now: number): void {
    const yaw = Math.atan2(target.x - bot.x, target.z - bot.z)
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    const dist = SLIDE_BASE_DIST * 0.85
    const lim = 17
    const fromX = bot.x
    const fromZ = bot.z
    const toX = Math.max(-lim, Math.min(lim, bot.x + fx * dist))
    const toZ = Math.max(-lim, Math.min(lim, bot.z + fz * dist))

    // Hit-test current target along slide corridor
    const hit = pointNearSegment(
      target.x,
      target.z,
      fromX,
      fromZ,
      toX,
      toZ,
      SLIDE_HIT_RADIUS,
    )
    bot.x = toX
    bot.z = toZ
    bot.yaw = yaw
    this.remotes?.playSlide(bot.id, {
      fromX,
      fromY: STAND_Y,
      fromZ,
      toX,
      toY: STAND_Y,
      toZ,
      durationMs: SLIDE_DURATION_MS,
      recoverMs: SLIDE_RECOVER_MS,
    })
    bot.stunUntil = now + SLIDE_DURATION_MS + SLIDE_RECOVER_MS

    if (!hit) return

    const kx = target.x - fromX
    const kz = target.z - fromZ
    const len = Math.hypot(kx, kz) || 1
    const dirX = kx / len
    const dirZ = kz / len

    if (target.kind === 'player' && this.onHitPlayer) {
      const pToX = Math.max(
        -lim,
        Math.min(lim, target.x + dirX * KNOCKBACK_DIST),
      )
      const pToZ = Math.max(
        -lim,
        Math.min(lim, target.z + dirZ * KNOCKBACK_DIST),
      )
      this.onHitPlayer({
        fromX: target.x,
        fromZ: target.z,
        toX: pToX,
        toZ: pToZ,
        dirX,
        dirZ,
        durationMs: KNOCKBACK_DURATION_MS,
      })
      return
    }

    if (target.kind === 'bot' && target.id) {
      const victim = this.bots.find((b) => b.id === target.id)
      if (victim) this.knockBot(victim, dirX, dirZ, fromX, fromZ, now)
    }
  }

  private botTrySteal(bot: OfflineBot, slot: number): void {
    if (!this.homes) return
    if (this.fenced.has(slot)) return
    if (bot.stolenFromHomes.has(slot)) return
    const pileTop = this.homes.getTop(slot)
    if (!pileTop) return
    const top = bot.stack.length ? bot.stack[bot.stack.length - 1]! : null
    if (top && !canStackOn(top, pileTop)) return
    const card = this.homes.popTopFrom(slot)
    if (!card) return
    bot.stack.push(card)
    bot.stolenFromHomes.add(slot)
    this.remotes?.setPlayerStack(bot.id, bot.stack)
    // Local player home lost a card → sync score
    if (slot === homeConfig.defaultSlot) {
      this.onLocalHomeStolen?.()
    } else {
      // Another bot's home: update that bot's score from pile count
      const owner = this.bots.find((b) => b.homeIndex === slot)
      if (owner) owner.score = this.homes.getCount(slot)
    }
  }

  private chooseTarget(bot: OfflineBot, player: OfflinePlayerSnap): void {
    const cards = this.cards!
    const homes = this.homes!

    if (bot.stack.length >= MAX_CARRY) {
      bot.mode = 'home'
      const h = getHomeSlot(bot.homeIndex).spawn
      bot.targetX = h.x
      bot.targetZ = h.z
      return
    }

    // Prefer raid when cooldown allows
    if (bot.raidCd <= 0 && bot.stack.length < MAX_CARRY) {
      const raid = this.findRaid(bot)
      if (raid && Math.random() < (bot.stack.length === 0 ? 0.72 : 0.55)) {
        bot.mode = 'raid'
        bot.targetX = raid.x
        bot.targetZ = raid.z
        bot.raidCd = 1.8 + Math.random() * 1.4
        return
      }
    }

    // Hunt a nearby carrier (player or another bot) to set up a slide
    if (bot.slideCd <= 1.5 && Math.random() < 0.28) {
      const hunt = this.pickHuntTarget(bot, player, Date.now())
      if (hunt) {
        bot.mode = 'hunt'
        bot.targetX = hunt.x
        bot.targetZ = hunt.z
        return
      }
    }

    const ground = cards.listGround()
    const top = bot.stack.length ? bot.stack[bot.stack.length - 1]! : null
    const homeC = getHomeSlot(bot.homeIndex).center
    // Prefer cards closer to own home so bots fan out (not all pile into map center)
    let best: { x: number; z: number; score: number } | null = null
    for (const g of ground) {
      if (top && !canStackOn(top, g.card)) continue
      const dSelf = Math.hypot(g.x - bot.x, g.z - bot.z)
      const dHome = Math.hypot(g.x - homeC.x, g.z - homeC.z)
      const score = dSelf + dHome * 0.55
      if (!best || score < best.score) best = { x: g.x, z: g.z, score }
    }
    if (best) {
      bot.mode = 'seek'
      bot.targetX = best.x
      bot.targetZ = best.z
      return
    }

    if (bot.stack.length > 0) {
      bot.mode = 'home'
      const h = getHomeSlot(bot.homeIndex).spawn
      bot.targetX = h.x
      bot.targetZ = h.z
      return
    }

    // Empty field: wander near a stealable home
    const raid = this.findRaid(bot)
    if (raid) {
      bot.mode = 'raid'
      bot.targetX = raid.x + (Math.random() * 2 - 1)
      bot.targetZ = raid.z + (Math.random() * 2 - 1)
      return
    }

    // Wander near own home — never park at world origin
    bot.mode = 'wander'
    bot.targetX = homeC.x + (Math.random() * 8 - 4)
    bot.targetZ = homeC.z + (Math.random() * 8 - 4)
    void homes
  }

  /** Approach target for slide — farther range than engage, any carrier. */
  private pickHuntTarget(
    bot: OfflineBot,
    player: OfflinePlayerSnap,
    now: number,
  ): { x: number; z: number } | null {
    let best: { x: number; z: number; score: number } | null = null
    const consider = (x: number, z: number, stackCount: number) => {
      if (stackCount <= 0) return
      const d = Math.hypot(x - bot.x, z - bot.z)
      if (d < 0.5 || d > 10) return
      const score = d - Math.min(3, stackCount) * 0.4
      if (!best || score < best.score) best = { x, z, score }
    }
    if (!player.dead && !player.stunned) {
      consider(player.x, player.z, player.stackCount)
    }
    for (const other of this.bots) {
      if (other.id === bot.id) continue
      if (now < other.deathUntil || now < other.stunUntil) continue
      consider(other.x, other.z, other.stack.length)
    }
    return best
  }

  private findRaid(bot: OfflineBot): { x: number; z: number } | null {
    if (!this.homes) return null
    const top = bot.stack.length ? bot.stack[bot.stack.length - 1]! : null
    let best: { x: number; z: number; score: number } | null = null
    for (let slot = 0; slot < 4; slot++) {
      if (slot === bot.homeIndex) continue
      if (this.fenced.has(slot)) continue
      if (bot.stolenFromHomes.has(slot)) continue
      const count = this.homes.getCount(slot)
      if (count <= 0) continue
      const pileTop = this.homes.getTop(slot)
      if (!pileTop) continue
      if (top && !canStackOn(top, pileTop)) continue
      const c = getHomeSlot(slot).center
      const score = -count + Math.random() * 0.4
      if (!best || score < best.score) {
        best = { x: c.x, z: c.z, score }
      }
    }
    return best
  }

  private knockBot(
    bot: OfflineBot,
    dirX: number,
    dirZ: number,
    attackerX: number,
    attackerZ: number,
    now: number,
  ): number {
    if (!this.cards || !this.remotes) return 0
    let kx = dirX
    let kz = dirZ
    const awayX = bot.x - attackerX
    const awayZ = bot.z - attackerZ
    const awayLen = Math.hypot(awayX, awayZ)
    if (awayLen > 0.05) {
      kx = awayX / awayLen
      kz = awayZ / awayLen
    }
    const lim = 17
    const fromX = bot.x
    const fromZ = bot.z
    const toX = Math.max(-lim, Math.min(lim, bot.x + kx * KNOCKBACK_DIST))
    const toZ = Math.max(-lim, Math.min(lim, bot.z + kz * KNOCKBACK_DIST))

    // Slide hit: random 1–4 (same as server trySlide)
    const dropN = randomSlideDropCount(bot.stack.length)
    const dropped: { card: UnoCardData; x: number; y: number; z: number }[] = []
    let removed = 0
    for (let guard = 0; guard < 32 && removed < dropN && bot.stack.length; guard++) {
      const top = bot.stack[bot.stack.length - 1]!
      if (isHandItem(top)) {
        bot.stack.pop()
        continue
      }
      const card = bot.stack.pop()
      if (!card) break
      const ang = (removed / Math.max(1, dropN)) * Math.PI * 2 + 0.35
      const rad = 0.7 + (removed % 2) * 0.45
      const mix = 0.55 + removed * 0.08
      const cx = fromX + (toX - fromX) * mix
      const cz = fromZ + (toZ - fromZ) * mix
      dropped.push({
        card,
        x: cx + Math.cos(ang) * rad,
        y: 0.55,
        z: cz + Math.sin(ang) * rad,
      })
      removed++
    }
    if (dropped.length) {
      this.cards.spawnDropped(dropped, {
        x: fromX,
        y: STAND_Y + 0.3,
        z: fromZ,
      })
    }

    bot.x = toX
    bot.z = toZ
    bot.stunUntil = now + STUN_DURATION_MS
    this.remotes.setPlayerStack(bot.id, bot.stack)
    this.remotes.setStunned(bot.id, bot.stunUntil, STUN_DURATION_MS)
    this.remotes.playKnockback(bot.id, {
      fromX,
      fromY: STAND_Y,
      fromZ,
      toX,
      toY: STAND_Y,
      toZ,
      durationMs: KNOCKBACK_DURATION_MS,
    })
    return dropped.length
  }

  private dropAllBotCards(bot: OfflineBot): void {
    if (!this.cards || !bot.stack.length) {
      bot.stack = []
      return
    }
    const drops = bot.stack.map((card, i) => {
      const ang = (i / Math.max(1, bot.stack.length)) * Math.PI * 2
      return {
        card,
        x: bot.x + Math.cos(ang) * (0.8 + (i % 3) * 0.25),
        y: 0.55,
        z: bot.z + Math.sin(ang) * (0.8 + (i % 3) * 0.25),
      }
    })
    this.cards.spawnDropped(drops, { x: bot.x, y: STAND_Y + 0.4, z: bot.z })
    bot.stack = []
  }
}

function pointNearSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  radius: number,
): { t: number } | null {
  const abx = bx - ax
  const abz = bz - az
  const len2 = abx * abx + abz * abz
  if (len2 < 1e-8) {
    const d = Math.hypot(px - ax, pz - az)
    return d <= radius ? { t: 0 } : null
  }
  let t = ((px - ax) * abx + (pz - az) * abz) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + abx * t
  const cz = az + abz * t
  const d = Math.hypot(px - cx, pz - cz)
  return d <= radius ? { t } : null
}
