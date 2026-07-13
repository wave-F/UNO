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
  }

  pushPose(x: number, y: number, z: number, yaw: number): void {
    const snap: Snapshot = { recvAt: performance.now(), x, y, z, yaw }
    this.snaps.push(snap)
    // Keep a short buffer
    while (this.snaps.length > 12) this.snaps.shift()
  }

  update(dt: number): void {
    this.player.updateVisuals(dt)
    if (this.snaps.length === 0) return

    const renderAt = performance.now() - this.interpDelayMs

    // Find surrounding snapshots
    let a = this.snaps[0]!
    let b = this.snaps[this.snaps.length - 1]!

    if (renderAt <= a.recvAt) {
      this.apply(a.x, a.y, a.z, a.yaw)
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
        )
      } else {
        this.apply(b.x, b.y, b.z, b.yaw)
      }
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
    )
  }

  dispose(): void {
    this.player.setHeldStack([])
    this.player.setHeldItem(null)
    this.player.headCard.dispose()
    const tex = this.nameSprite.material.map
    this.nameSprite.material.dispose()
    tex?.dispose()
  }

  private apply(x: number, y: number, z: number, yaw: number): void {
    // Body center → feet mesh (same as PlayerController.syncMesh)
    this.player.mesh.position.set(x, y - this.halfTotal, z)
    this.player.mesh.rotation.y = yaw
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
