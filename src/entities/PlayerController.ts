import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import { maxSpeedForCarry } from '../../shared/config/movement'
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
  /** Applied at start of update so KCC cannot overwrite the same frame. */
  private pendingTeleport: { x: number; y: number; z: number; yaw: number } | null =
    null
  /** Client-local stun end time (performance.now or Date). */
  private stunUntilMs = 0

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

  /** Stun until epoch ms (Date.now). */
  setStunUntil(untilMs: number): void {
    this.stunUntilMs = Math.max(this.stunUntilMs, untilMs)
  }

  isStunned(now = Date.now()): boolean {
    return now < this.stunUntilMs
  }

  update(dt: number): void {
    if (this.pendingTeleport) {
      const p = this.pendingTeleport
      this.pendingTeleport = null
      this.verticalVel = 0
      this.horizVel.set(0, 0, 0)
      this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
      this.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z })
      this.player.mesh.rotation.y = p.yaw
      this.grounded = false
      this.syncMesh()
      this.player.updateVisuals(dt)
      return
    }

    if (this.isStunned()) {
      this.horizVel.set(0, 0, 0)
      this.verticalVel -= cfg.gravity * dt
      if (this.verticalVel < -cfg.maxFallSpeed) this.verticalVel = -cfg.maxFallSpeed
      this.tmpDesired.x = 0
      this.tmpDesired.y = this.verticalVel * dt
      this.tmpDesired.z = 0
      this.controller.computeColliderMovement(this.collider, this.tmpDesired)
      const movement = this.controller.computedMovement()
      const t = this.body.translation()
      this.body.setNextKinematicTranslation({
        x: t.x + movement.x,
        y: t.y + movement.y,
        z: t.z + movement.z,
      })
      this.grounded = this.controller.computedGrounded()
      if (this.grounded && this.verticalVel < 0) this.verticalVel = 0
      this.syncMesh()
      this.player.updateVisuals(dt)
      return
    }

    const move = this.input.getMoveVector()
    // Camera-relative: W 沿镜头水平朝向，A/D 沿水平右方向
    this.cameraFollow.getFlatForward(this.flatForward)
    this.cameraFollow.getFlatRight(this.flatRight)
    this.wishDir.set(0, 0, 0)
    // move.z: W=-1 → want +forward; move.x: D=+1 → +right
    this.wishDir.addScaledVector(this.flatForward, -move.z)
    this.wishDir.addScaledVector(this.flatRight, move.x)
    if (this.wishDir.lengthSq() > 1e-6) this.wishDir.normalize()

    // −5% max speed per card on backpack (shared rule with bots)
    const maxSpeed = maxSpeedForCarry(this.player.getHeldCount(), cfg.maxSpeed)

    const target = this.wishDir.clone().multiplyScalar(maxSpeed)

    const accel = this.grounded ? cfg.accel : cfg.accel * cfg.airControl
    const decel = this.grounded ? cfg.decel : cfg.decel * cfg.airControl

    if (target.lengthSq() > 0) {
      const t = Math.min(1, (accel * dt) / Math.max(maxSpeed, 0.01))
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
    if (hSpeed > maxSpeed) {
      const s = maxSpeed / hSpeed
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

  /**
   * Snap body + mesh (match start / own home spawn).
   * Queued until next update so character controller cannot stomp it.
   */
  teleport(x: number, y: number, z: number, yaw = 0): void {
    this.verticalVel = 0
    this.horizVel.set(0, 0, 0)
    this.pendingTeleport = { x, y, z, yaw }
    // Immediate visual + getPosition so net pose / camera see new home same frame
    this.body.setTranslation({ x, y, z }, true)
    this.body.setNextKinematicTranslation({ x, y, z })
    this.player.mesh.rotation.y = yaw
    this.syncMesh()
  }

  /** Horizontal facing (mesh yaw). */
  getYaw(): number {
    return this.player.mesh.rotation.y
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
