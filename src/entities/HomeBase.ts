import * as THREE from 'three'
import {
  getHomeSlot,
  homeConfig,
  type HomeSlotDef,
} from '../config/home'
import {
  CARD_D,
  createCardMesh,
  disposeCardMesh,
} from '../game/uno/cardVisual'
import type { UnoCardData } from '../game/uno/types'

/** Home deposit pile: 10× original face size (was 0.42). */
const PILE_SCALE = 0.42 * 10
/**
 * Thickness scale for home pile only (face stays large).
 * Uniform 10× depth looked like bricks; keep cards thin and stackable.
 */
const PILE_DEPTH_SCALE = 0.55
const PILE_STEP = CARD_D * PILE_DEPTH_SCALE + 0.012
const MAX_VISIBLE_PILE = 40

type Layer = { mesh: THREE.Mesh; texture: THREE.CanvasTexture }

export type HomeBaseOptions = {
  slotIndex?: number
  /** Override label (e.g. "你的老家 · 西南"). */
  title?: string
}

/**
 * Soft-play home base at one arena corner: platform + marker + deposited pile.
 */
export class HomeBase {
  readonly group = new THREE.Group()
  readonly slotIndex: number
  private readonly pileRoot = new THREE.Group()
  private layers: Layer[] = []
  private deposited: UnoCardData[] = []
  private readonly labelSprite: THREE.Sprite
  private readonly labelTex: THREE.CanvasTexture
  private readonly labelCanvas: HTMLCanvasElement
  private readonly labelCtx: CanvasRenderingContext2D
  private readonly mineRing: THREE.Mesh
  private readonly slot: HomeSlotDef

  constructor(opts: HomeBaseOptions = {}) {
    this.slotIndex = opts.slotIndex ?? homeConfig.defaultSlot
    this.slot = getHomeSlot(this.slotIndex)
    this.group.name = `HomeBase:${this.slotIndex}`
    const { center } = this.slot
    const halfSize = homeConfig.halfSize
    this.group.position.set(center.x, 0, center.z)

    const size = halfSize * 2
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(size, 0.25, size),
      new THREE.MeshStandardMaterial({
        color: this.slot.platformColor,
        roughness: 0.55,
        metalness: 0.08,
      }),
    )
    platform.position.y = 0.125
    platform.receiveShadow = true
    platform.castShadow = true
    this.group.add(platform)

    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(size + 0.4, 0.35, size + 0.4),
      new THREE.MeshStandardMaterial({
        color: this.slot.accentColor,
        roughness: 0.6,
        transparent: true,
        opacity: 0.55,
      }),
    )
    rim.position.y = 0.05
    this.group.add(rim)

    // Soft "your home" ring (toggled via setMine)
    this.mineRing = new THREE.Mesh(
      new THREE.RingGeometry(halfSize + 0.15, halfSize + 0.55, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    this.mineRing.rotation.x = -Math.PI / 2
    this.mineRing.position.y = 0.28
    this.mineRing.visible = false
    this.group.add(this.mineRing)

    const postMat = new THREE.MeshStandardMaterial({
      color: this.slot.accentColor,
      roughness: 0.5,
    })
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

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 2.8, 8),
      new THREE.MeshStandardMaterial({ color: 0x78716c }),
    )
    pole.position.set(0, 1.5, halfSize - 0.5)
    this.group.add(pole)

    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.8),
      new THREE.MeshStandardMaterial({
        color: this.slot.flagColor,
        side: THREE.DoubleSide,
        roughness: 0.7,
      }),
    )
    flag.position.set(0.7, 2.5, halfSize - 0.5)
    this.group.add(flag)

    this.labelCanvas = document.createElement('canvas')
    this.labelCanvas.width = 320
    this.labelCanvas.height = 96
    this.labelCtx = this.labelCanvas.getContext('2d')!
    this.labelTex = new THREE.CanvasTexture(this.labelCanvas)
    this.labelTex.colorSpace = THREE.SRGBColorSpace
    this.labelSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.labelTex, transparent: true }),
    )
    this.labelSprite.scale.set(4.0, 1.2, 1)
    this.labelSprite.position.set(0, 3.4, 0)
    this.group.add(this.labelSprite)

    this.setTitle(opts.title ?? `老家 · ${this.slot.cornerName}`)

    this.pileRoot.position.set(0, 0.3, 0)
    this.group.add(this.pileRoot)
  }

  setMine(isMine: boolean): void {
    this.mineRing.visible = isMine
  }

  setTitle(title: string): void {
    const ctx = this.labelCtx
    const w = this.labelCanvas.width
    const h = this.labelCanvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(15,23,42,0.85)'
    ctx.beginPath()
    ctx.roundRect(8, 12, w - 16, h - 24, 16)
    ctx.fill()
    ctx.fillStyle = '#fde68a'
    ctx.font = 'bold 30px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const text = title.length > 14 ? `${title.slice(0, 13)}…` : title
    ctx.fillText(text, w / 2, h / 2)
    this.labelTex.needsUpdate = true
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

  clearPile(): void {
    this.deposited = []
    this.clearPileMeshes()
  }

  /** Remove top card from pile (stolen by another player). */
  popTop(): UnoCardData | null {
    if (!this.deposited.length) return null
    const card = this.deposited.pop()!
    this.rebuildVisiblePile()
    return card
  }

  dispose(): void {
    this.clearPileMeshes()
    this.labelTex.dispose()
    ;(this.labelSprite.material as THREE.SpriteMaterial).dispose()
    ;(this.mineRing.material as THREE.Material).dispose()
  }

  private rebuildVisiblePile(): void {
    this.clearPileMeshes()
    const start = Math.max(0, this.deposited.length - MAX_VISIBLE_PILE)
    const slice = this.deposited.slice(start)
    for (let i = 0; i < slice.length; i++) {
      const { mesh, texture } = createCardMesh(
        slice[i]!,
        PILE_SCALE,
        PILE_DEPTH_SCALE,
      )
      mesh.rotation.x = Math.PI / 2
      mesh.position.y = i * PILE_STEP
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

/** Four corner homes under one group. */
export class HomeYard {
  readonly group = new THREE.Group()
  readonly homes: HomeBase[]

  constructor() {
    this.group.name = 'HomeYard'
    this.homes = [0, 1, 2, 3].map((i) => new HomeBase({ slotIndex: i }))
    for (const h of this.homes) this.group.add(h.group)
  }

  get(slotIndex: number): HomeBase {
    return this.homes[((slotIndex % 4) + 4) % 4]!
  }

  depositTo(slotIndex: number, cards: readonly UnoCardData[]): number {
    return this.get(slotIndex).deposit(cards)
  }

  popTopFrom(slotIndex: number): UnoCardData | null {
    return this.get(slotIndex).popTop()
  }

  clearAllPiles(): void {
    for (const h of this.homes) h.clearPile()
  }

  /**
   * Update labels / mine ring from roster.
   * Offline: only slot 0 is yours.
   */
  applyOwnership(opts: {
    localHomeIndex: number
    /** seat id → homeIndex */
    owners: Map<string, { homeIndex: number; name: string }>
    localPlayerId: string | null
  }): void {
    const bySlot = new Map<number, { name: string; isMine: boolean }>()
    for (const [, o] of opts.owners) {
      bySlot.set(o.homeIndex, {
        name: o.name,
        isMine: false,
      })
    }
    if (opts.localPlayerId) {
      // local wins "mine" flag
      for (const [id, o] of opts.owners) {
        if (id === opts.localPlayerId) {
          bySlot.set(o.homeIndex, { name: o.name, isMine: true })
        }
      }
    } else {
      bySlot.set(opts.localHomeIndex, {
        name: bySlot.get(opts.localHomeIndex)?.name ?? '你',
        isMine: true,
      })
    }

    for (const home of this.homes) {
      const owner = bySlot.get(home.slotIndex)
      const corner = getHomeSlot(home.slotIndex).cornerName
      if (owner?.isMine) {
        home.setMine(true)
        home.setTitle(`你的老家 · ${corner}`)
      } else if (owner) {
        home.setMine(false)
        home.setTitle(`${owner.name} · ${corner}`)
      } else {
        home.setMine(home.slotIndex === opts.localHomeIndex && !opts.localPlayerId)
        home.setTitle(
          home.slotIndex === opts.localHomeIndex && !opts.localPlayerId
            ? `你的老家 · ${corner}`
            : `空位 · ${corner}`,
        )
      }
    }
  }

  dispose(): void {
    for (const h of this.homes) h.dispose()
  }
}
