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
import { createRandomCards } from '../shared/uno/deck.ts'
import { canStackOn } from '../shared/uno/rules.ts'
import type { UnoCardData } from '../shared/uno/types.ts'

export type GroundCard = {
  card: UnoCardData
  x: number
  y: number
  z: number
}

export type PlayerGameState = {
  stack: UnoCardData[]
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
}

export type GameSimEvents = {
  onSpawn: (cards: GroundCard[]) => void
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
  onPrivateState: (playerId: string, stack: UnoCardData[], score: number) => void
  onScores: (scores: { id: string; score: number; stackCount: number }[]) => void
}

export class GameSim {
  private ground: GroundCard[] = []
  private players = new Map<string, PlayerGameState>()
  private spawnTimer = 0
  private started = false
  private readonly events: GameSimEvents

  constructor(events: GameSimEvents) {
    this.events = events
  }

  /** Host pressed start — spawn field cards. Call after all players added. */
  startMatch(): void {
    if (this.started) return
    this.started = true
    this.spawnTimer = 0
    this.spawnCards(cardSpawnConfig.initialCount)
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
      homePile: [],
      score: 0,
      lastIllegalCardId: null,
      homeIndex,
      stolenFromHomes: new Set(),
    })
  }

  /** Full reset for a new match in the same room (optional later). */
  resetMatch(): void {
    this.ground = []
    this.spawnTimer = 0
    this.started = false
    for (const p of this.players.values()) {
      p.stack = []
      p.homePile = []
      p.score = 0
      p.lastIllegalCardId = null
      p.stolenFromHomes.clear()
    }
  }

  removePlayer(playerId: string, dropAt: { x: number; z: number } | null): void {
    const p = this.players.get(playerId)
    if (!p) return
    if (p.stack.length && dropAt) {
      const dropped: GroundCard[] = p.stack.map((card, i) => ({
        card,
        x: dropAt.x + (i % 3) * 0.35,
        y: 0.55,
        z: dropAt.z + Math.floor(i / 3) * 0.35,
      }))
      this.ground.push(...dropped)
      this.events.onSpawn(dropped)
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
      this.tryInteract(playerId, pose.x, pose.z)
    }
  }

  /** Immediate interaction after a pose update (no spawn). */
  interactOne(playerId: string, x: number, z: number): void {
    if (!this.started) return
    this.tryInteract(playerId, x, z)
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
        this.events.onPrivateState(playerId, [], p.score)
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
      this.events.onPrivateState(playerId, [...p.stack], p.score)
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
    this.events.onPrivateState(thiefId, [...thief.stack], thief.score)
    this.events.onPrivateState(victimId, [...victim.stack], victim.score)
    this.emitScores()
  }

  private spawnCards(count: number): void {
    if (count <= 0) return
    const data = createRandomCards(count)
    const placed: GroundCard[] = []
    for (const card of data) {
      const pos = this.randomGroundPos()
      placed.push({ card, x: pos.x, y: pos.y, z: pos.z })
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
