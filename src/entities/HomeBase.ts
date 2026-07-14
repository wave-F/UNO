import * as THREE from 'three'
import {
  getHomeSlot,
  homeConfig,
  isInsideHomeSlot,
  type HomeSlotDef,
} from '../config/home'
import {
  CARD_D,
  createCardMesh,
  disposeCardMesh,
} from '../game/uno/cardVisual'
import {
  cardLabel,
  UNO_COLOR_CSS,
  type UnoCardData,
} from '../game/uno/types'

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
  /** Local player's home — ring + fixed title. */
  private isMine = false
  /** Someone is assigned to this corner (online). */
  private hasOwner = false
  /** Display name for other players' homes. */
  private ownerName = ''
  /** Owner is home → electric fence visible to everyone. */
  private fenceActive = false
  private readonly fenceGroup = new THREE.Group()
  private fencePulse = 0
  /** UNO moment: big label above this home until match ends. */
  private unoAlert = false
  private readonly unoSprite: THREE.Sprite
  private readonly unoTex: THREE.CanvasTexture
  private unoPulse = 0

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

    // World UNO banner above home (shown when within last N of win)
    const unoCanvas = document.createElement('canvas')
    unoCanvas.width = 384
    unoCanvas.height = 128
    const unoCtx = unoCanvas.getContext('2d')!
    this.paintUnoCanvas(unoCtx, unoCanvas.width, unoCanvas.height)
    this.unoTex = new THREE.CanvasTexture(unoCanvas)
    this.unoTex.colorSpace = THREE.SRGBColorSpace
    this.unoSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.unoTex,
        transparent: true,
        depthWrite: false,
      }),
    )
    this.unoSprite.scale.set(5.2, 1.75, 1)
    this.unoSprite.position.set(0, 5.1, 0)
    this.unoSprite.visible = false
    this.group.add(this.unoSprite)

    this.refreshBubble()

    this.pileRoot.position.set(0, 0.3, 0)
    this.group.add(this.pileRoot)

    this.buildFenceVisual(halfSize)
    this.fenceGroup.visible = false
    this.group.add(this.fenceGroup)
  }

  private paintUnoCanvas(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
  ): void {
    ctx.clearRect(0, 0, w, h)
    const g = ctx.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, '#fbbf24')
    g.addColorStop(0.5, '#f97316')
    g.addColorStop(1, '#ef4444')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.roundRect(12, 16, w - 24, h - 32, 22)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 6
    ctx.stroke()
    ctx.fillStyle = '#1a0a00'
    ctx.font = 'bold 72px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('UNO!', w / 2, h / 2 + 2)
  }

  /** Show / hide floating UNO alert above this home. */
  setUnoAlert(active: boolean): void {
    this.unoAlert = active
    this.unoSprite.visible = active
    if (!active) this.unoPulse = 0
  }

  isUnoAlert(): boolean {
    return this.unoAlert
  }

  /** Toggle electric fence around this home (all clients). */
  setFenceActive(active: boolean): void {
    this.fenceActive = active
    this.fenceGroup.visible = active
  }

  isFenceActive(): boolean {
    return this.fenceActive
  }

  update(dt: number): void {
    if (this.unoAlert) {
      this.unoPulse += dt * 4.2
      const bob = Math.sin(this.unoPulse) * 0.12
      const sc = 1 + 0.06 * Math.sin(this.unoPulse * 1.7)
      this.unoSprite.position.y = 5.1 + bob
      this.unoSprite.scale.set(5.2 * sc, 1.75 * sc, 1)
    }
    if (!this.fenceActive) return
    this.fencePulse += dt * 6
    const op = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(this.fencePulse))
    this.fenceGroup.traverse((obj) => {
      const m = (obj as THREE.Mesh).material
      if (m && 'opacity' in m) {
        ;(m as THREE.MeshBasicMaterial).opacity = op
      }
    })
  }

  private buildFenceVisual(halfSize: number): void {
    const h = 2.4
    const y = h / 2 + 0.2
    const t = 0.08
    const inset = 0.05
    const half = halfSize + inset
    const mat = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    // Four vertical wall panels around platform rim
    const walls: [number, number, number, number][] = [
      [0, half, half * 2, t], // +z
      [0, -half, half * 2, t], // -z
      [half, 0, t, half * 2], // +x
      [-half, 0, t, half * 2], // -x
    ]
    for (const [px, pz, sx, sz] of walls) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), mat.clone())
      mesh.position.set(px, y, pz)
      this.fenceGroup.add(mesh)
    }
    // Top glow ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(half - 0.15, half + 0.12, 48),
      new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = h + 0.25
    this.fenceGroup.add(ring)

    // Corner lightning posts
    const postMat = new THREE.MeshBasicMaterial({
      color: 0xa5f3fc,
      transparent: true,
      opacity: 0.9,
    })
    for (const [px, pz] of [
      [half, half],
      [half, -half],
      [-half, half],
      [-half, -half],
    ] as const) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.1, h + 0.3, 6),
        postMat.clone(),
      )
      post.position.set(px, y, pz)
      this.fenceGroup.add(post)
    }
  }

  setMine(isMine: boolean): void {
    this.isMine = isMine
    this.mineRing.visible = isMine
    this.refreshBubble()
  }

  setHasOwner(hasOwner: boolean): void {
    this.hasOwner = hasOwner
    this.refreshBubble()
  }

  setOwnerName(name: string): void {
    this.ownerName = name.trim()
    this.refreshBubble()
  }

  getTopCard(): UnoCardData | null {
    if (!this.deposited.length) return null
    return this.deposited[this.deposited.length - 1]!
  }

  getDepositedCount(): number {
    return this.deposited.length
  }

  /** Add delivered cards onto the home pile (visual + total). */
  deposit(cards: readonly UnoCardData[]): number {
    if (!cards.length) return this.deposited.length
    this.deposited.push(...cards)
    this.rebuildVisiblePile()
    this.refreshBubble()
    return this.deposited.length
  }

  clearPile(): void {
    this.deposited = []
    this.clearPileMeshes()
    this.refreshBubble()
  }

  /** Remove top card from pile (stolen by another player). */
  popTop(): UnoCardData | null {
    if (!this.deposited.length) return null
    const card = this.deposited.pop()!
    this.rebuildVisiblePile()
    this.refreshBubble()
    return card
  }

  /**
   * Bubble above home:
   * - yours: 「你的老家」
   * - others with pile: 「张三 红3」
   * - others empty: 「张三」
   * - empty slot: hidden
   */
  refreshBubble(): void {
    if (this.isMine) {
      this.paintBubble('你的老家', '#fde68a')
      this.labelSprite.visible = true
      return
    }
    if (!this.hasOwner) {
      this.labelSprite.visible = false
      return
    }
    const name = this.ownerName || '玩家'
    const top = this.getTopCard()
    if (!top) {
      this.paintBubble(name, '#e2e8f0')
      this.labelSprite.visible = true
      return
    }
    // 「张三 红3」
    const card = cardLabel(top).replace(/\s+/g, '')
    const text = `${name} ${card}`
    this.paintBubble(text, (top.color && UNO_COLOR_CSS[top.color]) || '#fde68a')
    this.labelSprite.visible = true
  }

  private paintBubble(title: string, fillCss: string): void {
    const ctx = this.labelCtx
    const w = this.labelCanvas.width
    const h = this.labelCanvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(15,23,42,0.85)'
    ctx.beginPath()
    ctx.roundRect(8, 12, w - 16, h - 24, 16)
    ctx.fill()
    ctx.fillStyle = fillCss
    ctx.font = 'bold 32px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const text = title.length > 12 ? `${title.slice(0, 11)}…` : title
    ctx.fillText(text, w / 2, h / 2)
    this.labelTex.needsUpdate = true
  }

  dispose(): void {
    this.clearPileMeshes()
    this.labelTex.dispose()
    ;(this.labelSprite.material as THREE.SpriteMaterial).dispose()
    this.unoTex.dispose()
    ;(this.unoSprite.material as THREE.SpriteMaterial).dispose()
    ;(this.mineRing.material as THREE.Material).dispose()
    this.fenceGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      if (mesh.material) {
        const m = mesh.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
      }
    })
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

  /** Sync electric fences from server (or offline local owner). */
  setActiveFences(activeSlots: readonly number[]): void {
    const set = new Set(activeSlots)
    for (const h of this.homes) h.setFenceActive(set.has(h.slotIndex))
  }

  update(dt: number): void {
    for (const h of this.homes) h.update(dt)
  }

  depositTo(slotIndex: number, cards: readonly UnoCardData[]): number {
    return this.get(slotIndex).deposit(cards)
  }

  popTopFrom(slotIndex: number): UnoCardData | null {
    return this.get(slotIndex).popTop()
  }

  getTop(slotIndex: number): UnoCardData | null {
    return this.get(slotIndex).getTopCard()
  }

  getCount(slotIndex: number): number {
    return this.get(slotIndex).getDepositedCount()
  }

  /** Which home platform contains (x,z), or null. */
  slotAt(x: number, z: number): number | null {
    for (let i = 0; i < 4; i++) {
      if (isInsideHomeSlot(i, x, z)) return i
    }
    return null
  }

  clearAllPiles(): void {
    for (const h of this.homes) h.clearPile()
  }

  /** Toggle UNO moment flag above a home corner. */
  setUnoAlert(slotIndex: number, active: boolean): void {
    this.get(slotIndex).setUnoAlert(active)
  }

  clearUnoAlerts(): void {
    for (const h of this.homes) h.setUnoAlert(false)
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
      if (owner?.isMine) {
        home.setOwnerName(owner.name)
        home.setHasOwner(true)
        home.setMine(true)
      } else if (owner) {
        home.setMine(false)
        home.setOwnerName(owner.name)
        home.setHasOwner(true)
      } else {
        const offlineMine =
          home.slotIndex === opts.localHomeIndex && !opts.localPlayerId
        home.setOwnerName(offlineMine ? '你' : '')
        home.setMine(offlineMine)
        home.setHasOwner(offlineMine)
      }
    }
  }

  dispose(): void {
    for (const h of this.homes) h.dispose()
  }
}
