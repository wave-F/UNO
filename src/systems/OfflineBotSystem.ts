import {
  getHomeSlot,
  homeConfig,
  isInsideHomeSlot,
  isNearHomePile,
} from '../../shared/config/home'
import { MATCH_UNO_REMAINING, MATCH_WIN_SCORE } from '../../shared/config/match'
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
  /**
   * Empty-hand raid commitment: keep going to this home until steal / fail / timeout.
   * Prevents 0.3s retarget flipping to a nearby field card.
   */
  raidSlot: number | null
  raidCommitLeft: number
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
  /** Home slots in UNO zone (close to win) — bots raid these harder. */
  private unoThreatSlots = new Set<number>()
  private onHitPlayer: ((hit: OfflineBotHitPlayer) => void) | null = null
  private onLocalHomeStolen: (() => void) | null = null
  private pendingZaps: { x: number; y: number; z: number }[] = []

  get isActive(): boolean {
    return this.active
  }

  /** True when any competitor is within MATCH_UNO_REMAINING of win. */
  get hasUnoPressure(): boolean {
    return this.unoThreatSlots.size > 0
  }

  /**
   * Refresh UNO pressure from current scores (call each match tick).
   * Threat = score in [WIN−UNO_REMAINING, WIN) — same band as UNO banner.
   */
  setUnoPressureFromScores(
    entries: { homeIndex: number; score: number }[],
  ): void {
    this.unoThreatSlots.clear()
    const lo = MATCH_WIN_SCORE - MATCH_UNO_REMAINING
    for (const e of entries) {
      if (e.homeIndex < 0 || e.homeIndex > 3) continue
      if (e.score >= lo && e.score < MATCH_WIN_SCORE) {
        this.unoThreatSlots.add(e.homeIndex)
      }
    }
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
        raidSlot: null,
        raidCommitLeft: 0,
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
    this.unoThreatSlots.clear()
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

  /**
   * Electrocute bot on fenced foreign home.
   * Drop cards, vanish immediately (no 5s stun pose); respawn later at home.
   * @returns zap world position if electrocuted, else null
   */
  tryElectrocuteBot(
    botId: string,
  ): { x: number; y: number; z: number } | null {
    const bot = this.bots.find((b) => b.id === botId)
    if (!bot || !this.cards || !this.remotes || !this.homes) return null
    const now = Date.now()
    if (now < bot.deathUntil) return null

    const slot = this.homes.slotAt(bot.x, bot.z)
    if (slot === null || slot === bot.homeIndex) return null
    if (!this.fenced.has(slot)) return null

    const zap = { x: bot.x, y: STAND_Y, z: bot.z }
    this.dropAllBotCards(bot)
    bot.deathUntil = now + homeConfig.fenceDeathMs
    bot.stunUntil = 0 // do not stand stunned — vanish
    bot.stack = []
    this.remotes.setPlayerStack(bot.id, [])
    this.remotes.setVisible(bot.id, false)
    return zap
  }

  tick(dt: number, player: OfflinePlayerSnap): void {
    if (!this.active || !this.cards || !this.homes || !this.remotes) return
    const now = Date.now()
    for (const bot of this.bots) {
      // Respawn after fence death — appear at home, not at death spot
      if (bot.deathUntil > 0 && now >= bot.deathUntil) {
        const home = getHomeSlot(bot.homeIndex).center
        bot.x = home.x
        bot.z = home.z
        bot.deathUntil = 0
        bot.stunUntil = 0
        bot.stack = []
        bot.stolenFromHomes.clear()
        this.remotes.setPlayerStack(bot.id, [])
        this.remotes.setVisible(bot.id, true)
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

      // Dead: stay invisible, no AI / pose spam at death spot
      if (now < bot.deathUntil) continue

      this.tickOne(bot, dt, player, now)
      // After move: fence zap (vanish + FX at death pos)
      const zap = this.tryElectrocuteBot(bot.id)
      if (zap) this.pendingZaps.push(zap)
      if (now < bot.deathUntil) continue
      this.remotes.pushPoseNow(bot.id, bot.x, STAND_Y, bot.z, bot.yaw, true, dt)
      this.remotes.setPlayerStack(bot.id, bot.stack)
    }
  }

  /** Consume zap positions for ElectrocuteFx (fence deaths this frame). */
  takePendingZaps(): { x: number; y: number; z: number }[] {
    const z = this.pendingZaps
    this.pendingZaps = []
    return z
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
    bot.raidCommitLeft = Math.max(0, bot.raidCommitLeft - dt)
    bot.retargetT -= dt

    const emptyRaidCommit =
      bot.stack.length === 0 &&
      bot.mode === 'raid' &&
      bot.raidSlot != null &&
      bot.raidCommitLeft > 0

    if (bot.retargetT <= 0) {
      bot.retargetT = 0.32 + Math.random() * 0.22
      if (emptyRaidCommit) {
        // Empty-hand raid: stay on target, only revalidate / refresh coords
        if (this.raidTargetStillValid(bot, bot.raidSlot!)) {
          const c = getHomeSlot(bot.raidSlot!).center
          bot.targetX = c.x
          bot.targetZ = c.z
          bot.mode = 'raid'
        } else {
          this.clearRaidCommit(bot)
          this.chooseTarget(bot, player)
        }
      } else {
        this.chooseTarget(bot, player)
      }
    }

    // Occasional slide — not while committed to an empty-hand raid
    if (!emptyRaidCommit && bot.slideCd <= 0 && bot.stack.length < MAX_CARRY) {
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

    // Electrocute handled in Game after tick (needs FX spawn)

    // Deposit at own home
    if (bot.stack.length > 0 && isInsideHomeSlot(bot.homeIndex, bot.x, bot.z)) {
      const n = this.homes!.depositTo(bot.homeIndex, bot.stack)
      bot.score = n
      bot.stack = []
      bot.stolenFromHomes.clear()
      this.clearRaidCommit(bot)
      this.remotes!.setPlayerStack(bot.id, [])
      bot.retargetT = 0
      return
    }

    // Steal foreign home — must stand on pile (center), not only platform door
    const foreign = this.homes!.slotAt(bot.x, bot.z)
    if (
      foreign !== null &&
      foreign !== bot.homeIndex &&
      bot.stack.length < MAX_CARRY
    ) {
      if (isNearHomePile(foreign, bot.x, bot.z)) {
        const before = bot.stack.length
        this.botTrySteal(bot, foreign)
        if (bot.stack.length > before) {
          this.clearRaidCommit(bot)
          bot.retargetT = 0
        } else if (emptyRaidCommit && foreign === bot.raidSlot) {
          // On pile but cannot steal (fence / illegal / empty) — abort commit
          this.clearRaidCommit(bot)
          bot.retargetT = 0
        }
      }
      // On platform but not yet on pile: keep walking (raid target is pile center)
      return
    }

    // Field pickup — skip while empty-hand raid is committed
    if (!emptyRaidCommit && bot.stack.length < MAX_CARRY) {
      const picked = this.cards!.tryPickupAt(bot.x, bot.z, bot.stack)
      if (picked) {
        bot.stack = picked
        this.clearRaidCommit(bot)
        this.remotes!.setPlayerStack(bot.id, bot.stack)
        bot.retargetT = 0
      }
    }

    // Commit timed out without steal
    if (
      bot.stack.length === 0 &&
      bot.mode === 'raid' &&
      bot.raidSlot != null &&
      bot.raidCommitLeft <= 0
    ) {
      this.clearRaidCommit(bot)
      bot.retargetT = 0
    }
  }

  private clearRaidCommit(bot: OfflineBot): void {
    bot.raidSlot = null
    bot.raidCommitLeft = 0
    if (bot.mode === 'raid') bot.mode = 'seek'
  }

  /** Can still usefully walk to this home to steal? */
  private raidTargetStillValid(bot: OfflineBot, slot: number): boolean {
    if (!this.homes) return false
    if (slot === bot.homeIndex) return false
    if (this.fenced.has(slot)) return false
    if (bot.stolenFromHomes.has(slot)) return false
    if (this.homes.getCount(slot) <= 0) return false
    const pileTop = this.homes.getTop(slot)
    if (!pileTop) return false
    const top = bot.stack.length ? bot.stack[bot.stack.length - 1]! : null
    if (top && !canStackOn(top, pileTop)) return false
    return true
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

    const uno = this.hasUnoPressure
    // UNO pressure: raid more often, shorter CD, prefer threat homes (see findRaid)
    const raidReady = uno ? bot.raidCd <= 0.35 : bot.raidCd <= 0
    if (raidReady && bot.stack.length < MAX_CARRY) {
      const raid = this.findRaid(bot)
      if (raid) {
        // Empty hand: 50% normal, 75% after UNO pressure; carrying: 55% / 88%
        const pRaid = uno
          ? bot.stack.length === 0
            ? 0.75
            : 0.88
          : bot.stack.length === 0
            ? 0.5
            : 0.55
        if (Math.random() < pRaid) {
          bot.mode = 'raid'
          bot.targetX = raid.x
          bot.targetZ = raid.z
          bot.raidCd = uno
            ? 0.55 + Math.random() * 0.7 // ~0.55–1.25s
            : 1.8 + Math.random() * 1.4
          // Empty hand: commit until steal / fail / ~8s (don't flip to field cards mid-path)
          if (bot.stack.length === 0) {
            bot.raidSlot = raid.slot
            bot.raidCommitLeft = 8
          } else {
            bot.raidSlot = null
            bot.raidCommitLeft = 0
          }
          return
        }
      }
    }

    // Hunt a nearby carrier (player or another bot) to set up a slide
    // Slightly less hunt when UNO — prefer stealing lead homes
    if (bot.slideCd <= 1.5 && Math.random() < (uno ? 0.18 : 0.28)) {
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
      if (bot.stack.length === 0) {
        bot.raidSlot = raid.slot
        bot.raidCommitLeft = 8
      }
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

  private findRaid(
    bot: OfflineBot,
  ): { x: number; z: number; slot: number } | null {
    if (!this.homes) return null
    const top = bot.stack.length ? bot.stack[bot.stack.length - 1]! : null
    let best: { x: number; z: number; slot: number; score: number } | null =
      null
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
      // Prefer fatter piles; under UNO, hard-prefer homes of players close to win
      let score = -count + Math.random() * 0.4
      if (this.unoThreatSlots.has(slot)) {
        score -= 12 + count * 0.15
      }
      if (!best || score < best.score) {
        best = { x: c.x, z: c.z, slot, score }
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
