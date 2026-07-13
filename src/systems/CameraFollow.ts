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
    this.yaw -= mouse.x * cfg.mouseSensitivity
    this.pitch += mouse.y * cfg.mouseSensitivity
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
    const alpha = dt <= 0 ? 1 : 1 - Math.exp(-cfg.cameraLerp * dt)
    this.placeCamera(playerPos, alpha)
  }

  private placeCamera(playerPos: THREE.Vector3, alpha: number): void {
    const dist = cfg.cameraDistance
    const cosP = Math.cos(this.pitch)
    const sinP = Math.sin(this.pitch)
    this.offset.set(
      Math.sin(this.yaw) * cosP * dist,
      sinP * dist + cfg.cameraHeightBias,
      Math.cos(this.yaw) * cosP * dist,
    )

    this.desired.set(
      playerPos.x + this.offset.x,
      playerPos.y + this.offset.y,
      playerPos.z + this.offset.z,
    )

    if (alpha >= 1) {
      this.camera.position.copy(this.desired)
    } else {
      this.camera.position.lerp(this.desired, alpha)
    }

    this.lookAt.set(
      playerPos.x + cfg.cameraLookAtOffset.x,
      playerPos.y + cfg.cameraLookAtOffset.y,
      playerPos.z + cfg.cameraLookAtOffset.z,
    )
    this.camera.lookAt(this.lookAt)
  }
}
