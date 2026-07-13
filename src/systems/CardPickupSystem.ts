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
  }

  /** Leave room: restore local spawns. */
  enterOfflineMode(): void {
    this.mode = 'offline'
    this.clearField()
    this.stack = []
    this.deliveredTotal = 0
    this.lastIllegalId = null
    this.spawnTimer = 0
    this.spawnLocal(cardSpawnConfig.initialCount)
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

    const inOwnHome = isInsideHomeSlot(this.homeIndex, playerPos.x, playerPos.z)
    if (inOwnHome && this.stack.length > 0) {
      this.depositHeld()
    }

    if (inOwnHome || isInsideAnyHome(playerPos.x, playerPos.z)) {
      if (this.lastIllegalId !== null) {
        this.lastIllegalId = null
        this.onFeedback({ type: 'clear_prompt' })
      }
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
