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
  STUN_DROP_MAX,
  STUN_DURATION_MS,
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
    for (let i = 0; i < n; i++) {
      const homeIndex = i + 1
      const sp = getHomeSlot(homeIndex).spawn
      const id = `offline_bot_${i + 1}`
      const name = `Bot${i + 1}`
      const bot: OfflineBot = {
        id,
        name,
        homeIndex,
        x: sp.x,
        z: sp.z,
        yaw: 0,
        stack: [],
        score: 0,
        mode: 'seek',
        targetX: sp.x,
        targetZ: sp.z,
        retargetT: 0,
        stunUntil: 0,
        deathUntil: 0,
        stolenFromHomes: new Set(),
        slideCd: 2 + Math.random() * 3,
        raidCd: Math.random() * 2,
      }
      this.bots.push(bot)
      remotes.upsert(id, name, homeIndex)
      remotes.pushPoseNow(id, bot.x, STAND_Y, bot.z, bot.yaw)
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
        const sp = getHomeSlot(bot.homeIndex).spawn
        bot.x = sp.x
        bot.z = sp.z
        bot.deathUntil = 0
        bot.stunUntil = 0
        bot.stack = []
        bot.stolenFromHomes.clear()
        this.remotes.setPlayerStack(bot.id, [])
      }

      this.tickOne(bot, dt, player, now)
      this.remotes.pushPoseNow(bot.id, bot.x, STAND_Y, bot.z, bot.yaw)
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

    // Occasional slide at player
    if (
      bot.slideCd <= 0 &&
      bot.stack.length < MAX_CARRY &&
      !player.dead &&
      !player.stunned
    ) {
      const dPlayer = Math.hypot(player.x - bot.x, player.z - bot.z)
      if (dPlayer < BOT_SLIDE_ENGAGE && dPlayer > 0.35 && Math.random() < 0.4) {
        this.botTrySlide(bot, player)
        bot.slideCd = BOT_SLIDE_CD + Math.random() * 2.5
        return
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

  private botTrySlide(bot: OfflineBot, player: OfflinePlayerSnap): void {
    const yaw = Math.atan2(player.x - bot.x, player.z - bot.z)
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    const dist = SLIDE_BASE_DIST * 0.85
    const lim = 17
    const fromX = bot.x
    const fromZ = bot.z
    const toX = Math.max(-lim, Math.min(lim, bot.x + fx * dist))
    const toZ = Math.max(-lim, Math.min(lim, bot.z + fz * dist))

    // Move bot along slide path instantly (logic); visual via remote slide if available
    const hit = pointNearSegment(
      player.x,
      player.z,
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
    bot.stunUntil = Date.now() + SLIDE_DURATION_MS + SLIDE_RECOVER_MS

    if (hit && this.onHitPlayer) {
      const kx = player.x - fromX
      const kz = player.z - fromZ
      const len = Math.hypot(kx, kz) || 1
      const dirX = kx / len
      const dirZ = kz / len
      const pToX = Math.max(
        -lim,
        Math.min(lim, player.x + dirX * KNOCKBACK_DIST),
      )
      const pToZ = Math.max(
        -lim,
        Math.min(lim, player.z + dirZ * KNOCKBACK_DIST),
      )
      this.onHitPlayer({
        fromX: player.x,
        fromZ: player.z,
        toX: pToX,
        toZ: pToZ,
        dirX,
        dirZ,
        durationMs: KNOCKBACK_DURATION_MS,
      })
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

    // Hunt player to set up slide
    if (
      bot.slideCd <= 1.5 &&
      !player.dead &&
      Math.random() < 0.28
    ) {
      bot.mode = 'hunt'
      bot.targetX = player.x
      bot.targetZ = player.z
      return
    }

    const ground = cards.listGround()
    const top = bot.stack.length ? bot.stack[bot.stack.length - 1]! : null
    let best: { x: number; z: number; d: number } | null = null
    for (const g of ground) {
      if (top && !canStackOn(top, g.card)) continue
      const d = Math.hypot(g.x - bot.x, g.z - bot.z)
      if (!best || d < best.d) best = { x: g.x, z: g.z, d }
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

    bot.mode = 'wander'
    bot.targetX = (Math.random() * 2 - 1) * 10
    bot.targetZ = (Math.random() * 2 - 1) * 10
    void homes
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

    const dropN = Math.min(STUN_DROP_MAX, bot.stack.length)
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
