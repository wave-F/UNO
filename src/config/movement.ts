import { BASE_MAX_SPEED } from '../../shared/config/movement'

/** Tunable Fall-Guys-ish movement parameters (Phase 1). */
export const movementConfig = {
  /** Max horizontal speed (m/s). Reduced 3% per carried card (see shared/config/movement). */
  maxSpeed: BASE_MAX_SPEED,
  /** Ground acceleration toward target velocity. */
  accel: 28,
  /** Ground deceleration when no input. */
  decel: 18,
  /** Air control multiplier on horizontal accel (0–1). */
  airControl: 0.35,
  /** Jump vertical impulse (m/s). */
  jumpImpulse: 8.2,
  /** Gravity (m/s²), positive down magnitude used as -Y. */
  gravity: 22,
  /** Max fall speed (m/s). */
  maxFallSpeed: 28,
  /** Radians per second when turning toward move direction. */
  turnSpeed: 10,
  /** Character capsule half-height of cylinder part (excluding hemispheres). */
  capsuleHalfHeight: 0.35,
  /** Character capsule radius. */
  capsuleRadius: 0.4,
  /** Spawn position — home base (see config/home.ts). */
  spawn: { x: -14, y: 2.2, z: -14 },
  /** Look-at offset above body center. */
  cameraLookAtOffset: { x: 0, y: 0.35, z: 0 },
  /** Orbit distance from look target. */
  cameraDistance: 8.5,
  /** Extra height added to spherical Y. */
  cameraHeightBias: 0.4,
  /** Default pitch (radians), higher = more top-down. */
  cameraPitchDefault: 0.48,
  /**
   * Min pitch — must stay high enough to always see ground.
   * 0.12 was nearly horizontal → mostly sky + fog = “blue screen”.
   */
  cameraPitchMin: 0.32,
  cameraPitchMax: 1.15,
  /** Mouse look sensitivity (radians per pixel). */
  mouseSensitivity: 0.0022,
  /** Camera follow lerp speed (higher = snappier). */
  cameraLerp: 12,
  /** Rapier character controller: max climb angle (degrees). */
  maxSlopeClimbAngle: 50,
  /** Rapier: min slope slide angle (degrees). */
  minSlopeSlideAngle: 55,
  /** Autostep height. */
  autostepHeight: 0.35,
  /** Autostep min width. */
  autostepMinWidth: 0.15,
} as const
