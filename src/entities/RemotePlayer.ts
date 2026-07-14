import * as THREE from 'three'
import { movementConfig as cfg } from '../config/movement'
import { Player } from './Player'

const REMOTE_COLORS = [0x60a5fa, 0xfbbf24, 0xa78bfa, 0x34d399, 0xf472b6]

type Snapshot = {
  /** Local receive time (performance.now). */
  recvAt: number
  x: number
  y: number
  z: number
  yaw: number
}

/** Render remote player with snapshot interpolation (~100ms behind). */
export class RemotePlayer {
  readonly id: string
  readonly player: Player
  readonly root: THREE.Group
  private nameSprite: THREE.Sprite
  private snaps: Snapshot[] = []
  /** Interpolation delay (ms) — show others slightly in the past. */
  private readonly interpDelayMs = 100
  private readonly halfTotal = cfg.capsuleHalfHeight + cfg.capsuleRadius
  private knock: {
    t: number
    duration: number
    fromX: number
    fromZ: number
    toX: number
    toZ: number
    baseY: number
  } | null = null
  private slide: {
    t: number
    duration: number
    recoverLeft: number
    fromX: number
    fromZ: number
    toX: number
    toZ: number
    baseY: number
    phase: 'dash' | 'recover'
  } | null = null
  /** Last applied XZ for estimating limb run speed. */
  private lastXZ: { x: number; z: number } | null = null
  /** Last good world pose — never fall back to constructor origin (0,0,0). */
  private lastKnown: { x: number; y: number; z: number; yaw: number } | null =
    null
  /**
   * Offline bots: pose was just forced via snapImmediate this frame.
   * Skip interp re-apply (which would zero moveSpeed on identical XZ).
   */
  private posePinned = false

  constructor(id: string, name: string, colorIndex = 0) {
    this.id = id
    const color = REMOTE_COLORS[colorIndex % REMOTE_COLORS.length]!
    this.player = new Player({ color, name })
    this.root = new THREE.Group()
    this.root.name = `Remote:${name}`
    this.root.add(this.player.mesh)
    this.nameSprite = makeNameSprite(name)
    this.nameSprite.position.y = this.halfTotal * 2 + 0.35
    this.root.add(this.nameSprite)
    // Hide far away until first real pose (avoids origin flash)
    this.player.mesh.visible = false
  }

  pushPose(x: number, y: number, z: number, yaw: number): void {
    // During knock/slide, ignore pose spam so anim is not overwritten
    if (this.knock || this.slide) return
    const snap: Snapshot = { recvAt: performance.now(), x, y, z, yaw }
    this.snaps.push(snap)
    // Keep a short buffer
    while (this.snaps.length > 12) this.snaps.shift()
    this.lastKnown = { x, y, z, yaw }
    this.player.mesh.visible = true
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible
    this.player.setAvatarVisible(visible)
  }

  /**
   * Offline / local bots: place immediately (no network interp).
   * Avoids sitting at world origin until the first interpolated sample.
   * @param dt frame dt used to estimate run speed for limb swing
   * @param force apply even during knock/slide (use for hard respawn)
   */
  snapImmediate(
    x: number,
    y: number,
    z: number,
    yaw: number,
    dt = 1 / 60,
    force = false,
  ): void {
    if (!force && (this.knock || this.slide)) return
    if (force) {
      this.knock = null
      this.slide = null
      this.player.setBodyPitch(0, 0)
      this.player.setLimbMode('normal')
    }
    // Timestamp in the past so update() paints this sample right away
    const t = performance.now() - this.interpDelayMs - 32
    this.snaps = [{ recvAt: t, x, y, z, yaw }]
    const step = Math.max(1e-4, dt)
    // Speed from previous pin → keeps bot limb walk cycle alive
    if (this.lastXZ && !force) {
      const sp = Math.hypot(x - this.lastXZ.x, z - this.lastXZ.z) / step
      this.player.setMoveSpeed(sp)
    } else {
      this.player.setMoveSpeed(0)
    }
    this.lastXZ = { x, z }
    this.lastKnown = { x, y, z, yaw }
    // Move root so nameplate + mesh stay together (mesh alone left name at origin)
    this.root.position.set(x, y - this.halfTotal, z)
    this.player.mesh.position.set(0, 0, 0)
    this.player.mesh.rotation.y = yaw
    this.player.mesh.visible = true
    this.nameSprite.visible = true
    this.posePinned = true
  }

  playKnockback(
    fromX: number,
    fromY: number,
    fromZ: number,
    toX: number,
    toZ: number,
    durationMs: number,
  ): void {
    this.slide = null
    this.knock = {
      t: 0,
      duration: Math.max(0.2, durationMs / 1000),
      fromX,
      fromZ,
      toX,
      toZ,
      baseY: fromY,
    }
    this.snaps = []
  }

  playSlide(
    fromX: number,
    fromY: number,
    fromZ: number,
    toX: number,
    toZ: number,
    durationMs: number,
    recoverMs: number,
  ): void {
    this.knock = null
    this.slide = {
      t: 0,
      duration: Math.max(0.15, durationMs / 1000),
      recoverLeft: Math.max(0.1, recoverMs / 1000),
      fromX,
      fromZ,
      toX,
      toZ,
      baseY: fromY,
      phase: 'dash',
    }
    this.snaps = []
  }

  update(dt: number): void {
    // Offline bot path: pose + moveSpeed already set in snapImmediate
    if (this.posePinned && !this.slide && !this.knock) {
      this.posePinned = false
      if (this.player.isStunFxActive()) {
        this.player.setLimbMode('stun')
        this.player.setMoveSpeed(0)
      } else {
        this.player.setLimbMode('normal')
      }
      this.player.updateVisuals(dt)
      return
    }
    this.posePinned = false

    if (this.slide) {
      this.player.setLimbMode('slide')
      this.player.setMoveSpeed(0)
      if (this.slide.phase === 'dash') {
        this.slide.t += dt
        const u = Math.min(1, this.slide.t / this.slide.duration)
        const x = this.slide.fromX + (this.slide.toX - this.slide.fromX) * u
        const z = this.slide.fromZ + (this.slide.toZ - this.slide.fromZ) * u
        this.apply(x, this.slide.baseY, z, this.player.mesh.rotation.y, dt)
        this.player.setBodyPitch(-Math.PI / 2 * 0.42)
        if (u >= 1) {
          this.slide.phase = 'recover'
          this.player.setBodyPitch(-Math.PI / 2 * 0.42)
        }
      } else {
        this.slide.recoverLeft -= dt
        this.apply(
          this.slide.toX,
          this.slide.baseY,
          this.slide.toZ,
          this.player.mesh.rotation.y,
          dt,
        )
        this.player.setBodyPitch(-Math.PI / 2 * 0.42)
        if (this.slide.recoverLeft <= 0) {
          this.player.setBodyPitch(0, 0)
          this.player.setLimbMode('normal')
          this.snaps = [
            {
              recvAt: performance.now(),
              x: this.slide.toX,
              y: this.slide.baseY,
              z: this.slide.toZ,
              yaw: this.player.mesh.rotation.y,
            },
          ]
          this.slide = null
        }
      }
      this.player.updateVisuals(dt)
      return
    }

    if (this.knock) {
      this.player.setLimbMode('knock')
      this.player.setMoveSpeed(0)
      this.knock.t += dt
      const u = Math.min(1, this.knock.t / this.knock.duration)
      const ease = 1 - (1 - u) * (1 - u)
      const x = this.knock.fromX + (this.knock.toX - this.knock.fromX) * ease
      const z = this.knock.fromZ + (this.knock.toZ - this.knock.fromZ) * ease
      const arc = Math.sin(u * Math.PI) * 1.35
      const y = this.knock.baseY + arc
      this.apply(x, y, z, this.player.mesh.rotation.y, dt)
      this.player.setBodyPitch(
        Math.sin(u * Math.PI) * 0.85,
        Math.sin(u * Math.PI * 2) * 0.45,
      )
      if (u >= 1) {
        this.apply(
          this.knock.toX,
          this.knock.baseY,
          this.knock.toZ,
          this.player.mesh.rotation.y,
          dt,
        )
        this.player.setBodyPitch(0, 0)
        this.player.setLimbMode('normal')
        this.snaps = [
          {
            recvAt: performance.now(),
            x: this.knock.toX,
            y: this.knock.baseY,
            z: this.knock.toZ,
            yaw: this.player.mesh.rotation.y,
          },
        ]
        this.knock = null
      }
      this.player.updateVisuals(dt)
      return
    }

    if (this.player.isStunFxActive()) {
      this.player.setLimbMode('stun')
    } else {
      this.player.setLimbMode('normal')
    }

    if (this.snaps.length === 0) {
      // Never leave mesh at constructor origin (0,0,0)
      this.player.setMoveSpeed(0)
      if (this.lastKnown) {
        this.player.mesh.position.set(
          this.lastKnown.x,
          this.lastKnown.y - this.halfTotal,
          this.lastKnown.z,
        )
        this.player.mesh.rotation.y = this.lastKnown.yaw
        this.player.mesh.visible = true
      } else {
        this.player.mesh.visible = false
      }
      this.player.updateVisuals(dt)
      return
    }

    const renderAt = performance.now() - this.interpDelayMs

    // Find surrounding snapshots
    let a = this.snaps[0]!
    let b = this.snaps[this.snaps.length - 1]!

    if (renderAt <= a.recvAt) {
      this.apply(a.x, a.y, a.z, a.yaw, dt)
      this.player.updateVisuals(dt)
      return
    }
    if (renderAt >= b.recvAt) {
      // Extrapolate slightly from last two if possible
      if (this.snaps.length >= 2) {
        const p = this.snaps[this.snaps.length - 2]!
        const q = b
        const span = q.recvAt - p.recvAt
        const t = span > 1e-3 ? Math.min(1.2, (renderAt - p.recvAt) / span) : 1
        this.apply(
          p.x + (q.x - p.x) * t,
          p.y + (q.y - p.y) * t,
          p.z + (q.z - p.z) * t,
          lerpAngle(p.yaw, q.yaw, Math.min(1, t)),
          dt,
        )
      } else {
        this.apply(b.x, b.y, b.z, b.yaw, dt)
      }
      this.player.updateVisuals(dt)
      return
    }

    for (let i = 0; i < this.snaps.length - 1; i++) {
      const s0 = this.snaps[i]!
      const s1 = this.snaps[i + 1]!
      if (renderAt >= s0.recvAt && renderAt <= s1.recvAt) {
        a = s0
        b = s1
        break
      }
    }

    const span = b.recvAt - a.recvAt
    const u = span > 1e-3 ? (renderAt - a.recvAt) / span : 1
    this.apply(
      a.x + (b.x - a.x) * u,
      a.y + (b.y - a.y) * u,
      a.z + (b.z - a.z) * u,
      lerpAngle(a.yaw, b.yaw, u),
      dt,
    )
    this.player.updateVisuals(dt)
  }

  dispose(): void {
    this.player.setHeldStack([])
    this.player.setHeldItem(null)
    this.player.headCard.dispose()
    const tex = this.nameSprite.material.map
    this.nameSprite.material.dispose()
    tex?.dispose()
  }

  private apply(x: number, y: number, z: number, yaw: number, dt = 1 / 60): void {
    // Body center → feet (root carries nameplate + mesh together)
    if (this.lastXZ && dt > 1e-4) {
      const dx = x - this.lastXZ.x
      const dz = z - this.lastXZ.z
      const speed = Math.hypot(dx, dz) / dt
      this.player.setMoveSpeed(speed)
    } else {
      this.player.setMoveSpeed(0)
    }
    this.lastXZ = { x, z }
    this.lastKnown = { x, y, z, yaw }
    this.root.position.set(x, y - this.halfTotal, z)
    this.player.mesh.position.set(0, 0, 0)
    this.player.mesh.rotation.y = yaw
    this.player.mesh.visible = true
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

function makeNameSprite(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, 256, 64)
  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)'
  roundRect(ctx, 8, 12, 240, 40, 10)
  ctx.fill()
  ctx.font = 'bold 28px system-ui,sans-serif'
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name.slice(0, 16), 128, 32)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: true,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(1.6, 0.4, 1)
  return sprite
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
