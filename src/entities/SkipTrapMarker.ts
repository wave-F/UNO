import * as THREE from 'three'
import { SKIP_TRAP_RADIUS } from '../game/uno/types'

/**
 * Ground marker for a placed Skip trap (visible to everyone).
 * Own traps render at ~50% opacity so they are easy to tell apart.
 */
export class SkipTrapMarker {
  readonly root = new THREE.Group()
  readonly id: string
  private readonly padMat: THREE.MeshBasicMaterial
  private readonly ringMat: THREE.MeshBasicMaterial
  private readonly slashMat: THREE.MeshBasicMaterial
  private readonly labelMat: THREE.MeshStandardMaterial
  private elapsed = 0
  /** Multiplier on base opacity (0.5 = own trap). */
  private readonly opacityMul: number

  constructor(id: string, x: number, z: number, isOwn = false) {
    this.id = id
    this.opacityMul = isOwn ? 0.5 : 1
    this.root.name = `SkipTrap_${id}${isOwn ? '_own' : ''}`
    this.root.position.set(x, 0.04, z)

    const R = SKIP_TRAP_RADIUS * 0.92
    // Own traps: cooler blue-gray tint so they read as "mine"
    const padColor = isOwn ? 0x64748b : 0x0f766e
    const ringColor = isOwn ? 0x94a3b8 : 0x5eead4
    const labelColor = isOwn ? 0x475569 : 0x134e4a
    const labelEmissive = isOwn ? 0x334155 : 0x0f766e

    this.padMat = new THREE.MeshBasicMaterial({
      color: padColor,
      transparent: true,
      opacity: 0.45 * this.opacityMul,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const pad = new THREE.Mesh(new THREE.CircleGeometry(R, 28), this.padMat)
    pad.rotation.x = -Math.PI / 2
    this.root.add(pad)

    this.ringMat = new THREE.MeshBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: 0.85 * this.opacityMul,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(R * 0.72, R * 0.98, 32),
      this.ringMat,
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.01
    this.root.add(ring)

    // Slash / ban glyph
    this.slashMat = new THREE.MeshBasicMaterial({
      color: 0xf87171,
      transparent: true,
      opacity: 0.9 * this.opacityMul,
      depthWrite: false,
    })
    const slash = new THREE.Mesh(
      new THREE.BoxGeometry(R * 1.5, 0.04, R * 0.14),
      this.slashMat,
    )
    slash.position.y = 0.03
    slash.rotation.y = Math.PI / 4
    this.root.add(slash)

    // Small upright disc label
    this.labelMat = new THREE.MeshStandardMaterial({
      color: labelColor,
      emissive: labelEmissive,
      emissiveIntensity: isOwn ? 0.15 : 0.35,
      roughness: 0.5,
      metalness: 0.1,
      transparent: true,
      opacity: this.opacityMul,
    })
    const label = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.28, R * 0.28, 0.06, 16),
      this.labelMat,
    )
    label.position.y = 0.12
    this.root.add(label)
  }

  update(dt: number): void {
    this.elapsed += dt
    const m = this.opacityMul
    const pulse = 0.38 + Math.sin(this.elapsed * 3.2) * 0.1
    this.padMat.opacity = pulse * m
    this.ringMat.opacity = (0.7 + Math.sin(this.elapsed * 4) * 0.15) * m
    this.slashMat.opacity = 0.9 * m
    this.labelMat.opacity = m
    this.root.rotation.y += dt * 0.6
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose()
        const m = o.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m?.dispose()
      }
    })
  }
}
