import * as THREE from 'three'
import {
  CARD_D,
  createCardMesh,
  disposeCardMesh,
} from '../game/uno/cardVisual'
import type { UnoCardData } from '../game/uno/types'
import { movementConfig } from '../config/movement'

const CARD_SCALE = 0.78
/** Spacing along the spine as cards stack (slightly > scaled thickness). */
const STACK_STEP = CARD_D * CARD_SCALE + 0.018

type Layer = {
  mesh: THREE.Mesh
  texture: THREE.CanvasTexture
}

/**
 * Flat card pile on the player's back (backpack style).
 * Bottom of pile = first picked; outermost = current top card.
 * Parent under Player.mesh so it follows body yaw.
 */
export class HeadCardDisplay {
  readonly root = new THREE.Group()
  private layers: Layer[] = []
  private readonly countSprite: THREE.Sprite
  private readonly countCanvas: HTMLCanvasElement
  private readonly countCtx: CanvasRenderingContext2D
  private readonly countTex: THREE.CanvasTexture

  constructor() {
    this.root.name = 'BackCardStack'
    this.root.visible = false

    const { capsuleRadius: r, capsuleHalfHeight: h } = movementConfig
    const totalHeight = h * 2 + r * 2
    // Behind torso: local -Z is back when player faces +Z (faceDirection uses atan2)
    // Player faceDirection: targetYaw = atan2(dirX, dirZ) — mesh faces move direction.
    // Capsule eyes are at +Z local, so back is -Z.
    this.root.position.set(0, totalHeight * 0.58, -(r + 0.18))

    this.countCanvas = document.createElement('canvas')
    this.countCanvas.width = 128
    this.countCanvas.height = 64
    this.countCtx = this.countCanvas.getContext('2d')!
    this.countTex = new THREE.CanvasTexture(this.countCanvas)
    this.countTex.colorSpace = THREE.SRGBColorSpace
    this.countSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.countTex,
        transparent: true,
        depthTest: true,
      }),
    )
    this.countSprite.scale.set(0.62, 0.32, 1)
    this.root.add(this.countSprite)
  }

  /** Rebuild pile: stack[0] against back → last card outermost (top of rules stack). */
  setStack(stack: readonly UnoCardData[]): void {
    this.clearLayers()

    if (!stack.length) {
      this.root.visible = false
      this.countSprite.visible = false
      return
    }

    this.root.visible = true
    for (let i = 0; i < stack.length; i++) {
      const card = stack[i]!
      const { mesh, texture } = createCardMesh(card, CARD_SCALE)
      // 竖着贴在背上：牌面朝外（世界中朝后）
      // 默认牌面在 +Z；根节点在身后，需要牌面朝 -Z（背朝镜头时看到牌面）
      // 根已在 -Z 侧：让牌面朝 -Z → rotation.y = Math.PI
      mesh.rotation.y = Math.PI
      // 从贴背往外叠（沿 -Z）
      mesh.position.z = -i * STACK_STEP
      // 略抬一点，叠在后腰/后背中部
      mesh.position.y = 0
      this.root.add(mesh)
      this.layers.push({ mesh, texture })
    }

    const outer = (stack.length - 1) * STACK_STEP
    this.countSprite.position.set(0.55, 0.55, -outer)
    this.paintCount(stack.length)
  }

  update(_dt: number): void {
    // 固定背在后背，不旋转
  }

  dispose(): void {
    this.clearLayers()
    this.countTex.dispose()
    ;(this.countSprite.material as THREE.SpriteMaterial).dispose()
  }

  private clearLayers(): void {
    for (const layer of this.layers) {
      this.root.remove(layer.mesh)
      disposeCardMesh(layer.mesh, layer.texture)
    }
    this.layers = []
  }

  private paintCount(n: number): void {
    const ctx = this.countCtx
    const w = this.countCanvas.width
    const h = this.countCanvas.height
    ctx.clearRect(0, 0, w, h)
    this.countSprite.visible = n > 0
    if (n <= 0) {
      this.countTex.needsUpdate = true
      return
    }
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)'
    ctx.beginPath()
    ctx.roundRect(4, 8, w - 8, h - 16, 12)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 32px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`×${n}`, w / 2, h / 2)
    this.countTex.needsUpdate = true
  }
}
