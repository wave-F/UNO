import * as THREE from 'three'
import {
  CARD_H,
  createCardMesh,
  disposeCardMesh,
} from '../game/uno/cardVisual'
import type { UnoCardData } from '../game/uno/types'

/** World pickup cards are 2× base card mesh size. */
const FIELD_CARD_SCALE = 2

export class CardPickup {
  readonly mesh: THREE.Group
  readonly card: UnoCardData
  private readonly bobOffset: number
  private elapsed = 0
  private readonly baseY: number
  private cardMesh: THREE.Mesh
  private faceTex: THREE.CanvasTexture

  constructor(card: UnoCardData, position: THREE.Vector3) {
    this.card = card
    this.mesh = new THREE.Group()
    this.mesh.name = `Card_${card.id}`
    this.bobOffset = Math.random() * Math.PI * 2

    const created = createCardMesh(card, FIELD_CARD_SCALE)
    this.cardMesh = created.mesh
    this.faceTex = created.texture
    this.mesh.add(this.cardMesh)

    this.mesh.position.copy(position)
    this.mesh.position.y = CARD_H * FIELD_CARD_SCALE * 0.5 + 0.12
    this.baseY = this.mesh.position.y
    this.mesh.rotation.y = Math.random() * Math.PI * 2
  }

  update(dt: number): void {
    this.elapsed += dt
    this.mesh.position.y = this.baseY + Math.sin(this.elapsed * 2.2 + this.bobOffset) * 0.06
    this.mesh.rotation.y += dt * 1.4
  }

  dispose(): void {
    this.mesh.remove(this.cardMesh)
    disposeCardMesh(this.cardMesh, this.faceTex)
  }
}

export { CARD_PICKUP_RADIUS } from '../../shared/config/cards'
