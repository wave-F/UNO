import * as THREE from 'three'
import { cardSpawnConfig } from '../config/cards'
import {
  getHomeSlot,
  homeConfig,
  isInsideAnyHome,
  isInsideHomeSlot,
} from '../config/home'
import { createRandomCards } from '../game/uno/deck'
import { canStackOn } from '../game/uno/rules'
import { cardLabel, type UnoCardData } from '../game/uno/types'
import { CardPickup } from '../entities/CardPickup'
import { CARD_PICKUP_RADIUS } from '../../shared/config/cards'
import type { GroundCardWire } from '../../shared/protocol'

export type PickupFeedback =
  | { type: 'picked'; card: UnoCardData; stack: UnoCardData[] }
  | {
      type: 'illegal'
      card: UnoCardData
      top: UnoCardData
      reason?: 'stack' | 'home_once'
    }
  | { type: 'clear_prompt' }
  | {
      type: 'deposited'
      cards: UnoCardData[]
      deliveredTotal: number
    }
  | { type: 'toast'; text: string; kind: 'ok' | 'bad' }

/**
 * Local authority (offline) or pure view driven by server (online).
 */
export class CardPickupSystem {
  readonly group = new THREE.Group()
  private cards = new Map<string, CardPickup>()
  private stack: UnoCardData[] = []
  private lastIllegalId: string | null = null
  private spawnTimer = 0
  private readonly tmp = new THREE.Vector3()
  /** offline = local sim; online = server is authority */
  private mode: 'offline' | 'online' = 'offline'
  private deliveredTotal = 0
  /** Offline + local online home corner (0–3). */
  private homeIndex: number = homeConfig.defaultSlot
  /** Offline: homes already stolen from this carry trip. */
  private stolenFromHomes = new Set<number>()
  /** Offline: slots with active electric fence (no steal). */
  private fencedSlots = new Set<number>()
  /** Offline: home yard for steal/deposit pile ops. */
  private homeYard: {
    slotAt: (x: number, z: number) => number | null
    getTop: (slot: number) => UnoCardData | null
    popTopFrom: (slot: number) => UnoCardData | null
    getCount: (slot: number) => number
  } | null = null
  /** Offline: blocked while dead / hard stun (Game sets). */
  private interactBlocked = false

  constructor(
    private onFeedback: (fb: PickupFeedback) => void,
    private onDepositToHome: (cards: UnoCardData[]) => number,
    initialCount = cardSpawnConfig.initialCount,
  ) {
    this.group.name = 'CardPickups'
    this.spawnLocal(initialCount)
  }

  getStack(): readonly UnoCardData[] {
    return this.stack
  }

  getTop(): UnoCardData | null {
    return this.stack.length ? this.stack[this.stack.length - 1]! : null
  }

  getDeliveredTotal(): number {
    return this.deliveredTotal
  }

  /** Switch to server-driven cards (clears local field). */
  enterOnlineMode(): void {
    this.mode = 'online'
    this.clearField()
    this.stack = []
    this.deliveredTotal = 0
    this.lastIllegalId = null
    this.stolenFromHomes.clear()
    this.fencedSlots.clear()
    this.homeYard = null
    this.interactBlocked = false
  }

  /** Leave room: restore local spawns. */
  enterOfflineMode(): void {
    this.mode = 'offline'
    this.clearField()
    this.stack = []
    this.deliveredTotal = 0
    this.lastIllegalId = null
    this.stolenFromHomes.clear()
    this.fencedSlots.clear()
    this.interactBlocked = false
    this.spawnTimer = 0
    this.spawnLocal(cardSpawnConfig.initialCount)
  }

  /** Wire home piles for offline steal. */
  setOfflineHomeYard(
    yard: {
      slotAt: (x: number, z: number) => number | null
      getTop: (slot: number) => UnoCardData | null
      popTopFrom: (slot: number) => UnoCardData | null
      getCount: (slot: number) => number
    } | null,
  ): void {
    this.homeYard = yard
  }

  setFencedSlots(slots: readonly number[]): void {
    this.fencedSlots = new Set(slots)
  }

  setInteractBlocked(blocked: boolean): void {
    this.interactBlocked = blocked
  }

  /** Sync score after another agent steals from local home. */
  setDeliveredTotal(n: number): void {
    this.deliveredTotal = Math.max(0, n)
  }

  /** Drop entire backpack (death / slide hit); returns cards. */
  takeAllStack(): UnoCardData[] {
    const cards = [...this.stack]
    this.stack = []
    this.stolenFromHomes.clear()
    return cards
  }

  isOnline(): boolean {
    return this.mode === 'online'
  }

  setHomeIndex(index: number): void {
    this.homeIndex = ((index % 4) + 4) % 4
  }

  getHomeIndex(): number {
    return this.homeIndex
  }

  /** Offline bots: list field piles for pathfinding. */
  listGround(): { id: string; x: number; z: number; card: UnoCardData }[] {
    const out: { id: string; x: number; z: number; card: UnoCardData }[] = []
    for (const c of this.cards.values()) {
      out.push({
        id: c.card.id,
        x: c.mesh.position.x,
        z: c.mesh.position.z,
        card: c.card,
      })
    }
    return out
  }

  /**
   * Offline bot pickup (does not touch the local player stack).
   * Returns new stack if a legal card was taken, else null.
   */
  tryPickupAt(
    x: number,
    z: number,
    stack: readonly UnoCardData[],
  ): UnoCardData[] | null {
    if (this.mode !== 'offline') return null
    if (isInsideAnyHome(x, z)) return null

    let nearest: CardPickup | null = null
    let nearestDist = Infinity
    for (const c of this.cards.values()) {
      const d = Math.hypot(c.mesh.position.x - x, c.mesh.position.z - z)
      if (d < nearestDist) {
        nearestDist = d
        nearest = c
      }
    }
    if (!nearest || nearestDist > CARD_PICKUP_RADIUS) return null

    const top = stack.length ? stack[stack.length - 1]! : null
    if (top !== null && !canStackOn(top, nearest.card)) return null

    const next = [...stack, nearest.card]
    this.removeGround(nearest.card.id)
    return next
  }

  /** Offline: place cards on field (e.g. stun/slide drops) with fly-out. */
  spawnDropped(
    drops: { card: UnoCardData; x: number; y: number; z: number }[],
    burstFrom: { x: number; y: number; z: number },
  ): void {
    if (this.mode !== 'offline' || !drops.length) return
    for (const d of drops) {
      this.addPickup(d.card, new THREE.Vector3(d.x, d.y, d.z), burstFrom)
    }
  }

  // ── Server → view ─────────────────────────────────────────

  applyGroundSnapshot(list: GroundCardWire[]): void {
    // Always accept authoritative snapshot while in a room
    this.mode = 'online'
    this.clearField()
    for (const g of list) this.addGround(g)
  }

  applySpawned(
    list: GroundCardWire[],
    burstFrom?: { x: number; y: number; z: number },
  ): void {
    if (this.mode !== 'online') return
    for (const g of list) {
      if (this.cards.has(g.card.id)) continue
      this.addPickup(
        g.card,
        new THREE.Vector3(g.x, g.y, g.z),
        burstFrom ?? null,
      )
    }
  }

  applyCardRemoved(cardId: string): void {
    this.removeGround(cardId)
  }

  private item: UnoCardData | null = null

  applyPrivateStack(
    stack: UnoCardData[],
    score: number,
    item: UnoCardData | null = null,
  ): void {
    this.stack = [...stack]
    this.deliveredTotal = score
    this.item = item
  }

  getItem(): UnoCardData | null {
    return this.item
  }

  setItem(item: UnoCardData | null): void {
    this.item = item
  }

  notifyPickedLocal(card: UnoCardData, stack: UnoCardData[]): void {
    this.onFeedback({ type: 'picked', card, stack: [...stack] })
  }

  notifyIllegal(
    card: UnoCardData,
    top: UnoCardData,
    reason?: 'stack' | 'home_once',
  ): void {
    this.onFeedback({ type: 'illegal', card, top, reason })
  }

  notifyClearIllegal(): void {
    this.onFeedback({ type: 'clear_prompt' })
  }

  /** Deposit with real cards for home pile visuals. */
  notifyDepositedCards(cards: UnoCardData[], score: number): void {
    this.deliveredTotal = score
    this.stack = []
    this.onDepositToHome(cards)
    this.onFeedback({ type: 'deposited', cards, deliveredTotal: score })
  }

  update(playerPos: THREE.Vector3, dt: number): void {
    for (const c of this.cards.values()) c.update(dt)

    if (this.mode === 'online') {
      // Server decides pickup/deposit; client only animates
      return
    }

    this.tickSpawner(dt, playerPos)

    if (this.interactBlocked) return

    const inOwnHome = isInsideHomeSlot(this.homeIndex, playerPos.x, playerPos.z)
    if (inOwnHome && this.stack.length > 0) {
      this.depositHeld()
    }
    if (inOwnHome) {
      if (this.lastIllegalId !== null) {
        this.lastIllegalId = null
        this.onFeedback({ type: 'clear_prompt' })
      }
      return
    }

    // Foreign home: try steal (if fence off)
    const foreign =
      this.homeYard?.slotAt(playerPos.x, playerPos.z) ??
      this.legacySlotAt(playerPos.x, playerPos.z)
    if (foreign !== null && foreign !== this.homeIndex) {
      this.tryOfflineSteal(foreign)
      return
    }

    let nearest: CardPickup | null = null
    let nearestDist = Infinity

    for (const c of this.cards.values()) {
      const d = Math.hypot(
        c.mesh.position.x - playerPos.x,
        c.mesh.position.z - playerPos.z,
      )
      if (d < nearestDist) {
        nearestDist = d
        nearest = c
      }
    }

    if (!nearest || nearestDist > CARD_PICKUP_RADIUS) {
      if (this.lastIllegalId !== null) {
        this.lastIllegalId = null
        this.onFeedback({ type: 'clear_prompt' })
      }
      return
    }

    const top = this.getTop()
    const legal = top === null || canStackOn(top, nearest.card)

    if (legal) {
      this.lastIllegalId = null
      this.pickup(nearest)
      return
    }

    if (this.lastIllegalId !== nearest.card.id) {
      this.lastIllegalId = nearest.card.id
      this.onFeedback({ type: 'illegal', card: nearest.card, top: top! })
    }
  }

  private legacySlotAt(x: number, z: number): number | null {
    for (let i = 0; i < 4; i++) {
      if (isInsideHomeSlot(i, x, z)) return i
    }
    return null
  }

  private tryOfflineSteal(slot: number): void {
    if (!this.homeYard) return
    if (this.fencedSlots.has(slot)) {
      // Fence active — no steal (electrocute handled by Game)
      return
    }
    if (this.stolenFromHomes.has(slot)) {
      if (this.lastIllegalId !== `home_once_${slot}`) {
        this.lastIllegalId = `home_once_${slot}`
        const top = this.getTop()
        if (top) {
          this.onFeedback({
            type: 'illegal',
            card: top,
            top,
            reason: 'home_once',
          })
        } else {
          this.onFeedback({
            type: 'toast',
            text: '本趟已从该老家拿过 1 张，卸货后再来',
            kind: 'bad',
          })
        }
      }
      return
    }

    const pileTop = this.homeYard.getTop(slot)
    if (!pileTop) {
      if (this.lastIllegalId !== null) {
        this.lastIllegalId = null
        this.onFeedback({ type: 'clear_prompt' })
      }
      return
    }

    const top = this.getTop()
    if (top !== null && !canStackOn(top, pileTop)) {
      if (this.lastIllegalId !== pileTop.id) {
        this.lastIllegalId = pileTop.id
        this.onFeedback({ type: 'illegal', card: pileTop, top })
      }
      return
    }

    const card = this.homeYard.popTopFrom(slot)
    if (!card) return
    this.stack.push(card)
    this.stolenFromHomes.add(slot)
    this.lastIllegalId = null
    this.onFeedback({ type: 'picked', card, stack: [...this.stack] })
  }

  private tickSpawner(dt: number, playerPos: THREE.Vector3): void {
    this.spawnTimer += dt
    if (this.spawnTimer < cardSpawnConfig.spawnIntervalSec) return
    this.spawnTimer = 0

    const room = cardSpawnConfig.maxOnField - this.cards.size
    if (room <= 0) return

    const n = Math.min(cardSpawnConfig.spawnPerWave, room)
    this.spawnLocal(n, playerPos)
  }

  private depositHeld(): void {
    const cards = [...this.stack]
    this.stack = []
    this.stolenFromHomes.clear()
    const deliveredTotal = this.onDepositToHome(cards)
    this.deliveredTotal = deliveredTotal
    this.onFeedback({ type: 'deposited', cards, deliveredTotal })
  }

  private pickup(target: CardPickup): void {
    this.stack.push(target.card)
    this.removeGround(target.card.id)
    this.onFeedback({ type: 'picked', card: target.card, stack: [...this.stack] })
  }

  private spawnLocal(count: number, avoidPlayer: THREE.Vector3 | null = null): void {
    if (count <= 0) return
    const data = createRandomCards(count)
    for (const card of data) {
      const pos = this.randomGroundPos(avoidPlayer)
      this.addPickup(card, pos)
    }
  }

  private addGround(g: GroundCardWire): void {
    this.addPickup(g.card, new THREE.Vector3(g.x, g.y, g.z), null)
  }

  private addPickup(
    card: UnoCardData,
    pos: THREE.Vector3,
    burstFrom: { x: number; y: number; z: number } | null = null,
  ): void {
    if (this.cards.has(card.id)) return
    const pickup = new CardPickup(card, pos, burstFrom)
    this.cards.set(card.id, pickup)
    this.group.add(pickup.mesh)
  }

  private removeGround(cardId: string): void {
    const c = this.cards.get(cardId)
    if (!c) return
    this.group.remove(c.mesh)
    c.dispose()
    this.cards.delete(cardId)
  }

  private clearField(): void {
    for (const c of this.cards.values()) {
      this.group.remove(c.mesh)
      c.dispose()
    }
    this.cards.clear()
  }

  private randomGroundPos(avoid: THREE.Vector3 | null = null): THREE.Vector3 {
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
      if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < 2.5) continue
      this.tmp.set(x, 0.55, z)
      return this.tmp.clone()
    }
    return new THREE.Vector3(0, 0.55, 0)
  }

  dispose(): void {
    this.clearField()
  }
}

export function formatStackLine(stack: readonly UnoCardData[]): string {
  if (!stack.length) return '背包：空 · 去场上按 UNO 规则捡牌，送回老家'
  const top = stack[stack.length - 1]!
  return `背包 ${stack.length} 张 · 顶牌：${cardLabel(top)} · 送回自己的老家卸货`
}
