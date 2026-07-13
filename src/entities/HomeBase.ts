import * as THREE from 'three'
import { homeConfig } from '../config/home'
import {
  CARD_D,
  createCardMesh,
  disposeCardMesh,
} from '../game/uno/cardVisual'
import type { UnoCardData } from '../game/uno/types'

/** Home deposit pile: 10× original size (was 0.42). */
const PILE_SCALE = 0.42 * 10
const PILE_STEP = CARD_D * PILE_SCALE + 0.04
const MAX_VISIBLE_PILE = 40

type Layer = { mesh: THREE.Mesh; texture: THREE.CanvasTexture }

/**
 * Soft-play home base: platform + marker + deposited card pile.
 */
export class HomeBase {
  readonly group = new THREE.Group()
  private readonly pileRoot = new THREE.Group()
  private layers: Layer[] = []
  private deposited: UnoCardData[] = []
  private readonly labelSprite: THREE.Sprite
  private readonly labelTex: THREE.CanvasTexture

  constructor() {
    this.group.name = 'HomeBase'
    const { center, halfSize } = homeConfig
    this.group.position.set(center.x, 0, center.z)

    const size = halfSize * 2
    // Platform
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(size, 0.25, size),
      new THREE.MeshStandardMaterial({
        color: 0xfbbf24,
        roughness: 0.55,
        metalness: 0.08,
      }),
    )
    platform.position.y = 0.125
    platform.receiveShadow = true
    platform.castShadow = true
    this.group.add(platform)

    // Soft rim
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(size + 0.4, 0.35, size + 0.4),
      new THREE.MeshStandardMaterial({
        color: 0xf97316,
        roughness: 0.6,
        transparent: true,
        opacity: 0.55,
      }),
    )
    rim.position.y = 0.05
    this.group.add(rim)

    // Corner posts
    const postMat = new THREE.MeshStandardMaterial({ color: 0xea580c, roughness: 0.5 })
    const postGeo = new THREE.CylinderGeometry(0.18, 0.22, 1.6, 8)
    for (const [px, pz] of [
      [-halfSize + 0.3, -halfSize + 0.3],
      [halfSize - 0.3, -halfSize + 0.3],
      [-halfSize + 0.3, halfSize - 0.3],
      [halfSize - 0.3, halfSize - 0.3],
    ] as const) {
      const post = new THREE.Mesh(postGeo, postMat)
      post.position.set(px, 0.9, pz)
      post.castShadow = true
      this.group.add(post)
    }

    // Flag pole + flag
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 2.8, 8),
      new THREE.MeshStandardMaterial({ color: 0x78716c }),
    )
    pole.position.set(0, 1.5, halfSize - 0.5)
    this.group.add(pole)

    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.8),
      new THREE.MeshStandardMaterial({
        color: 0xef4444,
        side: THREE.DoubleSide,
        roughness: 0.7,
      }),
    )
    flag.position.set(0.7, 2.5, halfSize - 0.5)
    this.group.add(flag)

    // Floating label
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 96
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'rgba(15,23,42,0.85)'
    ctx.beginPath()
    ctx.roundRect(8, 12, 240, 72, 16)
    ctx.fill()
    ctx.fillStyle = '#fde68a'
    ctx.font = 'bold 36px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('老家 HOME', 128, 48)
    this.labelTex = new THREE.CanvasTexture(canvas)
    this.labelTex.colorSpace = THREE.SRGBColorSpace
    this.labelSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.labelTex, transparent: true }),
    )
    this.labelSprite.scale.set(3.2, 1.2, 1)
    this.labelSprite.position.set(0, 3.4, 0)
    this.group.add(this.labelSprite)

    this.pileRoot.position.set(0, 0.3, 0)
    this.group.add(this.pileRoot)
  }

  getDepositedCount(): number {
    return this.deposited.length
  }

  /** Add delivered cards onto the home pile (visual + total). */
  deposit(cards: readonly UnoCardData[]): number {
    if (!cards.length) return this.deposited.length
    this.deposited.push(...cards)
    this.rebuildVisiblePile()
    return this.deposited.length
  }

  dispose(): void {
    this.clearPileMeshes()
    this.labelTex.dispose()
    ;(this.labelSprite.material as THREE.SpriteMaterial).dispose()
  }

  private rebuildVisiblePile(): void {
    this.clearPileMeshes()
    const start = Math.max(0, this.deposited.length - MAX_VISIBLE_PILE)
    const slice = this.deposited.slice(start)
    for (let i = 0; i < slice.length; i++) {
      const { mesh, texture } = createCardMesh(slice[i]!, PILE_SCALE)
      mesh.rotation.x = Math.PI / 2
      mesh.position.y = i * PILE_STEP
      // slight scatter so it looks like a real pile
      mesh.rotation.z = ((i * 17) % 20 - 10) * 0.01
      mesh.position.x = ((i * 13) % 7 - 3) * 0.02
      mesh.position.z = ((i * 11) % 7 - 3) * 0.02
      this.pileRoot.add(mesh)
      this.layers.push({ mesh, texture })
    }
  }

  private clearPileMeshes(): void {
    for (const layer of this.layers) {
      this.pileRoot.remove(layer.mesh)
      disposeCardMesh(layer.mesh, layer.texture)
    }
    this.layers = []
  }
}
