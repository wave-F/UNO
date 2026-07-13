import * as THREE from 'three'
import type { PhysicsWorld } from '../core/Physics'

type ObstacleSpec = {
  position: [number, number, number]
  size: [number, number, number]
  color: number
  rotationY?: number
}

// Keep clear of home base at (-14, -14)
const OBSTACLES: ObstacleSpec[] = [
  { position: [4, 0.6, -3], size: [2.4, 1.2, 2.4], color: 0xff6b9d },
  { position: [-2, 0.4, 2], size: [3, 0.8, 1.6], color: 0x7bdff2 },
  { position: [0, 0.9, -8], size: [4, 1.8, 1.2], color: 0xffd166 },
  { position: [6, 1.2, -10], size: [2, 0.4, 2], color: 0x06d6a0 },
  { position: [8, 1.8, 4], size: [2.5, 0.4, 2.5], color: 0xef476f },
  { position: [2, 0.5, 8], size: [1.2, 1, 4], color: 0x9381ff },
]

export class Environment {
  readonly group = new THREE.Group()

  constructor(physics: PhysicsWorld) {
    this.group.name = 'Environment'
    this.buildGround(physics)
    this.buildObstacles(physics)
    this.buildBoundary(physics)
  }

  private buildGround(physics: PhysicsWorld): void {
    const size = 40
    const geo = new THREE.PlaneGeometry(size, size)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x5eead4,
      roughness: 0.85,
      metalness: 0.05,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.rotation.x = -Math.PI / 2
    mesh.receiveShadow = true
    this.group.add(mesh)

    // Soft-play grid lines
    const grid = new THREE.GridHelper(size, 20, 0xffffff, 0x99f6e4)
    grid.position.y = 0.01
    const gridMat = grid.material as THREE.Material | THREE.Material[]
    if (Array.isArray(gridMat)) {
      gridMat.forEach((m) => {
        m.transparent = true
        m.opacity = 0.25
      })
    } else {
      gridMat.transparent = true
      gridMat.opacity = 0.25
    }
    this.group.add(grid)

    const R = physics.RAPIER
    const body = physics.world.createRigidBody(R.RigidBodyDesc.fixed())
    physics.world.createCollider(
      R.ColliderDesc.cuboid(size / 2, 0.1, size / 2).setTranslation(0, -0.1, 0),
      body,
    )
  }

  private buildObstacles(physics: PhysicsWorld): void {
    const R = physics.RAPIER
    for (const o of OBSTACLES) {
      const [sx, sy, sz] = o.size
      const geo = new THREE.BoxGeometry(sx, sy, sz)
      const mat = new THREE.MeshStandardMaterial({
        color: o.color,
        roughness: 0.55,
        metalness: 0.08,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.position.set(...o.position)
      if (o.rotationY) mesh.rotation.y = o.rotationY
      this.group.add(mesh)

      const bodyDesc = R.RigidBodyDesc.fixed().setTranslation(...o.position)
      if (o.rotationY) {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, o.rotationY, 0))
        bodyDesc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      }
      const body = physics.world.createRigidBody(bodyDesc)
      physics.world.createCollider(R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2), body)
    }
  }

  private buildBoundary(physics: PhysicsWorld): void {
    const R = physics.RAPIER
    const half = 20
    const h = 3
    const t = 0.5
    const walls: Array<{ pos: [number, number, number]; size: [number, number, number] }> = [
      { pos: [0, h / 2, -half], size: [half * 2, h, t] },
      { pos: [0, h / 2, half], size: [half * 2, h, t] },
      { pos: [-half, h / 2, 0], size: [t, h, half * 2] },
      { pos: [half, h / 2, 0], size: [t, h, half * 2] },
    ]

    const mat = new THREE.MeshStandardMaterial({
      color: 0xf472b6,
      roughness: 0.7,
      transparent: true,
      opacity: 0.45,
    })

    for (const w of walls) {
      const [sx, sy, sz] = w.size
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat)
      mesh.position.set(...w.pos)
      this.group.add(mesh)

      const body = physics.world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(...w.pos),
      )
      physics.world.createCollider(R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2), body)
    }
  }
}
