import * as THREE from 'three'
import { movementConfig as cfg } from '../config/movement'
import type { InputManager } from '../managers/InputManager'

/**
 * Third-person orbit camera (Fall Guys style):
 * mouse yaw/pitch when pointer locked; always looks at player.
 */
export class CameraFollow {
  /** Yaw around world Y (radians). */
  private yaw = 0
  /** Pitch: higher = more top-down. */
  private pitch = 0.35
  private readonly desired = new THREE.Vector3()
  private readonly lookAt = new THREE.Vector3()
  private readonly offset = new THREE.Vector3()

  constructor(
    private camera: THREE.PerspectiveCamera,
    private input: InputManager,
  ) {
    this.pitch = cfg.cameraPitchDefault
  }

  getYaw(): number {
    return this.yaw
  }

  /** Unit forward on XZ (camera look flattened). */
  getFlatForward(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    return out
  }

  /** Unit right on XZ. */
  getFlatRight(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    return out
  }

  /** Apply mouse delta to yaw/pitch (call once per frame). */
  updateLook(): void {
    const mouse = this.input.consumeMouseDelta()
    if (mouse.x === 0 && mouse.y === 0) return
    // Clamp huge deltas (tab switch / pointer-lock glitch)
    const dx = THREE.MathUtils.clamp(mouse.x, -80, 80)
    const dy = THREE.MathUtils.clamp(mouse.y, -80, 80)
    this.yaw -= dx * cfg.mouseSensitivity
    this.pitch += dy * cfg.mouseSensitivity
    this.pitch = THREE.MathUtils.clamp(
      this.pitch,
      cfg.cameraPitchMin,
      cfg.cameraPitchMax,
    )
  }

  snapTo(playerPos: THREE.Vector3): void {
    this.placeCamera(playerPos, 1)
  }

  updatePosition(playerPos: THREE.Vector3, dt: number): void {
    // Hard-follow player every frame (lerp could trail a slide/knock and look at empty sky).
    void dt
    this.placeCamera(playerPos, 1)
  }

  /**
   * Detect broken orbit (too far / under floor / NaN) and hard re-seat on player.
   * Call every frame after player pose is finalized.
   */
  healIfBroken(playerPos: THREE.Vector3): boolean {
    if (
      !Number.isFinite(playerPos.x) ||
      !Number.isFinite(playerPos.y) ||
      !Number.isFinite(playerPos.z)
    ) {
      return false
    }
    const cam = this.camera.position
    const broken =
      !Number.isFinite(cam.x) ||
      !Number.isFinite(cam.y) ||
      !Number.isFinite(cam.z) ||
      cam.y < 0.8 ||
      cam.y > 35 ||
      cam.distanceTo(playerPos) > 22 ||
      cam.distanceTo(playerPos) < 1.5

    if (broken) {
      this.pitch = cfg.cameraPitchDefault
      this.placeCamera(playerPos, 1)
      return true
    }

    // Keep pitch in playable band (min already clamps; pull up if at floor)
    if (this.pitch < cfg.cameraPitchMin) {
      this.pitch = cfg.cameraPitchMin
    }
    return false
  }

  /** Soft reset pitch if user (or bug) left camera nearly flat / sky-only. */
  ensurePlayablePitch(): void {
    if (this.pitch < cfg.cameraPitchDefault * 0.75) {
      this.pitch = cfg.cameraPitchDefault
    }
  }

  resetOrbit(): void {
    this.yaw = 0
    this.pitch = cfg.cameraPitchDefault
  }

  private placeCamera(playerPos: THREE.Vector3, alpha: number): void {
    if (
      !Number.isFinite(playerPos.x) ||
      !Number.isFinite(playerPos.y) ||
      !Number.isFinite(playerPos.z)
    ) {
      return
    }
    const dist = cfg.cameraDistance
    const cosP = Math.cos(this.pitch)
    const sinP = Math.sin(this.pitch)
    this.offset.set(
      Math.sin(this.yaw) * cosP * dist,
      sinP * dist + cfg.cameraHeightBias,
      Math.cos(this.yaw) * cosP * dist,
    )

    // Body center standing ≈ 0.75; never look under the floor
    const standY = cfg.capsuleHalfHeight + cfg.capsuleRadius
    const py = Math.max(standY, Math.min(8, playerPos.y))

    this.desired.set(
      playerPos.x + this.offset.x,
      py + this.offset.y,
      playerPos.z + this.offset.z,
    )
    if (this.desired.y < 1.6) this.desired.y = 1.6

    if (alpha >= 1) {
      this.camera.position.copy(this.desired)
    } else {
      this.camera.position.lerp(this.desired, alpha)
      if (this.camera.position.y < 1.6) this.camera.position.y = 1.6
    }

    // If lerp left camera far away, snap
    if (this.camera.position.distanceTo(playerPos) > 18) {
      this.camera.position.copy(this.desired)
    }

    this.lookAt.set(
      playerPos.x + cfg.cameraLookAtOffset.x,
      py + cfg.cameraLookAtOffset.y,
      playerPos.z + cfg.cameraLookAtOffset.z,
    )
    this.camera.lookAt(this.lookAt)
    this.camera.updateMatrixWorld(true)
  }
}
