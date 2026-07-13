/**
 * Authoritative card world for LAN match.
 * No Three.js — pure state + events.
 */
import { cardSpawnConfig, CARD_PICKUP_RADIUS } from '../shared/config/cards.ts'
import {
  getHomeSlot,
  homeConfig,
  isInsideAnyHome,
  isInsideHomeSlot,
} from '../shared/config/home.ts'
import {
  TRAINING_DUMMY_ID,
  TRAINING_DUMMY_STACK,
} from '../shared/config/dummy.ts'
import { createRandomCards } from '../shared/uno/deck.ts'
import { canStackOn } from '../shared/uno/rules.ts'
import {
  ATTACK_CONE_DEG,
  ATTACK_COOLDOWN_MS,
  ATTACK_RANGE,
  isStunBat,
  STUN_DROP_MAX,
  STUN_DURATION_MS,
  type UnoCardData,
} from '../shared/uno/types.ts'

export type GroundCard = {
  card: UnoCardData
  x: number
  y: number
  z: number
  /** field = spawner; stun_drop = knocked off a backpack (cleared on dummy refill). */
  source?: 'field' | 'stun_drop'
}

export type PlayerGameState = {
  stack: UnoCardData[]
  /** Hand weapon (stun bat etc.) — not in backpack. */
  item: UnoCardData | null
  /** Cards delivered to own home (stealable from top). */
  homePile: UnoCardData[]
  score: number
  lastIllegalCardId: string | null
  /** Corner home 0–3; only deposit inside own home. */
  homeIndex: number
  /**
   * Home slots already stolen from during this backpack trip.
   * Cleared when depositing at own home.
   */
  stolenFromHomes: Set<number>
  /** Stun ends at this epoch ms (0 = not stunned). */
  stunUntil: number
  lastAttackAt: number
}

export type GameSimEvents = {
  onSpawn: (
    cards: GroundCard[],
    opts?: { burstFrom?: { x: number; y: number; z: number } },
  ) => void
  onPicked: (info: {
    playerId: string
    card: UnoCardData
    stackCount: number
    groundCardId: string
  }) => void
  onIllegal: (
    playerId: string,
    card: UnoCardData,
    top: UnoCardData,
    reason?: 'stack' | 'home_once',
  ) => void
  onClearIllegal: (playerId: string) => void
  onDeposited: (info: {
    playerId: string
    cards: UnoCardData[]
    score: number
  }) => void
  onHomeStolen: (info: {
    thiefId: string
    victimId: string
    victimHomeIndex: number
    card: UnoCardData
    thiefStackCount: number
    victimScore: number
  }) => void
  onPrivateState: (
    playerId: string,
    stack: UnoCardData[],
    score: number,
    item: UnoCardData | null,
  ) => void
  onScores: (scores: { id: string; score: number; stackCount: number }[]) => void
  onStunned: (playerId: string, until: number, durationMs: number) => void
  onAttackHit: (attackerId: string, victimId: string, dropped: number) => void
  onAttackMiss: (attackerId: string) => void
  /** Full ground replace (client must clear then add). */
  onGroundSnapshot: (cards: GroundCard[]) => void
}

export class GameSim {
  private ground: GroundCard[] = []
  private players = new Map<string, PlayerGameState>()
  private spawnTimer = 0
  private started = false
  /** When > 0, refill dummy backpack after this epoch ms. */
  private dummyRefillAt = 0
  private readonly events: GameSimEvents

  constructor(events: GameSimEvents) {
    this.events = events
  }

  /** Host pressed start — spawn field cards. Call after all players added. */
  startMatch(): void {
    if (this.started) return
    this.started = true
    this.spawnTimer = 0
    this.dummyRefillAt = 0
    // Register dummy hit target; stack filled after match_start so clients see it.
    if (!this.players.has(TRAINING_DUMMY_ID)) {
      this.addPlayer(TRAINING_DUMMY_ID, 0)
    }
    this.spawnCards(cardSpawnConfig.initialCount)
  }

  /** Stationary target at arena center for stun testing. */
  ensureTrainingDummy(): void {
    if (!this.players.has(TRAINING_DUMMY_ID)) {
      this.addPlayer(TRAINING_DUMMY_ID, 0)
    }
    this.refillTrainingDummy()
  }

  refillTrainingDummy(): void {
    const p = this.players.get(TRAINING_DUMMY_ID)
    if (!p) return
    // Remove previous stun-drop cards so the arena does not pile up forever
    this.clearStunDropCards()
    p.stack = createRandomCards(TRAINING_DUMMY_STACK, Math.random, {
      stunFraction: 0,
    })
    p.item = null
    p.stunUntil = 0
    this.events.onPrivateState(TRAINING_DUMMY_ID, [...p.stack], p.score, null)
    this.emitScores()
  }

  /**
   * Remove stun-drop piles (and legacy unmarked cards near dummy).
   * Field spawns keep source:'field' and are preserved.
   */
  clearStunDropCards(): void {
    const before = this.ground.length
    this.ground = this.ground.filter((g) => {
      if (g.source === 'stun_drop') return false
      if (g.source === 'field') return true
      // Legacy unmarked: treat near-dummy piles as drops to clear on refresh
      return Math.hypot(g.x, g.z) >= 2.8
    })
    if (this.ground.length !== before) {
      this.events.onGroundSnapshot(this.ground)
    }
  }

  /** Force full ground resync to all clients (e.g. after reconnect hygiene). */
  broadcastGroundSnapshot(): void {
    this.events.onGroundSnapshot(this.ground)
  }

  get isMatchStarted(): boolean {
    return this.started
  }

  /** Register player for score/stack; does NOT start the match. */
  addPlayer(playerId: string, homeIndex = 0): void {
    const existing = this.players.get(playerId)
    if (existing) {
      existing.homeIndex = homeIndex
      return
    }
    this.players.set(playerId, {
      stack: [],
      item: null,
      homePile: [],
      score: 0,
      lastIllegalCardId: null,
      homeIndex,
      stolenFromHomes: new Set(),
      stunUntil: 0,
      lastAttackAt: 0,
    })
  }

  /** Full reset for a new match in the same room (optional later). */
  resetMatch(): void {
    this.ground = []
    this.spawnTimer = 0
    this.started = false
    this.dummyRefillAt = 0
    // Drop dummy so startMatch can re-add cleanly
    this.players.delete(TRAINING_DUMMY_ID)
    for (const p of this.players.values()) {
      p.stack = []
      p.item = null
      p.homePile = []
      p.score = 0
      p.lastIllegalCardId = null
      p.stolenFromHomes.clear()
      p.stunUntil = 0
      p.lastAttackAt = 0
    }
  }

  isStunned(playerId: string, now = Date.now()): boolean {
    const p = this.players.get(playerId)
    return !!p && p.stunUntil > now
  }

  removePlayer(playerId: string, dropAt: { x: number; z: number } | null): void {
    const p = this.players.get(playerId)
    if (!p) return
    if (dropAt) {
      const cards = [...p.stack]
      if (p.item) cards.push(p.item)
      if (cards.length) {
        const dropped: GroundCard[] = cards.map((card, i) => ({
          card,
          x: dropAt.x + (i % 3) * 0.35,
          y: 0.55,
          z: dropAt.z + Math.floor(i / 3) * 0.35,
        }))
        this.ground.push(...dropped)
        this.events.onSpawn(dropped)
      }
    }
    this.players.delete(playerId)
    this.emitScores()
  }

  getGroundSnapshot(): GroundCard[] {
    return this.ground.map((g) => ({
      card: { ...g.card },
      x: g.x,
      y: g.y,
      z: g.z,
    }))
  }

  getPlayerState(playerId: string): PlayerGameState | null {
    return this.players.get(playerId) ?? null
  }

  /** All backpacks for public avatar sync / reconnect. */
  getAllStacks(): { playerId: string; stack: UnoCardData[] }[] {
    return [...this.players.entries()].map(([playerId, p]) => ({
      playerId,
      stack: [...p.stack],
    }))
  }

  getScores(): { id: string; score: number; stackCount: number }[] {
    return [...this.players.entries()].map(([id, p]) => ({
      id,
      score: p.score,
      stackCount: p.stack.length,
    }))
  }

  /** Read-only ground cards for bot pathfinding. */
  listGround(): readonly GroundCard[] {
    return this.ground
  }

  /** Other players' home piles (for raid targeting). */
  listHomePiles(): { playerId: string; homeIndex: number; top: UnoCardData | null; count: number }[] {
    return [...this.players.entries()].map(([playerId, p]) => ({
      playerId,
      homeIndex: p.homeIndex,
      top: p.homePile.length ? p.homePile[p.homePile.length - 1]! : null,
      count: p.homePile.length,
    }))
  }

  /** World clock: spawn waves + interactions for all poses. */
  tick(
    dt: number,
    poses: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (!this.started) return

    this.spawnTimer += dt
    if (this.spawnTimer >= cardSpawnConfig.spawnIntervalSec) {
      this.spawnTimer = 0
      const room = cardSpawnConfig.maxOnField - this.ground.length
      if (room > 0) {
        const n = Math.min(cardSpawnConfig.spawnPerWave, room)
        this.spawnCards(n)
      }
    }

    for (const [playerId, pose] of poses) {
      if (playerId === TRAINING_DUMMY_ID) continue
      this.tryInteract(playerId, pose.x, pose.z)
    }

    if (this.dummyRefillAt > 0 && Date.now() >= this.dummyRefillAt) {
      this.dummyRefillAt = 0
      this.refillTrainingDummy()
    }
  }

  /** Immediate interaction after a pose update (no spawn). */
  interactOne(playerId: string, x: number, z: number): void {
    if (!this.started) return
    if (this.isStunned(playerId)) return
    this.tryInteract(playerId, x, z)
  }

  /**
   * Melee attack with hand item (stun bat) — not backpack.
   * On hit: stun 1.5s, drop up to 4 backpack cards, consume hand item.
   */
  tryAttack(
    attackerId: string,
    yaw: number,
    poses: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (!this.started) return
    const now = Date.now()
    const atk = this.players.get(attackerId)
    if (!atk || this.isStunned(attackerId, now)) return
    if (now - atk.lastAttackAt < ATTACK_COOLDOWN_MS) return

    if (!atk.item || !isStunBat(atk.item)) return

    const ap = poses.get(attackerId)
    if (!ap) return

    atk.lastAttackAt = now

    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    const cosHalf = Math.cos((ATTACK_CONE_DEG * Math.PI) / 180)

    let bestId: string | null = null
    let bestDist = Infinity

    for (const [id] of this.players) {
      if (id === attackerId) continue
      const pos = poses.get(id)
      if (!pos) continue
      const dx = pos.x - ap.x
      const dz = pos.z - ap.z
      const dist = Math.hypot(dx, dz)
      if (dist < 0.15 || dist > ATTACK_RANGE) continue
      const nx = dx / dist
      const nz = dz / dist
      const dot = nx * fx + nz * fz
      if (dot < cosHalf) continue
      if (dist < bestDist) {
        bestDist = dist
        bestId = id
      }
    }

    if (!bestId) {
      this.events.onAttackMiss(attackerId)
      return
    }

    // Consume attacker's hand weapon only on hit (not victim's item).
    atk.item = null
    this.events.onPrivateState(attackerId, [...atk.stack], atk.score, null)

    const vic = this.players.get(bestId)!
    // Drop only backpack numbers: min(4, stack). Never knock off victim hand item.
    // If a stun somehow sits in stack, leave it there (items are not backpack loot).
    const dropN = Math.min(STUN_DROP_MAX, vic.stack.length)
    const dropped: GroundCard[] = []
    const vp = poses.get(bestId)!
    let removed = 0
    // Walk from top; skip non-number (stun) cards in backpack
    for (let guard = 0; guard < 32 && removed < dropN && vic.stack.length; guard++) {
      const top = vic.stack[vic.stack.length - 1]!
      if (isStunBat(top)) {
        // Should not be in backpack — strip without spawning as loot
        vic.stack.pop()
        continue
      }
      const card = vic.stack.pop()
      if (!card) break
      const ang = (removed / Math.max(1, dropN)) * Math.PI * 2 + 0.4
      const rad = 0.85 + (removed % 2) * 0.35
      dropped.push({
        card,
        x: vp.x + Math.cos(ang) * rad,
        y: 0.55,
        z: vp.z + Math.sin(ang) * rad,
        source: 'stun_drop',
      })
      removed++
    }
    if (dropped.length) {
      this.ground.push(...dropped)
      this.events.onSpawn(dropped, {
        burstFrom: { x: vp.x, y: vp.y, z: vp.z },
      })
    }

    // Victim hand item (狼牙棒) is intentionally kept
    vic.stunUntil = now + STUN_DURATION_MS
    this.events.onStunned(bestId, vic.stunUntil, STUN_DURATION_MS)
    this.events.onPrivateState(bestId, [...vic.stack], vic.score, vic.item)
    this.events.onAttackHit(attackerId, bestId, dropped.length)
    // Dummy: auto-refill backpack shortly after stun so you can re-test
    if (bestId === TRAINING_DUMMY_ID) {
      this.dummyRefillAt = now + STUN_DURATION_MS + 250
    }
    this.emitScores()
  }

  private tryInteract(playerId: string, x: number, z: number): void {
    const p = this.players.get(playerId)
    if (!p) return

    // Own home: unload backpack → home pile (ends this steal trip).
    const inOwnHome = isInsideHomeSlot(p.homeIndex, x, z)
    if (inOwnHome) {
      if (p.stack.length > 0) {
        const cards = [...p.stack]
        p.stack = []
        p.homePile.push(...cards)
        p.score = p.homePile.length
        p.lastIllegalCardId = null
        p.stolenFromHomes.clear()
        this.events.onDeposited({ playerId, cards, score: p.score })
        this.events.onPrivateState(playerId, [], p.score, p.item)
        this.emitScores()
      } else if (p.lastIllegalCardId) {
        p.lastIllegalCardId = null
        this.events.onClearIllegal(playerId)
      }
      return
    }

    // Other player's home: steal at most 1 card per home per trip (UNO stack rules).
    const foreignSlot = this.homeSlotAt(x, z)
    if (foreignSlot !== null && foreignSlot !== p.homeIndex) {
      this.tryStealFromHome(playerId, p, foreignSlot)
      return
    }

    // Field cards
    let nearest: GroundCard | null = null
    let nearestDist = Infinity
    for (const g of this.ground) {
      const d = Math.hypot(g.x - x, g.z - z)
      if (d < nearestDist) {
        nearestDist = d
        nearest = g
      }
    }

    if (!nearest || nearestDist > CARD_PICKUP_RADIUS) {
      if (p.lastIllegalCardId) {
        p.lastIllegalCardId = null
        this.events.onClearIllegal(playerId)
      }
      return
    }

    // Item cards → hand slot only (never backpack)
    if (isStunBat(nearest.card)) {
      if (p.item) {
        if (p.lastIllegalCardId !== nearest.card.id) {
          p.lastIllegalCardId = nearest.card.id
          // reuse illegal with same card as top for "hands full"
          this.events.onIllegal(playerId, nearest.card, nearest.card, 'stack')
        }
        return
      }
      p.lastIllegalCardId = null
      this.ground = this.ground.filter((g) => g.card.id !== nearest!.card.id)
      p.item = nearest.card
      this.events.onPicked({
        playerId,
        card: nearest.card,
        stackCount: p.stack.length,
        groundCardId: nearest.card.id,
      })
      this.events.onPrivateState(playerId, [...p.stack], p.score, p.item)
      this.emitScores()
      return
    }

    const top = p.stack.length ? p.stack[p.stack.length - 1]! : null
    const legal = top === null || canStackOn(top, nearest.card)

    if (legal) {
      p.lastIllegalCardId = null
      this.ground = this.ground.filter((g) => g.card.id !== nearest!.card.id)
      p.stack.push(nearest.card)
      this.events.onPicked({
        playerId,
        card: nearest.card,
        stackCount: p.stack.length,
        groundCardId: nearest.card.id,
      })
      this.events.onPrivateState(playerId, [...p.stack], p.score, p.item)
      this.emitScores()
      return
    }

    if (p.lastIllegalCardId !== nearest.card.id) {
      p.lastIllegalCardId = nearest.card.id
      this.events.onIllegal(playerId, nearest.card, top!, 'stack')
    }
  }

  private homeSlotAt(x: number, z: number): number | null {
    for (let i = 0; i < 4; i++) {
      if (isInsideHomeSlot(i, x, z)) return i
    }
    return null
  }

  private tryStealFromHome(
    thiefId: string,
    thief: PlayerGameState,
    homeIndex: number,
  ): void {
    let victimId: string | null = null
    let victim: PlayerGameState | null = null
    for (const [id, pl] of this.players) {
      if (pl.homeIndex === homeIndex) {
        victimId = id
        victim = pl
        break
      }
    }
    if (!victim || !victimId) {
      if (thief.lastIllegalCardId) {
        thief.lastIllegalCardId = null
        this.events.onClearIllegal(thiefId)
      }
      return
    }

    if (victim.homePile.length === 0) {
      if (thief.lastIllegalCardId) {
        thief.lastIllegalCardId = null
        this.events.onClearIllegal(thiefId)
      }
      return
    }

    const homeTop = victim.homePile[victim.homePile.length - 1]!
    const onceKey = `home_once_${homeIndex}`

    if (thief.stolenFromHomes.has(homeIndex)) {
      if (thief.lastIllegalCardId !== onceKey) {
        thief.lastIllegalCardId = onceKey
        const packTop =
          thief.stack.length > 0
            ? thief.stack[thief.stack.length - 1]!
            : homeTop
        this.events.onIllegal(thiefId, homeTop, packTop, 'home_once')
      }
      return
    }

    const packTop = thief.stack.length ? thief.stack[thief.stack.length - 1]! : null
    const legal = packTop === null || canStackOn(packTop, homeTop)

    if (!legal) {
      if (thief.lastIllegalCardId !== homeTop.id) {
        thief.lastIllegalCardId = homeTop.id
        this.events.onIllegal(thiefId, homeTop, packTop!, 'stack')
      }
      return
    }

    victim.homePile.pop()
    victim.score = victim.homePile.length
    thief.stack.push(homeTop)
    thief.stolenFromHomes.add(homeIndex)
    thief.lastIllegalCardId = null

    this.events.onHomeStolen({
      thiefId,
      victimId,
      victimHomeIndex: homeIndex,
      card: homeTop,
      thiefStackCount: thief.stack.length,
      victimScore: victim.score,
    })
    this.events.onPrivateState(thiefId, [...thief.stack], thief.score, thief.item)
    this.events.onPrivateState(victimId, [...victim.stack], victim.score, victim.item)
    this.emitScores()
  }

  private spawnCards(count: number): void {
    if (count <= 0) return
    const data = createRandomCards(count)
    const placed: GroundCard[] = []
    for (const card of data) {
      const pos = this.randomGroundPos()
      placed.push({
        card,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        source: 'field',
      })
    }
    this.ground.push(...placed)
    this.events.onSpawn(placed)
  }

  private randomGroundPos(): { x: number; y: number; z: number } {
    const clear = homeConfig.cardSpawnClearRadius
    for (let i = 0; i < 80; i++) {
      const x = (Math.random() * 2 - 1) * 16
      const z = (Math.random() * 2 - 1) * 16
      if (isInsideAnyHome(x, z)) continue
      let nearHome = false
      for (let s = 0; s < 4; s++) {
        const c = getHomeSlot(s).center
        if (Math.hypot(x - c.x, z - c.z) < clear) {
          nearHome = true
          break
        }
      }
      if (nearHome) continue
      return { x, y: 0.55, z }
    }
    return { x: 0, y: 0.55, z: 0 }
  }

  private emitScores(): void {
    this.events.onScores(this.getScores())
  }
}
