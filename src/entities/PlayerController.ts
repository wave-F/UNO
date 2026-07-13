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
  /** Client-local death end time (server epoch ms, same clock as stun). */
  private deathUntilMs = 0
  /** Mace knock arc (body center XZ). */
  private knock: {
    t: number
    duration: number
    fromX: number
    fromZ: number
    toX: number
    toZ: number
    baseY: number
  } | null = null
  /** Slide tackle: dash then recover freeze. */
  private slide: {
    t: number
    duration: number
    recover: number
    recoverLeft: number
    fromX: number
    fromZ: number
    toX: number
    toZ: number
    baseY: number
    phase: 'dash' | 'recover'
  } | null = null

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

  /** Death lock until epoch ms (Date.now). */
  setDeathUntil(untilMs: number): void {
    this.deathUntilMs = Math.max(this.deathUntilMs, untilMs)
    this.horizVel.set(0, 0, 0)
    this.verticalVel = 0
    this.knock = null
    this.slide = null
  }

  clearDeath(): void {
    this.deathUntilMs = 0
  }

  isDead(now = Date.now()): boolean {
    return now < this.deathUntilMs
  }

  isStunned(now = Date.now()): boolean {
    return (
      now < this.stunUntilMs ||
      now < this.deathUntilMs ||
      this.knock !== null ||
      this.slide !== null
    )
  }

  /**
   * Fly along knock arc (body center). Cards are handled separately via cards_spawned.
   */
  playKnockback(toX: number, toZ: number, durationMs: number): void {
    const t = this.body.translation()
    this.horizVel.set(0, 0, 0)
    this.verticalVel = 0
    this.slide = null
    this.knock = {
      t: 0,
      duration: Math.max(0.2, durationMs / 1000),
      fromX: t.x,
      fromZ: t.z,
      toX,
      toZ,
      baseY: t.y,
    }
  }

  /** Lie flat and dash forward, then recover hardstun. */
  playSlide(
    toX: number,
    toZ: number,
    durationMs: number,
    recoverMs: number,
  ): void {
    const t = this.body.translation()
    this.horizVel.set(0, 0, 0)
    this.verticalVel = 0
    this.knock = null
    this.slide = {
      t: 0,
      duration: Math.max(0.15, durationMs / 1000),
      recover: Math.max(0.1, recoverMs / 1000),
      recoverLeft: 0,
      fromX: t.x,
      fromZ: t.z,
      toX,
      toZ,
      baseY: t.y,
      phase: 'dash',
    }
  }

  update(dt: number): void {
    if (this.pendingTeleport) {
      const p = this.pendingTeleport
      this.pendingTeleport = null
      this.verticalVel = 0
      this.horizVel.set(0, 0, 0)
      this.knock = null
      this.slide = null
      this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
      this.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z })
      this.player.mesh.rotation.y = p.yaw
      this.grounded = false
      this.syncMesh()
      this.player.updateVisuals(dt)
      return
    }

    // Slide tackle: flat dash then recover freeze
    if (this.slide) {
      if (this.slide.phase === 'dash') {
        this.slide.t += dt
        const u = Math.min(1, this.slide.t / this.slide.duration)
        const ease = u // linear dash
        const x = this.slide.fromX + (this.slide.toX - this.slide.fromX) * ease
        const z = this.slide.fromZ + (this.slide.toZ - this.slide.fromZ) * ease
        this.body.setTranslation({ x, y: this.slide.baseY, z }, true)
        this.body.setNextKinematicTranslation({ x, y: this.slide.baseY, z })
        // Diagonal lean on body only — slide range stays on ground plane
        this.player.setBodyPitch(Math.PI / 2 * 0.35)
        this.syncMesh()
        if (u >= 1) {
          this.slide.phase = 'recover'
          this.slide.recoverLeft = this.slide.recover
          this.player.setBodyPitch(Math.PI / 2 * 0.35)
        }
      } else {
        this.slide.recoverLeft -= dt
        this.horizVel.set(0, 0, 0)
        this.body.setNextKinematicTranslation(this.body.translation())
        this.player.setBodyPitch(Math.PI / 2 * 0.35)
        this.syncMesh()
        if (this.slide.recoverLeft <= 0) {
          this.player.setBodyPitch(0, 0)
          this.slide = null
          if (!this.player.getHeldItem()) {
            this.player.slideRange.setIdlePreview(true)
          }
        }
      }
      this.player.updateVisuals(dt)
      return
    }

    // Knock arc first (overrides movement / freeze-in-place stun pose)
    if (this.knock) {
      this.knock.t += dt
      const u = Math.min(1, this.knock.t / this.knock.duration)
      const ease = 1 - (1 - u) * (1 - u)
      const x = this.knock.fromX + (this.knock.toX - this.knock.fromX) * ease
      const z = this.knock.fromZ + (this.knock.toZ - this.knock.fromZ) * ease
      const arc = Math.sin(u * Math.PI) * 1.35
      const y = this.knock.baseY + arc
      this.body.setTranslation({ x, y, z }, true)
      this.body.setNextKinematicTranslation({ x, y, z })
      // Tumble body while flying (not root yaw node)
      this.player.setBodyPitch(
        Math.sin(u * Math.PI) * 0.85,
        Math.sin(u * Math.PI * 2) * 0.45,
      )
      this.syncMesh()
      if (u >= 1) {
        this.body.setTranslation(
          { x: this.knock.toX, y: this.knock.baseY, z: this.knock.toZ },
          true,
        )
        this.body.setNextKinematicTranslation({
          x: this.knock.toX,
          y: this.knock.baseY,
          z: this.knock.toZ,
        })
        this.player.setBodyPitch(0, 0)
        this.knock = null
        this.syncMesh()
      }
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
