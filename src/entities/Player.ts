import * as THREE from 'three'
import { movementConfig } from '../config/movement'
import { HeadCardDisplay } from './HeadCardDisplay'
import type { UnoCardData } from '../game/uno/types'

export type PlayerVisualOptions = {
  /** Body color (default local pink). */
  color?: number
  name?: string
}

/** Visual bean: capsule body + simple face + head card. */
export class Player {
  readonly mesh: THREE.Group
  readonly headCard: HeadCardDisplay
  private bodyMesh: THREE.Mesh

  constructor(opts: PlayerVisualOptions = {}) {
    this.mesh = new THREE.Group()
    this.mesh.name = opts.name ? `Player:${opts.name}` : 'Player'

    const { capsuleRadius: r, capsuleHalfHeight: h } = movementConfig
    const totalHeight = h * 2 + r * 2

    const bodyGeo = new THREE.CapsuleGeometry(r, h * 2, 8, 16)
    const bodyMat = new THREE.MeshStandardMaterial({
      color: opts.color ?? 0xff8fab,
      roughness: 0.4,
      metalness: 0.05,
    })
    this.bodyMesh = new THREE.Mesh(bodyGeo, bodyMat)
    this.bodyMesh.castShadow = true
    // CapsuleGeometry is Y-up; center so feet near y=0 of group.
    this.bodyMesh.position.y = totalHeight / 2
    this.mesh.add(this.bodyMesh)

    // Simple eyes
    const eyeGeo = new THREE.SphereGeometry(0.08, 8, 8)
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1e1e2e })
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
    eyeL.position.set(-0.14, totalHeight * 0.72, r * 0.75)
    eyeR.position.set(0.14, totalHeight * 0.72, r * 0.75)
    this.mesh.add(eyeL, eyeR)

    const mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.05, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x7f1d1d }),
    )
    mouth.position.set(0, totalHeight * 0.55, r * 0.85)
    this.mesh.add(mouth)

    this.headCard = new HeadCardDisplay()
    this.mesh.add(this.headCard.root)
  }

  setHeldStack(stack: readonly UnoCardData[]): void {
    this.headCard.setStack(stack)
  }

  updateVisuals(dt: number): void {
    this.headCard.update(dt)
  }

  /** Face horizontal move direction (world XZ). */
  faceDirection(dirX: number, dirZ: number, dt: number, turnSpeed: number): void {
    if (Math.hypot(dirX, dirZ) < 1e-3) return
    const targetYaw = Math.atan2(dirX, dirZ)
    const current = this.mesh.rotation.y
    let delta = targetYaw - current
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    const maxStep = turnSpeed * dt
    if (Math.abs(delta) <= maxStep) {
      this.mesh.rotation.y = targetYaw
    } else {
      this.mesh.rotation.y = current + Math.sign(delta) * maxStep
    }
  }
}
