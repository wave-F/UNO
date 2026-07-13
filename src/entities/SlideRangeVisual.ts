import * as THREE from 'three'
import {
  SLIDE_BASE_DIST,
  SLIDE_DIST_MIN_MULT,
  SLIDE_DIST_PENALTY_PER_CARD,
  SLIDE_HIT_RADIUS,
} from '../game/uno/types'

/**
 * Ground strip for slide-tackle hit volume.
 * Parent under player mesh (yaw only — body lean must NOT be on same node).
 * Local +Z = forward. Matches server segment + SLIDE_HIT_RADIUS.
 */
export class SlideRangeVisual {
  readonly root = new THREE.Group()
  private readonly fill: THREE.Mesh
  private readonly outline: THREE.Line
  private readonly fillMat: THREE.MeshBasicMaterial
  private readonly lineMat: THREE.LineBasicMaterial
  private stackCount = 0
  private idle = false
  private flashT = -1
  private pulse = 0

  constructor() {
    this.root.name = 'SlideRange'
    this.root.position.y = 0.05
    this.root.visible = false

    this.fillMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.fill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.fillMat)
    this.fill.rotation.x = -Math.PI / 2
    this.root.add(this.fill)

    this.lineMat = new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    })
    this.outline = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(capsuleOutlinePoints(1, 1)),
      this.lineMat,
    )
    this.root.add(this.outline)

    this.applyMetrics(SLIDE_BASE_DIST)
  }

  setStackCount(n: number): void {
    this.stackCount = Math.max(0, n)
    this.refreshDist()
  }

  /** Dim preview while empty-handed (can slide). */
  setIdlePreview(show: boolean): void {
    this.idle = show
    if (this.flashT >= 0) return
    this.root.visible = show
    if (show) {
      this.fillMat.color.setHex(0x38bdf8)
      this.fillMat.opacity = 0.16
      this.lineMat.color.setHex(0x7dd3fc)
      this.lineMat.opacity = 0.55
      this.refreshDist()
    }
  }

  /** Local flash (legacy); prefer world corridor for actual slides. */
  flashSlide(distOverride?: number): void {
    if (distOverride !== undefined && distOverride > 0.1) {
      this.applyMetrics(distOverride)
    } else {
      this.refreshDist()
    }
    this.flashT = 0
    this.root.visible = true
    this.fillMat.color.setHex(0xf97316)
    this.fillMat.opacity = 0.48
    this.lineMat.color.setHex(0xfbbf24)
    this.lineMat.opacity = 0.95
  }

  update(dt: number): void {
    if (this.flashT >= 0) {
      this.flashT += dt
      const u = Math.min(1, this.flashT / 0.55)
      this.fillMat.opacity = 0.48 * (1 - u) + 0.12
      if (u >= 1) {
        this.flashT = -1
        this.fillMat.color.setHex(0x38bdf8)
        this.lineMat.color.setHex(0x7dd3fc)
        this.root.visible = this.idle
        this.fillMat.opacity = this.idle ? 0.16 : 0
        this.lineMat.opacity = this.idle ? 0.55 : 0
        if (this.idle) this.refreshDist()
      }
      return
    }
    if (this.root.visible && this.idle) {
      this.pulse += dt
      this.fillMat.opacity = 0.12 + Math.sin(this.pulse * 2.8) * 0.05
    }
  }

  dispose(): void {
    this.fill.geometry.dispose()
    this.fillMat.dispose()
    this.outline.geometry.dispose()
    this.lineMat.dispose()
  }

  private refreshDist(): void {
    const mult = Math.max(
      SLIDE_DIST_MIN_MULT,
      1 - SLIDE_DIST_PENALTY_PER_CARD * this.stackCount,
    )
    this.applyMetrics(SLIDE_BASE_DIST * mult)
  }

  private applyMetrics(dist: number): void {
    const w = SLIDE_HIT_RADIUS * 2
    const len = Math.max(0.2, dist)
    this.fill.scale.set(w, len, 1)
    this.fill.position.set(0, 0, len * 0.5)

    this.outline.geometry.dispose()
    this.outline.geometry = new THREE.BufferGeometry().setFromPoints(
      capsuleOutlinePoints(w, len),
    )
  }
}

/**
 * World-fixed corridor for an actual slide (does not move with the player mid-dash).
 * Matches server segment from (fromX,fromZ) → (toX,toZ) with hit radius.
 */
export class WorldSlideCorridor {
  readonly root = new THREE.Group()
  private readonly fillMat: THREE.MeshBasicMaterial
  private readonly lineMat: THREE.LineBasicMaterial
  private life = 0
  private maxLife = 0.7

  constructor() {
    this.root.name = 'WorldSlideCorridor'
    this.root.visible = false
    this.fillMat = new THREE.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.lineMat = new THREE.LineBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
  }

  /**
   * Place corridor on ground from A to B (world XZ).
   * Server: path along yaw with hit radius around the segment.
   */
  show(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    durationMs: number,
  ): void {
    // Clear previous meshes
    while (this.root.children.length) {
      const c = this.root.children[0]!
      this.root.remove(c)
      if (c instanceof THREE.Mesh || c instanceof THREE.Line) {
        c.geometry?.dispose()
      }
    }

    const dx = toX - fromX
    const dz = toZ - fromZ
    const len = Math.hypot(dx, dz)
    if (len < 0.05) {
      this.root.visible = false
      return
    }
    const yaw = Math.atan2(dx, dz)
    const w = SLIDE_HIT_RADIUS * 2

    const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, len), this.fillMat)
    fill.rotation.x = -Math.PI / 2
    fill.position.set(0, 0.06, len * 0.5)
    this.root.add(fill)

    const outline = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(capsuleOutlinePoints(w, len)),
      this.lineMat,
    )
    this.root.add(outline)

    this.root.position.set(fromX, 0, fromZ)
    this.root.rotation.set(0, yaw, 0)
    this.root.visible = true
    this.life = 0
    this.maxLife = Math.max(0.45, (durationMs + 200) / 1000)
    this.fillMat.opacity = 0.5
    this.lineMat.opacity = 0.95
  }

  update(dt: number): void {
    if (!this.root.visible) return
    this.life += dt
    const u = Math.min(1, this.life / this.maxLife)
    this.fillMat.opacity = 0.5 * (1 - u)
    this.lineMat.opacity = 0.95 * (1 - u)
    if (u >= 1) this.root.visible = false
  }

  dispose(): void {
    while (this.root.children.length) {
      const c = this.root.children[0]!
      this.root.remove(c)
      if (c instanceof THREE.Mesh || c instanceof THREE.Line) {
        c.geometry?.dispose()
      }
    }
    this.fillMat.dispose()
    this.lineMat.dispose()
  }
}

/** Capsule outline on XZ: from z=0 to z=len, half-width w/2. */
function capsuleOutlinePoints(w: number, len: number): THREE.Vector3[] {
  const r = w * 0.5
  const pts: THREE.Vector3[] = []
  const segs = 12
  pts.push(new THREE.Vector3(-r, 0.02, 0))
  pts.push(new THREE.Vector3(-r, 0.02, len))
  for (let i = 0; i <= segs; i++) {
    const a = Math.PI / 2 + (i / segs) * Math.PI
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0.02, len + Math.sin(a) * r))
  }
  pts.push(new THREE.Vector3(r, 0.02, 0))
  for (let i = 0; i <= segs; i++) {
    const a = -Math.PI / 2 + (i / segs) * Math.PI
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0.02, Math.sin(a) * r))
  }
  return pts
}
