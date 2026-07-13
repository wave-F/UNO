import * as THREE from 'three'
import {
  CARD_H,
  createCardMesh,
  disposeCardMesh,
} from '../game/uno/cardVisual'
import { createMaceMesh, disposeMaceMesh, MACE_HEIGHT } from '../game/uno/maceVisual'
import { isStunBat, type UnoCardData } from '../game/uno/types'

/** World pickup cards are 2× base card mesh size. */
const FIELD_CARD_SCALE = 2
/** Field mace size. */
const FIELD_MACE_SCALE = 1.35

const FLY_DURATION = 0.55

export type BurstOrigin = { x: number; y: number; z: number }

export class CardPickup {
  readonly mesh: THREE.Group
  readonly card: UnoCardData
  private readonly bobOffset: number
  private elapsed = 0
  private readonly baseY: number
  private readonly landX: number
  private readonly landZ: number
  private visual: THREE.Object3D
  private faceTex: THREE.CanvasTexture | null = null
  private readonly isMace: boolean

  /** 0..1 while bursting from body; <0 when idle. */
  private flyT = -1
  private flyFrom = new THREE.Vector3()
  private flyTo = new THREE.Vector3()

  constructor(
    card: UnoCardData,
    position: THREE.Vector3,
    burstFrom: BurstOrigin | null = null,
  ) {
    this.card = card
    this.mesh = new THREE.Group()
    this.mesh.name = `Pickup_${card.id}`
    this.bobOffset = Math.random() * Math.PI * 2
    this.isMace = isStunBat(card)
    this.landX = position.x
    this.landZ = position.z

    if (this.isMace) {
      this.visual = createMaceMesh(FIELD_MACE_SCALE)
      this.mesh.add(this.visual)
      this.baseY = MACE_HEIGHT * FIELD_MACE_SCALE * 0.5 + 0.15
    } else {
      const created = createCardMesh(card, FIELD_CARD_SCALE)
      this.visual = created.mesh
      this.faceTex = created.texture
      this.mesh.add(this.visual)
      this.baseY = CARD_H * FIELD_CARD_SCALE * 0.5 + 0.12
    }

    this.flyTo.set(this.landX, this.baseY, this.landZ)
    this.mesh.rotation.y = Math.random() * Math.PI * 2

    if (burstFrom) {
      this.flyFrom.set(burstFrom.x, burstFrom.y + 0.9, burstFrom.z)
      this.mesh.position.copy(this.flyFrom)
      this.flyT = 0
    } else {
      this.mesh.position.set(this.landX, this.baseY, this.landZ)
    }
  }

  update(dt: number): void {
    this.elapsed += dt

    if (this.flyT >= 0) {
      this.flyT += dt
      const u = Math.min(1, this.flyT / FLY_DURATION)
      // Ease out + arc
      const ease = 1 - (1 - u) * (1 - u)
      const x = this.flyFrom.x + (this.flyTo.x - this.flyFrom.x) * ease
      const z = this.flyFrom.z + (this.flyTo.z - this.flyFrom.z) * ease
      const arc = Math.sin(u * Math.PI) * 1.1
      const y =
        this.flyFrom.y +
        (this.flyTo.y - this.flyFrom.y) * ease +
        arc
      this.mesh.position.set(x, y, z)
      this.mesh.rotation.x = (1 - u) * 1.2
      this.mesh.rotation.y += dt * 8
      this.mesh.rotation.z = Math.sin(u * Math.PI * 2) * 0.4 * (1 - u)
      if (u >= 1) {
        this.flyT = -1
        this.mesh.position.set(this.landX, this.baseY, this.landZ)
        this.mesh.rotation.x = 0
        this.mesh.rotation.z = 0
      }
      return
    }

    this.mesh.position.y = this.baseY + Math.sin(this.elapsed * 2.2 + this.bobOffset) * 0.06
    this.mesh.rotation.y += dt * (this.isMace ? 1.1 : 1.4)
    if (this.isMace) {
      this.mesh.rotation.z = Math.sin(this.elapsed * 1.6 + this.bobOffset) * 0.08
    }
  }

  dispose(): void {
    this.mesh.remove(this.visual)
    if (this.faceTex && this.visual instanceof THREE.Mesh) {
      disposeCardMesh(this.visual, this.faceTex)
    } else {
      disposeMaceMesh(this.visual)
    }
  }
}

export { CARD_PICKUP_RADIUS } from '../../shared/config/cards'
