import * as THREE from 'three'

type Bolt = {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  life: number
}

/**
 * Short cyan zap burst at a world position, then auto-removes.
 * Used when a player/bot is fence-electrocuted (vanish, no 5s stand-still).
 */
export class ElectrocuteFx {
  readonly root = new THREE.Group()
  private bolts: Bolt[] = []
  private life = 0
  private readonly maxLife = 1.0
  private readonly mat: THREE.MeshBasicMaterial
  private done = false

  constructor(x: number, y: number, z: number) {
    this.root.name = 'ElectrocuteFx'
    this.root.position.set(x, y, z)
    this.mat = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    })
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 12, 12),
      this.mat.clone(),
    )
    ;(core.material as THREE.MeshBasicMaterial).color.setHex(0xe0f2fe)
    this.root.add(core)

    for (let i = 0; i < 10; i++) {
      const geo = new THREE.BoxGeometry(0.08, 0.08, 0.55 + Math.random() * 0.5)
      const mesh = new THREE.Mesh(geo, this.mat)
      const ang = (i / 10) * Math.PI * 2 + Math.random() * 0.4
      const elev = (Math.random() - 0.3) * 1.2
      mesh.position.set(
        Math.cos(ang) * 0.15,
        0.4 + elev * 0.2,
        Math.sin(ang) * 0.15,
      )
      mesh.lookAt(
        mesh.position.x + Math.cos(ang),
        mesh.position.y + elev,
        mesh.position.z + Math.sin(ang),
      )
      this.root.add(mesh)
      this.bolts.push({
        mesh,
        vel: new THREE.Vector3(
          Math.cos(ang) * (2 + Math.random() * 3),
          1.5 + Math.random() * 3,
          Math.sin(ang) * (2 + Math.random() * 3),
        ),
        life: 0.35 + Math.random() * 0.3,
      })
    }
  }

  /** @returns true when finished and can be disposed */
  update(dt: number): boolean {
    if (this.done) return true
    this.life += dt
    const fade = 1 - Math.min(1, this.life / this.maxLife)
    this.mat.opacity = fade
    this.root.traverse((o) => {
      const m = (o as THREE.Mesh).material
      if (m && (m as THREE.MeshBasicMaterial).opacity !== undefined) {
        ;(m as THREE.MeshBasicMaterial).opacity = fade
      }
    })
    for (const b of this.bolts) {
      b.mesh.position.addScaledVector(b.vel, dt)
      b.vel.y -= 6 * dt
      b.life -= dt
      b.mesh.visible = b.life > 0
    }
    if (this.life >= this.maxLife) {
      this.done = true
      return true
    }
    return false
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const m = mesh.material
      if (m) {
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
      }
    })
    this.root.clear()
  }
}
