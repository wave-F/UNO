import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import { movementConfig as cfg } from '../config/movement'
import type { PhysicsWorld } from '../core/Physics'
import type { InputManager } from '../managers/InputManager'
import type { CameraFollow } from '../systems/CameraFollow'
import { Player } from './Player'

export class PlayerController {
  readonly player: Player
  private body: RAPIER.RigidBody
  private collider: RAPIER.Collider
  private controller: RAPIER.KinematicCharacterController
  private verticalVel = 0
  private horizVel = new THREE.Vector3()
  private grounded = false
  private readonly tmpDesired = { x: 0, y: 0, z: 0 }
  private readonly flatForward = new THREE.Vector3()
  private readonly flatRight = new THREE.Vector3()
  private readonly wishDir = new THREE.Vector3()

  constructor(
    physics: PhysicsWorld,
    private input: InputManager,
    private cameraFollow: CameraFollow,
  ) {
    this.player = new Player()
    const R = physics.RAPIER
    const { spawn, capsuleRadius, capsuleHalfHeight } = cfg

    // Capsule: halfHeight is cylindrical part only.
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z),
    )
    this.collider = physics.world.createCollider(
      R.ColliderDesc.capsule(capsuleHalfHeight, capsuleRadius)
        .setFriction(0)
        .setRestitution(0),
      this.body,
    )

    this.controller = physics.world.createCharacterController(0.01)
    this.controller.setApplyImpulsesToDynamicBodies(true)
    this.controller.setCharacterMass(1)
    this.controller.enableAutostep(cfg.autostepHeight, cfg.autostepMinWidth, true)
    this.controller.enableSnapToGround(0.3)
    this.controller.setMaxSlopeClimbAngle((cfg.maxSlopeClimbAngle * Math.PI) / 180)
    this.controller.setMinSlopeSlideAngle((cfg.minSlopeSlideAngle * Math.PI) / 180)

    this.syncMesh()
  }

  update(dt: number): void {
    const move = this.input.getMoveVector()
    // Camera-relative: W 沿镜头水平朝向，A/D 沿水平右方向
    this.cameraFollow.getFlatForward(this.flatForward)
    this.cameraFollow.getFlatRight(this.flatRight)
    this.wishDir.set(0, 0, 0)
    // move.z: W=-1 → want +forward; move.x: D=+1 → +right
    this.wishDir.addScaledVector(this.flatForward, -move.z)
    this.wishDir.addScaledVector(this.flatRight, move.x)
    if (this.wishDir.lengthSq() > 1e-6) this.wishDir.normalize()

    const target = this.wishDir.clone().multiplyScalar(cfg.maxSpeed)

    const accel = this.grounded ? cfg.accel : cfg.accel * cfg.airControl
    const decel = this.grounded ? cfg.decel : cfg.decel * cfg.airControl

    if (target.lengthSq() > 0) {
      const t = Math.min(1, (accel * dt) / cfg.maxSpeed)
      this.horizVel.x += (target.x - this.horizVel.x) * t
      this.horizVel.z += (target.z - this.horizVel.z) * t
    } else {
      const factor = Math.exp(-decel * dt)
      this.horizVel.x *= factor
      this.horizVel.z *= factor
      if (Math.abs(this.horizVel.x) < 0.01) this.horizVel.x = 0
      if (Math.abs(this.horizVel.z) < 0.01) this.horizVel.z = 0
    }

    // Clamp horizontal speed
    const hSpeed = Math.hypot(this.horizVel.x, this.horizVel.z)
    if (hSpeed > cfg.maxSpeed) {
      const s = cfg.maxSpeed / hSpeed
      this.horizVel.x *= s
      this.horizVel.z *= s
    }

    if (this.input.consumeJump() && this.grounded) {
      this.verticalVel = cfg.jumpImpulse
      this.grounded = false
    }

    this.verticalVel -= cfg.gravity * dt
    if (this.verticalVel < -cfg.maxFallSpeed) this.verticalVel = -cfg.maxFallSpeed

    this.tmpDesired.x = this.horizVel.x * dt
    this.tmpDesired.y = this.verticalVel * dt
    this.tmpDesired.z = this.horizVel.z * dt

    this.controller.computeColliderMovement(this.collider, this.tmpDesired)
    const movement = this.controller.computedMovement()
    const t = this.body.translation()
    this.body.setNextKinematicTranslation({
      x: t.x + movement.x,
      y: t.y + movement.y,
      z: t.z + movement.z,
    })

    // Grounded check after intended movement (controller collision flags)
    this.grounded = this.controller.computedGrounded()
    if (this.grounded && this.verticalVel < 0) {
      this.verticalVel = 0
    }
    // If we hit ceiling, kill upward velocity
    if (!this.grounded && movement.y < this.tmpDesired.y - 1e-4 && this.verticalVel > 0) {
      this.verticalVel = 0
    }

    this.syncMesh()
    if (hSpeed > 0.15 || target.lengthSq() > 0) {
      const fx = this.horizVel.x || target.x
      const fz = this.horizVel.z || target.z
      this.player.faceDirection(fx, fz, dt, cfg.turnSpeed)
    }
    this.player.updateVisuals(dt)
  }

  getPosition(): THREE.Vector3 {
    const t = this.body.translation()
    return new THREE.Vector3(t.x, t.y, t.z)
  }

  private syncMesh(): void {
    const t = this.body.translation()
    // Body translation is capsule center; visual group origin is at feet-ish.
    // Capsule center is at half total height above feet.
    const { capsuleRadius, capsuleHalfHeight } = cfg
    const halfTotal = capsuleHalfHeight + capsuleRadius
    this.player.mesh.position.set(t.x, t.y - halfTotal, t.z)
  }
}
