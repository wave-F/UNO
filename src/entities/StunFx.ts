import * as THREE from 'three'

/**
 * Cartoon stun stars / spirals above the head while stunned.
 * Uses local performance.now() so server clock skew cannot hide the FX.
 */
export class StunFx {
  readonly root = new THREE.Group()
  private readonly stars: THREE.Mesh[] = []
  private readonly ring: THREE.Mesh
  private untilLocal = 0
  private spin = 0
  private readonly baseY: number

  constructor(headHeight: number) {
    this.root.name = 'StunFx'
    this.baseY = headHeight + 0.28
    this.root.position.y = this.baseY
    this.root.visible = false

    const starMat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.85,
      roughness: 0.35,
      metalness: 0.15,
    })
    for (let i = 0; i < 6; i++) {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), starMat.clone())
      this.stars.push(star)
      this.root.add(star)
    }

    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.03, 6, 22),
      new THREE.MeshStandardMaterial({
        color: 0xa78bfa,
        emissive: 0x7c3aed,
        emissiveIntensity: 0.55,
        roughness: 0.45,
        transparent: true,
        opacity: 0.9,
      }),
    )
    this.ring.rotation.x = Math.PI / 2
    this.root.add(this.ring)
  }

  /**
   * @param durationMs how long to show (preferred)
   * @param untilServerMs optional server epoch — ignored for display timing
   */
  play(durationMs: number, _untilServerMs?: number): void {
    const ms = Math.max(200, durationMs)
    this.untilLocal = Math.max(this.untilLocal, performance.now() + ms)
    this.root.visible = true
  }

  /** @deprecated prefer play(durationMs) */
  setStunnedUntil(untilServerMs: number, durationMs = 1500): void {
    // Use duration so FX is visible even if server/client clocks differ
    this.play(durationMs, untilServerMs)
  }

  /** True while stun stars are showing (local clock). */
  isActive(now = performance.now()): boolean {
    return now < this.untilLocal
  }

  update(dt: number): void {
    const now = performance.now()
    if (now >= this.untilLocal) {
      this.root.visible = false
      return
    }
    this.root.visible = true
    this.spin += dt * 5.2
    const remain = (this.untilLocal - now) / 1000
    this.root.position.y = this.baseY + Math.sin(this.spin * 2.2) * 0.06

    const n = this.stars.length
    for (let i = 0; i < n; i++) {
      const a = this.spin + (i / n) * Math.PI * 2
      const r = 0.32
      const s = this.stars[i]!
      s.position.set(
        Math.cos(a) * r,
        0.1 + Math.sin(this.spin * 3 + i) * 0.06,
        Math.sin(a) * r,
      )
      s.rotation.y = a
      s.rotation.z = this.spin
      s.scale.setScalar(1 + Math.sin(this.spin * 6 + i) * 0.2)
    }
    this.ring.rotation.z = this.spin * 0.7
    const fade = Math.min(1, remain / 0.25)
    ;(this.ring.material as THREE.MeshStandardMaterial).opacity = 0.9 * fade
  }

  dispose(): void {
    for (const s of this.stars) {
      s.geometry.dispose()
      ;(s.material as THREE.Material).dispose()
    }
    this.ring.geometry.dispose()
    ;(this.ring.material as THREE.Material).dispose()
  }
}
