/**
 * Authoritative card world for LAN match.
 * No Three.js — pure state + events.
 */
import {
  cardSpawnConfig,
  cardsForSpawnWave,
  CARD_PICKUP_RADIUS,
} from '../shared/config/cards.ts'
import {
  getHomeSlot,
  HOME_FENCE_DEATH_MS,
  homeConfig,
  isInsideAnyHome,
  isInsideHomeSlot,
  isNearHomePile,
} from '../shared/config/home.ts'
import {
  TRAINING_DUMMY_ID,
  TRAINING_DUMMY_STACK,
} from '../shared/config/dummy.ts'
import {
  createRandomCards,
  createSkipTrap,
  createStunBat,
} from '../shared/uno/deck.ts'
import { canStackOn } from '../shared/uno/rules.ts'
import {
  ATTACK_CONE_DEG,
  ATTACK_COOLDOWN_MS,
  ATTACK_RANGE,
  isHandItem,
  isSkipTrap,
  isStunBat,
  KNOCKBACK_DIST,
  KNOCKBACK_DURATION_MS,
  SKIP_TRAP_RADIUS,
  SKIP_TRAP_STUN_MS,
  SLIDE_BASE_DIST,
  SLIDE_COOLDOWN_MS,
  SLIDE_DIST_MIN_MULT,
  SLIDE_DIST_PENALTY_PER_CARD,
  SLIDE_DURATION_MS,
  SLIDE_HIT_RADIUS,
  SLIDE_RECOVER_MS,
  STUN_DROP_MAX,
  STUN_DURATION_MS,
  randomSlideDropCount,
  type UnoCardData,
} from '../shared/uno/types.ts'

export type PlacedTrap = {
  id: string
  ownerId: string
  x: number
  z: number
}

let trapIdSeq = 0
function nextTrapId(): string {
  trapIdSeq += 1
  return `trap_${trapIdSeq}_${Math.random().toString(36).slice(2, 7)}`
}

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
  /** Death (home fence) ends at this epoch ms (0 = alive). */
  deathUntil: number
  lastAttackAt: number
  /** After G-drop: cannot re-pick hand items until this epoch ms. */
  itemPickupBlockUntil: number
  /** Cannot slide until this epoch ms. */
  lastSlideAt: number
  /** Slide dash + recover lock ends at this epoch ms. */
  slideBusyUntil: number
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
  onAttackHit: (
    attackerId: string,
    victimId: string,
    dropped: number,
    knock: {
      fromX: number
      fromY: number
      fromZ: number
      toX: number
      toY: number
      toZ: number
      durationMs: number
    },
  ) => void
  onAttackMiss: (attackerId: string) => void
  onSlide: (info: {
    playerId: string
    fromX: number
    fromY: number
    fromZ: number
    toX: number
    toY: number
    toZ: number
    durationMs: number
    recoverMs: number
    hitVictimId: string | null
  }) => void
  onTrapPlaced: (trap: PlacedTrap) => void
  onTrapRemoved: (trapId: string, reason: 'triggered' | 'cleared') => void
  onTrapTriggered: (info: {
    trapId: string
    ownerId: string
    victimId: string
  }) => void
  /** Full ground replace (client must clear then add). */
  onGroundSnapshot: (cards: GroundCard[]) => void
  /** Home slots with active electric fence (owner standing on platform). */
  onHomeFences: (active: number[]) => void
  onPlayerDied: (info: {
    playerId: string
    fenceHomeIndex: number
    until: number
    durationMs: number
  }) => void
  onPlayerRespawned: (info: {
    playerId: string
    x: number
    y: number
    z: number
  }) => void
}

export class GameSim {
  private ground: GroundCard[] = []
  private players = new Map<string, PlayerGameState>()
  /** Placed skip traps (no lifetime; removed on step). */
  private traps: PlacedTrap[] = []
  private spawnTimer = 0
  private started = false
  /** When > 0, refill dummy backpack after this epoch ms. */
  private dummyRefillAt = 0
  /** Off by default; debug button spawns hit-target + backpack. */
  private dummyActive = false
  /** Last broadcast fence set (slot indices). */
  private lastFenceActive: number[] = []
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
    this.dummyActive = false
    // Dummy stays off until a client enables it (debug button).
    this.players.delete(TRAINING_DUMMY_ID)
    this.spawnCards(cardSpawnConfig.initialCount)
  }

  isTrainingDummyActive(): boolean {
    return this.dummyActive
  }

  /**
   * Fully spawn or despawn the training dummy (hit target, backpack, refill).
   * Returns the resulting active state.
   */
  setTrainingDummyActive(active: boolean): boolean {
    if (!this.started) return false
    if (active) {
      if (!this.players.has(TRAINING_DUMMY_ID)) {
        this.addPlayer(TRAINING_DUMMY_ID, 0)
      }
      this.dummyActive = true
      this.refillTrainingDummy()
      return true
    }
    this.dummyActive = false
    this.dummyRefillAt = 0
    const p = this.players.get(TRAINING_DUMMY_ID)
    if (p) {
      p.stack = []
      p.item = null
      p.stunUntil = 0
      this.events.onPrivateState(TRAINING_DUMMY_ID, [], p.score, null)
      this.players.delete(TRAINING_DUMMY_ID)
    } else {
      this.events.onPrivateState(TRAINING_DUMMY_ID, [], 0, null)
    }
    this.clearStunDropCards()
    this.emitScores()
    return false
  }

  /** Stationary target at arena center for stun testing. */
  ensureTrainingDummy(): void {
    this.setTrainingDummyActive(true)
  }

  refillTrainingDummy(): void {
    if (!this.dummyActive) return
    const p = this.players.get(TRAINING_DUMMY_ID)
    if (!p) return
    // Remove previous stun-drop cards so the arena does not pile up forever
    this.clearStunDropCards()
    p.stack = createRandomCards(TRAINING_DUMMY_STACK, Math.random, {
      stunFraction: 0,
      skipFraction: 0,
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
      deathUntil: 0,
      lastAttackAt: 0,
      itemPickupBlockUntil: 0,
      lastSlideAt: 0,
      slideBusyUntil: 0,
    })
  }

  /** Full reset for a new match in the same room (optional later). */
  resetMatch(): void {
    this.clearAllTraps()
    this.ground = []
    this.spawnTimer = 0
    this.started = false
    this.dummyRefillAt = 0
    this.dummyActive = false
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
      p.deathUntil = 0
      p.lastAttackAt = 0
      p.itemPickupBlockUntil = 0
      p.lastSlideAt = 0
      p.slideBusyUntil = 0
    }
    this.lastFenceActive = []
    this.events.onHomeFences([])
  }

  getTrapsSnapshot(): PlacedTrap[] {
    return this.traps.map((t) => ({ ...t }))
  }

  private clearAllTraps(): void {
    if (!this.traps.length) return
    const ids = this.traps.map((t) => t.id)
    this.traps = []
    for (const id of ids) {
      this.events.onTrapRemoved(id, 'cleared')
    }
  }

  isStunned(playerId: string, now = Date.now()): boolean {
    const p = this.players.get(playerId)
    return !!p && p.stunUntil > now
  }

  isDead(playerId: string, now = Date.now()): boolean {
    const p = this.players.get(playerId)
    return !!p && p.deathUntil > now
  }

  /** Dead, stunned, or mid slide/recover — no pickup / attack / slide. */
  isActionLocked(playerId: string, now = Date.now()): boolean {
    const p = this.players.get(playerId)
    if (!p) return true
    return p.deathUntil > now || p.stunUntil > now || p.slideBusyUntil > now
  }

  /** Last computed active fence slots (for bot pathing). */
  getLastFenceActive(): readonly number[] {
    return this.lastFenceActive
  }

  /** Home slots currently powered (owner on platform). Needs live poses. */
  getActiveFenceHomes(
    poses: Map<string, { x: number; y: number; z: number }>,
  ): number[] {
    const active: number[] = []
    const now = Date.now()
    for (const [id, p] of this.players) {
      if (id === TRAINING_DUMMY_ID) continue
      if (p.deathUntil > now) continue
      const pos = poses.get(id)
      if (!pos) continue
      if (isInsideHomeSlot(p.homeIndex, pos.x, pos.z)) {
        active.push(p.homeIndex)
      }
    }
    return active.sort((a, b) => a - b)
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
      const n = cardsForSpawnWave(room)
      if (n > 0) this.spawnCards(n)
    }

    // Step on skip traps before interact (stunned victims still trigger? no — only walking)
    this.checkTrapSteps(poses)

    // Home electric fence: owner home → zap intruders; then respawns
    this.checkHomeFences(poses)
    this.processRespawns(poses)

    for (const [playerId, pose] of poses) {
      if (playerId === TRAINING_DUMMY_ID) continue
      // Dead / stunned / slide recover: no pickup / deposit / steal
      if (this.isActionLocked(playerId)) continue
      this.tryInteract(playerId, pose.x, pose.z)
    }

    if (
      this.dummyActive &&
      this.dummyRefillAt > 0 &&
      Date.now() >= this.dummyRefillAt
    ) {
      this.dummyRefillAt = 0
      this.refillTrainingDummy()
    }
  }

  /**
   * Other players step on skip traps → stun 2s; owner never triggers own trap.
   * Traps have no duration limit; removed only when triggered.
   */
  private checkTrapSteps(
    poses: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (!this.traps.length) return
    const now = Date.now()
    const triggered: string[] = []

    for (const trap of this.traps) {
      for (const [playerId, pose] of poses) {
        if (playerId === TRAINING_DUMMY_ID) continue
        if (playerId === trap.ownerId) continue
        if (this.isStunned(playerId, now) || this.isDead(playerId, now)) continue
        const d = Math.hypot(pose.x - trap.x, pose.z - trap.z)
        if (d > SKIP_TRAP_RADIUS) continue

        const vic = this.players.get(playerId)
        if (!vic) continue
        vic.stunUntil = now + SKIP_TRAP_STUN_MS
        this.events.onStunned(playerId, vic.stunUntil, SKIP_TRAP_STUN_MS)
        this.events.onTrapTriggered({
          trapId: trap.id,
          ownerId: trap.ownerId,
          victimId: playerId,
        })
        triggered.push(trap.id)
        break
      }
    }

    if (!triggered.length) return
    this.traps = this.traps.filter((t) => {
      if (!triggered.includes(t.id)) return true
      this.events.onTrapRemoved(t.id, 'triggered')
      return false
    })
  }

  /** Immediate interaction after a pose update (no spawn). */
  interactOne(
    playerId: string,
    x: number,
    z: number,
    poses?: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (!this.started) return
    if (this.isActionLocked(playerId)) return
    // Fast path: zap on step-in before steal / deposit
    if (poses) {
      const active = this.getActiveFenceHomes(poses)
      const slot = this.homeSlotAt(x, z)
      const p = this.players.get(playerId)
      if (
        p &&
        slot !== null &&
        slot !== p.homeIndex &&
        active.includes(slot)
      ) {
        const pos = poses.get(playerId) ?? { x, y: 1, z }
        this.electrocute(playerId, pos, slot, poses)
        return
      }
    }
    this.tryInteract(playerId, x, z)
  }

  /** Dev/test: force hand item (replaces current). */
  debugGiveItem(playerId: string, kind: 'stun_bat' | 'skip_trap'): void {
    if (!this.started) return
    if (playerId === TRAINING_DUMMY_ID) return
    const p = this.players.get(playerId)
    if (!p) return
    p.item = kind === 'skip_trap' ? createSkipTrap() : createStunBat()
    p.itemPickupBlockUntil = 0
    this.events.onPrivateState(playerId, [...p.stack], p.score, p.item)
    this.emitScores()
  }

  /**
   * Drop hand item in front of the player (same burst as stun_drop loot).
   * Facing from yaw: (sin, cos) on XZ.
   * Throw beyond pickup radius + short re-pickup block so G does not auto re-grab.
   */
  tryDiscardItem(
    playerId: string,
    yaw: number,
    poses: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (!this.started) return
    const now = Date.now()
    const p = this.players.get(playerId)
    if (!p || !p.item || this.isActionLocked(playerId, now)) return
    const pos = poses.get(playerId)
    if (!pos) return

    const card = p.item
    p.item = null
    // Prevent instant re-pickup (throw was inside CARD_PICKUP_RADIUS before)
    p.itemPickupBlockUntil = now + 800
    this.events.onPrivateState(playerId, [...p.stack], p.score, null)

    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    // Must land outside pickup radius when standing still
    const throwDist = CARD_PICKUP_RADIUS + 0.85
    const dropped: GroundCard = {
      card,
      x: pos.x + fx * throwDist,
      y: 0.55,
      z: pos.z + fz * throwDist,
      source: 'stun_drop',
    }
    this.ground.push(dropped)
    this.events.onSpawn([dropped], {
      burstFrom: { x: pos.x, y: pos.y, z: pos.z },
    })
    this.emitScores()
  }

  /**
   * Use hand item:
   * - stun bat: melee cone; on hit stun 1.5s + drop cards, consume bat
   * - skip trap: place trap under feet immediately, consume item
   */
  tryAttack(
    attackerId: string,
    yaw: number,
    poses: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (!this.started) return
    const now = Date.now()
    const atk = this.players.get(attackerId)
    if (!atk || this.isActionLocked(attackerId, now)) return
    if (now - atk.lastAttackAt < ATTACK_COOLDOWN_MS) return
    if (!atk.item) return

    const ap = poses.get(attackerId)
    if (!ap) return

    // Skip trap: place at feet (always succeeds if holding skip)
    if (isSkipTrap(atk.item)) {
      atk.lastAttackAt = now
      atk.item = null
      this.events.onPrivateState(attackerId, [...atk.stack], atk.score, null)
      const trap: PlacedTrap = {
        id: nextTrapId(),
        ownerId: attackerId,
        x: ap.x,
        z: ap.z,
      }
      this.traps.push(trap)
      this.events.onTrapPlaced(trap)
      return
    }

    if (!isStunBat(atk.item)) return

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

    this.applyVictimHit(attackerId, bestId, fx, fz, poses, now)
  }

  /**
   * Empty-hand slide tackle: dash forward, hit first non-stunned body on path.
   * Hit effects = mace knock + card drop. Recover hardstun same on hit/miss.
   */
  trySlide(
    attackerId: string,
    yaw: number,
    poses: Map<string, { x: number; y: number; z: number }>,
  ): void {
    if (!this.started) return
    const now = Date.now()
    const atk = this.players.get(attackerId)
    if (!atk || this.isActionLocked(attackerId, now)) return
    if (atk.item) return // has prop → use attack instead
    if (now - atk.lastSlideAt < SLIDE_COOLDOWN_MS) return

    const ap = poses.get(attackerId)
    if (!ap) return

    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    const mult = Math.max(
      SLIDE_DIST_MIN_MULT,
      1 - SLIDE_DIST_PENALTY_PER_CARD * atk.stack.length,
    )
    const dist = SLIDE_BASE_DIST * mult
    const lim = 17
    const toX = Math.max(-lim, Math.min(lim, ap.x + fx * dist))
    const toZ = Math.max(-lim, Math.min(lim, ap.z + fz * dist))

    // First non-stunned target near the slide segment
    let bestId: string | null = null
    let bestT = Infinity
    for (const [id] of this.players) {
      if (id === attackerId) continue
      if (this.isStunned(id, now) || this.isDead(id, now)) continue // 眩晕/死亡不能被铲
      const pos = poses.get(id)
      if (!pos) continue
      const hit = pointNearSegment(
        pos.x,
        pos.z,
        ap.x,
        ap.z,
        toX,
        toZ,
        SLIDE_HIT_RADIUS,
      )
      if (!hit) continue
      if (hit.t < bestT) {
        bestT = hit.t
        bestId = id
      }
    }

    atk.lastSlideAt = now
    atk.slideBusyUntil = now + SLIDE_DURATION_MS + SLIDE_RECOVER_MS
    poses.set(attackerId, { x: toX, y: ap.y, z: toZ })

    this.events.onSlide({
      playerId: attackerId,
      fromX: ap.x,
      fromY: ap.y,
      fromZ: ap.z,
      toX,
      toY: ap.y,
      toZ,
      durationMs: SLIDE_DURATION_MS,
      recoverMs: SLIDE_RECOVER_MS,
      hitVictimId: bestId,
    })

    if (bestId) {
      // Slide: random 1–4 cards (capped by backpack)
      this.applyVictimHit(attackerId, bestId, fx, fz, poses, now, {
        dropCount: randomSlideDropCount(this.players.get(bestId)?.stack.length ?? 0),
      })
    }
  }

  /** Shared knockback + backpack drop + stun (mace / slide). */
  private applyVictimHit(
    attackerId: string,
    victimId: string,
    dirX: number,
    dirZ: number,
    poses: Map<string, { x: number; y: number; z: number }>,
    now: number,
    opts?: { dropCount?: number },
  ): void {
    const vic = this.players.get(victimId)
    const vp = poses.get(victimId)
    if (!vic || !vp) return
    if (this.isStunned(victimId, now) || this.isDead(victimId, now)) return

    let kx = dirX
    let kz = dirZ
    const awayX = vp.x - (poses.get(attackerId)?.x ?? vp.x - dirX)
    const awayZ = vp.z - (poses.get(attackerId)?.z ?? vp.z - dirZ)
    const awayLen = Math.hypot(awayX, awayZ)
    if (awayLen > 0.05) {
      kx = awayX / awayLen
      kz = awayZ / awayLen
    }
    const lim = 17
    const toX = Math.max(-lim, Math.min(lim, vp.x + kx * KNOCKBACK_DIST))
    const toZ = Math.max(-lim, Math.min(lim, vp.z + kz * KNOCKBACK_DIST))
    const knock = {
      fromX: vp.x,
      fromY: vp.y,
      fromZ: vp.z,
      toX,
      toY: vp.y,
      toZ,
      durationMs: KNOCKBACK_DURATION_MS,
    }
    poses.set(victimId, { x: toX, y: vp.y, z: toZ })

    // Mace default: up to STUN_DROP_MAX; slide passes random 1–4 via opts.dropCount
    const dropN =
      opts?.dropCount != null
        ? Math.min(opts.dropCount, vic.stack.length)
        : Math.min(STUN_DROP_MAX, vic.stack.length)
    const dropped: GroundCard[] = []
    let removed = 0
    for (let guard = 0; guard < 32 && removed < dropN && vic.stack.length; guard++) {
      const top = vic.stack[vic.stack.length - 1]!
      if (isHandItem(top)) {
        vic.stack.pop()
        continue
      }
      const card = vic.stack.pop()
      if (!card) break
      const ang = (removed / Math.max(1, dropN)) * Math.PI * 2 + 0.35
      const rad = 0.7 + (removed % 2) * 0.45
      const mix = 0.55 + removed * 0.08
      const cx = vp.x + (toX - vp.x) * mix
      const cz = vp.z + (toZ - vp.z) * mix
      dropped.push({
        card,
        x: cx + Math.cos(ang) * rad,
        y: 0.55,
        z: cz + Math.sin(ang) * rad,
        source: 'stun_drop',
      })
      removed++
    }
    if (dropped.length) {
      this.ground.push(...dropped)
      this.events.onSpawn(dropped, {
        burstFrom: { x: vp.x, y: vp.y + 0.6, z: vp.z },
      })
    }

    vic.stunUntil = now + STUN_DURATION_MS
    this.events.onStunned(victimId, vic.stunUntil, STUN_DURATION_MS)
    this.events.onPrivateState(victimId, [...vic.stack], vic.score, vic.item)
    this.events.onAttackHit(attackerId, victimId, dropped.length, knock)
    if (victimId === TRAINING_DUMMY_ID) {
      this.dummyRefillAt = now + STUN_DURATION_MS + 250
    }
    this.emitScores()
  }

  /**
   * Owner on platform → fence on; non-owner on that platform → die, drop all.
   */
  private checkHomeFences(
    poses: Map<string, { x: number; y: number; z: number }>,
  ): void {
    const active = this.getActiveFenceHomes(poses)
    const same =
      active.length === this.lastFenceActive.length &&
      active.every((v, i) => v === this.lastFenceActive[i])
    if (!same) {
      this.lastFenceActive = active
      this.events.onHomeFences(active)
    }

    const now = Date.now()
    const activeSet = new Set(active)
    for (const [playerId, pose] of poses) {
      if (playerId === TRAINING_DUMMY_ID) continue
      const p = this.players.get(playerId)
      if (!p || p.deathUntil > now) continue
      const slot = this.homeSlotAt(pose.x, pose.z)
      if (slot === null || slot === p.homeIndex) continue
      if (!activeSet.has(slot)) continue
      this.electrocute(playerId, pose, slot, poses)
    }
  }

  private processRespawns(
    poses: Map<string, { x: number; y: number; z: number }>,
  ): void {
    const now = Date.now()
    for (const [playerId, p] of this.players) {
      if (playerId === TRAINING_DUMMY_ID) continue
      if (p.deathUntil <= 0 || p.deathUntil > now) continue
      p.deathUntil = 0
      p.stunUntil = 0
      p.slideBusyUntil = 0
      const sp = getHomeSlot(p.homeIndex).spawn
      poses.set(playerId, { x: sp.x, y: sp.y, z: sp.z })
      this.events.onPlayerRespawned({
        playerId,
        x: sp.x,
        y: sp.y,
        z: sp.z,
      })
    }
  }

  /** Full inventory drop + death timer; no card kept from this home. */
  private electrocute(
    playerId: string,
    pose: { x: number; y: number; z: number },
    fenceHomeIndex: number,
    _poses: Map<string, { x: number; y: number; z: number }>,
  ): void {
    const p = this.players.get(playerId)
    if (!p) return
    const now = Date.now()
    if (p.deathUntil > now) return

    const dropCards: UnoCardData[] = [...p.stack]
    if (p.item) dropCards.push(p.item)
    p.stack = []
    p.item = null
    p.lastIllegalCardId = null
    p.stolenFromHomes.clear()
    p.stunUntil = 0
    p.slideBusyUntil = 0
    p.deathUntil = now + HOME_FENCE_DEATH_MS

    if (dropCards.length) {
      const dropped: GroundCard[] = dropCards.map((card, i) => {
        const ang = (i / Math.max(1, dropCards.length)) * Math.PI * 2 + 0.2
        const rad = 0.55 + (i % 3) * 0.35
        return {
          card,
          x: pose.x + Math.cos(ang) * rad,
          y: 0.55,
          z: pose.z + Math.sin(ang) * rad,
          source: 'stun_drop' as const,
        }
      })
      this.ground.push(...dropped)
      this.events.onSpawn(dropped, {
        burstFrom: { x: pose.x, y: pose.y + 0.6, z: pose.z },
      })
    }

    this.events.onPrivateState(playerId, [], p.score, null)
    this.events.onPlayerDied({
      playerId,
      fenceHomeIndex,
      until: p.deathUntil,
      durationMs: HOME_FENCE_DEATH_MS,
    })
    this.emitScores()
  }

  private tryInteract(playerId: string, x: number, z: number): void {
    const p = this.players.get(playerId)
    if (!p) return
    if (this.isActionLocked(playerId)) return

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

    // Other player's home: steal only on the deposit pile (center), not platform edge
    const foreignSlot = this.homeSlotAt(x, z)
    if (foreignSlot !== null && foreignSlot !== p.homeIndex) {
      // Safety: never steal while that home's fence is listed active
      if (this.lastFenceActive.includes(foreignSlot)) return
      if (!isNearHomePile(foreignSlot, x, z)) return
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

    // Hand items (mace / skip) → hand slot only; one at a time (mutually exclusive)
    if (isHandItem(nearest.card)) {
      if (p.item) {
        if (p.lastIllegalCardId !== nearest.card.id) {
          p.lastIllegalCardId = nearest.card.id
          // reuse illegal with same card as top for "hands full"
          this.events.onIllegal(playerId, nearest.card, nearest.card, 'stack')
        }
        return
      }
      // Grace after G-drop so the thrown item is not instantly reclaimed
      if (Date.now() < p.itemPickupBlockUntil) return
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

/** Point-to-segment hit test in XZ. t in [0,1] along segment. */
function pointNearSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  radius: number,
): { t: number; dist: number } | null {
  const abx = bx - ax
  const abz = bz - az
  const len2 = abx * abx + abz * abz
  let t = 0
  if (len2 > 1e-8) {
    t = ((px - ax) * abx + (pz - az) * abz) / len2
    t = Math.max(0, Math.min(1, t))
  }
  const cx = ax + abx * t
  const cz = az + abz * t
  const dist = Math.hypot(px - cx, pz - cz)
  if (dist > radius) return null
  return { t, dist }
}
