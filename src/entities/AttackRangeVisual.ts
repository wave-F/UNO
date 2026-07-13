import * as THREE from 'three'
import { ATTACK_CONE_DEG, ATTACK_RANGE } from '../game/uno/types'

/**
 * Ground-level attack fan (matches server cone: range + half-angle).
 * Parent under player mesh; local +Z is forward (faceDirection / attack yaw).
 *
 * Server forward: (sin(yaw), cos(yaw)) on XZ — same as mesh.rotation.y.
 */
export class AttackRangeVisual {
  readonly root = new THREE.Group()
  private readonly fill: THREE.Mesh
  private readonly outline: THREE.Line
  private readonly fillMat: THREE.MeshBasicMaterial
  private pulse = 0
  private highlightT = -1

  constructor() {
    this.root.name = 'AttackRange'
    this.root.position.y = 0.06

    const half = (ATTACK_CONE_DEG * Math.PI) / 180
    const segs = 28
    const R = ATTACK_RANGE

    // Shape lives in XY; after rotation.x = -π/2, (x,y,0) → (x, 0, -y).
    // Want local +Z forward: z = cos(a)*R ⇒ shape y = -cos(a)*R.
    const shape = new THREE.Shape()
    shape.moveTo(0, 0)
    for (let i = 0; i <= segs; i++) {
      const t = i / segs
      const a = -half + t * half * 2
      shape.lineTo(Math.sin(a) * R, -Math.cos(a) * R)
    }
    shape.lineTo(0, 0)

    const geo = new THREE.ShapeGeometry(shape)
    this.fillMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.fill = new THREE.Mesh(geo, this.fillMat)
    this.fill.rotation.x = -Math.PI / 2
    this.root.add(this.fill)

    // Outline directly in local XZ (+Z forward)
    const pts: THREE.Vector3[] = [new THREE.Vector3(0, 0.02, 0)]
    for (let i = 0; i <= segs; i++) {
      const t = i / segs
      const a = -half + t * half * 2
      pts.push(new THREE.Vector3(Math.sin(a) * R, 0.02, Math.cos(a) * R))
    }
    pts.push(new THREE.Vector3(0, 0.02, 0))
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts)
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    })
    this.outline = new THREE.Line(lineGeo, lineMat)
    this.root.add(this.outline)

    this.root.visible = false
  }

  /** Dim idle fan while holding weapon. */
  setHolding(holding: boolean): void {
    if (this.highlightT >= 0) return
    this.root.visible = holding
    this.fillMat.opacity = holding ? 0.16 : 0
    this.fillMat.color.setHex(0xfbbf24)
  }

  /** Bright pulse when swinging. */
  flashSwing(): void {
    this.highlightT = 0
    this.root.visible = true
    this.fillMat.color.setHex(0xf87171)
    this.fillMat.opacity = 0.42
  }

  update(dt: number): void {
    if (this.highlightT >= 0) {
      this.highlightT += dt
      const u = Math.min(1, this.highlightT / 0.38)
      this.fillMat.opacity = 0.42 * (1 - u) + 0.14
      if (u >= 1) {
        this.highlightT = -1
        this.fillMat.color.setHex(0xfbbf24)
        this.fillMat.opacity = 0.16
      }
    } else if (this.root.visible) {
      this.pulse += dt
      this.fillMat.opacity = 0.12 + Math.sin(this.pulse * 3) * 0.05
    }
  }

  dispose(): void {
    this.fill.geometry.dispose()
    this.fillMat.dispose()
    this.outline.geometry.dispose()
    ;(this.outline.material as THREE.Material).dispose()
  }
}
