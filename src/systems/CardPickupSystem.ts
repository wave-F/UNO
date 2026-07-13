import * as THREE from 'three'
import { cardSpawnConfig } from '../config/cards'
import { homeConfig, isInsideHome } from '../config/home'
import { createRandomCards } from '../game/uno/deck'
import { canStackOn } from '../game/uno/rules'
import { cardLabel, type UnoCardData } from '../game/uno/types'
import { CardPickup, CARD_PICKUP_RADIUS } from '../entities/CardPickup'

export type PickupFeedback =
  | { type: 'picked'; card: UnoCardData; stack: UnoCardData[] }
  | { type: 'illegal'; card: UnoCardData; top: UnoCardData }
  | { type: 'clear_prompt' }
  | {
      type: 'deposited'
      cards: UnoCardData[]
      deliveredTotal: number
    }

export class CardPickupSystem {
  readonly group = new THREE.Group()
  private cards: CardPickup[] = []
  private stack: UnoCardData[] = []
  private lastIllegalId: string | null = null
  private spawnTimer = 0
  private readonly tmp = new THREE.Vector3()

  constructor(
    private onFeedback: (fb: PickupFeedback) => void,
    private onDepositToHome: (cards: UnoCardData[]) => number,
    initialCount = cardSpawnConfig.initialCount,
  ) {
    this.group.name = 'CardPickups'
    this.spawn(initialCount)
  }

  getStack(): readonly UnoCardData[] {
    return this.stack
  }

  getTop(): UnoCardData | null {
    return this.stack.length ? this.stack[this.stack.length - 1]! : null
  }

  update(playerPos: THREE.Vector3, dt: number): void {
    for (const c of this.cards) c.update(dt)

    this.tickSpawner(dt, playerPos)

    const inHome = isInsideHome(playerPos.x, playerPos.z)
    if (inHome && this.stack.length > 0) {
      this.depositHeld()
    }

    if (inHome) {
      if (this.lastIllegalId !== null) {
        this.lastIllegalId = null
        this.onFeedback({ type: 'clear_prompt' })
      }
      return
    }

    let nearest: CardPickup | null = null
    let nearestDist = Infinity

    for (const c of this.cards) {
      const d = c.mesh.position.distanceTo(playerPos)
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

    const room = cardSpawnConfig.maxOnField - this.cards.length
    if (room <= 0) return

    const n = Math.min(cardSpawnConfig.spawnPerWave, room)
    this.spawn(n, playerPos)
  }

  private depositHeld(): void {
    const cards = [...this.stack]
    this.stack = []
    const deliveredTotal = this.onDepositToHome(cards)
    this.onFeedback({ type: 'deposited', cards, deliveredTotal })
  }

  private pickup(target: CardPickup): void {
    this.stack.push(target.card)
    this.cards = this.cards.filter((c) => c !== target)
    this.group.remove(target.mesh)
    target.dispose()
    this.onFeedback({ type: 'picked', card: target.card, stack: [...this.stack] })
  }

  private spawn(count: number, avoidPlayer: THREE.Vector3 | null = null): void {
    if (count <= 0) return
    const data = createRandomCards(count)
    for (const card of data) {
      const pos = this.randomGroundPos(avoidPlayer)
      const pickup = new CardPickup(card, pos)
      this.cards.push(pickup)
      this.group.add(pickup.mesh)
    }
  }

  private randomGroundPos(avoid: THREE.Vector3 | null = null): THREE.Vector3 {
    const clear = homeConfig.cardSpawnClearRadius
    const hx = homeConfig.center.x
    const hz = homeConfig.center.z
    for (let i = 0; i < 60; i++) {
      const x = (Math.random() * 2 - 1) * 16
      const z = (Math.random() * 2 - 1) * 16
      if (Math.hypot(x - hx, z - hz) < clear) continue
      if (isInsideHome(x, z)) continue
      if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < 2.5) continue
      this.tmp.set(x, 0.55, z)
      return this.tmp.clone()
    }
    return new THREE.Vector3(6, 0.55, 6)
  }

  dispose(): void {
    for (const c of this.cards) c.dispose()
    this.cards = []
  }
}

export function formatStackLine(stack: readonly UnoCardData[]): string {
  if (!stack.length) return '背包：空 · 去场上按 UNO 规则捡牌，送回老家'
  const top = stack[stack.length - 1]!
  return `背包 ${stack.length} 张 · 顶牌：${cardLabel(top)} · 送回老家卸货`
}
