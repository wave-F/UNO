import * as THREE from 'three'
import {
  TRAINING_DUMMY_NAME,
  TRAINING_DUMMY_Y,
} from '../../shared/config/dummy'
import { StunFx } from './StunFx'
import { createCardMesh, disposeCardMesh, CARD_D } from '../game/uno/cardVisual'
import type { UnoCardData } from '../game/uno/types'
import { movementConfig } from '../config/movement'
import { STUN_DURATION_MS } from '../game/uno/types'

/**
 * Arena-center wood training dummy for stun / drop tests.
 * Feet at y=0; body center matches server TRAINING_DUMMY_Y.
 */
export class TrainingDummy {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly stunFx: StunFx
  private readonly stackRoot = new THREE.Group()
  private layers: { mesh: THREE.Mesh; texture: THREE.CanvasTexture }[] = []
  private readonly halfTotal: number
  private readonly baseX: number
  private readonly baseY: number
  private readonly baseZ: number

  private hitT = -1
  private readonly hitDuration = 0.45
  private hitDirX = 0
  private hitDirZ = 1
  private readonly bodyMats: THREE.MeshStandardMaterial[] = []
  private knock: {
    t: number
    duration: number
    fromX: number
    fromZ: number
    toX: number
    toZ: number
  } | null = null

  constructor() {
    this.root.name = 'TrainingDummy'
    this.halfTotal = movementConfig.capsuleHalfHeight + movementConfig.capsuleRadius
    this.baseX = 0
    this.baseY = TRAINING_DUMMY_Y - this.halfTotal
    this.baseZ = 0
    this.root.position.set(this.baseX, this.baseY, this.baseZ)

    this.root.add(this.body)

    const wood = new THREE.MeshStandardMaterial({
      color: 0x8b5a2b,
      roughness: 0.85,
      metalness: 0.05,
    })
    const darkWood = new THREE.MeshStandardMaterial({
      color: 0x5c3a1e,
      roughness: 0.9,
    })
    const rope = new THREE.MeshStandardMaterial({
      color: 0xd4a574,
      roughness: 0.7,
    })
    this.bodyMats.push(wood, darkWood, rope)

    const postH = 1.55
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.14, postH, 10),
      wood,
    )
    post.position.y = postH / 2
    post.castShadow = true
    this.body.add(post)

    const arm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1.35, 8),
      wood,
    )
    arm.rotation.z = Math.PI / 2
    arm.position.y = 1.15
    arm.castShadow = true
    this.body.add(arm)

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.32), darkWood)
    head.position.y = postH + 0.12
    head.castShadow = true
    this.body.add(head)

    const targetMat = new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.5,
      side: THREE.DoubleSide,
      emissive: 0x000000,
      emissiveIntensity: 0,
    })
    this.bodyMats.push(targetMat)
    const target = new THREE.Mesh(new THREE.CircleGeometry(0.22, 20), targetMat)
    target.position.set(0, 0.95, 0.14)
    this.body.add(target)

    const bull = new THREE.Mesh(
      new THREE.CircleGeometry(0.08, 16),
      new THREE.MeshStandardMaterial({
        color: 0xfef08a,
        side: THREE.DoubleSide,
      }),
    )
    bull.position.set(0, 0.95, 0.145)
    this.body.add(bull)

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.4, 0.12, 12),
      darkWood,
    )
    base.position.y = 0.06
    base.receiveShadow = true
    this.body.add(base)

    const wrap = new THREE.Mesh(
      new THREE.TorusGeometry(0.13, 0.03, 6, 12),
      rope,
    )
    wrap.rotation.x = Math.PI / 2
    wrap.position.y = 0.55
    this.body.add(wrap)

    // Stars above head (above name plate)
    this.stunFx = new StunFx(postH + 0.55)
    this.root.add(this.stunFx.root)

    this.stackRoot.position.set(0, 0.9, -0.22)
    this.body.add(this.stackRoot)

    const label = makeLabel(TRAINING_DUMMY_NAME)
    label.position.y = postH + 0.52
    this.root.add(label)
  }

  setStack(stack: readonly UnoCardData[]): void {
    for (const L of this.layers) {
      this.stackRoot.remove(L.mesh)
      disposeCardMesh(L.mesh, L.texture)
    }
    this.layers = []
    const scale = 0.35
    const step = CARD_D * scale + 0.012
    for (let i = 0; i < stack.length; i++) {
      const { mesh, texture } = createCardMesh(stack[i]!, scale)
      mesh.position.z = -i * step
      this.stackRoot.add(mesh)
      this.layers.push({ mesh, texture })
    }
  }

  /**
   * Hit reaction: lean/shake + stun stars for durationMs.
   * @param fromX attacker world X (for lean direction); omit = lean random
   * @param fromZ attacker world Z
   */
  playHit(
    durationMs = STUN_DURATION_MS,
    fromX?: number,
    fromZ?: number,
  ): void {
    this.stunFx.play(durationMs)
    this.hitT = 0
    if (fromX !== undefined && fromZ !== undefined) {
      const dx = this.root.position.x - fromX
      const dz = this.root.position.z - fromZ
      const len = Math.hypot(dx, dz) || 1
      this.hitDirX = dx / len
      this.hitDirZ = dz / len
    } else {
      const a = Math.random() * Math.PI * 2
      this.hitDirX = Math.cos(a)
      this.hitDirZ = Math.sin(a)
    }
    // Flash target red-hot
    for (const m of this.bodyMats) {
      m.emissive?.setHex?.(0x7f1d1d)
      if ('emissiveIntensity' in m) m.emissiveIntensity = 0.55
    }
  }

  setStunnedUntil(untilMs: number, durationMs = STUN_DURATION_MS): void {
    this.stunFx.setStunnedUntil(untilMs, durationMs)
  }

  /** Visual-only knock (dummy stays authoritative at center after anim). */
  playKnockback(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    durationMs: number,
  ): void {
    this.knock = {
      t: 0,
      duration: Math.max(0.2, durationMs / 1000),
      fromX,
      fromZ,
      toX,
      toZ,
    }
  }

  update(dt: number): void {
    this.stunFx.update(dt)

    if (this.knock) {
      this.knock.t += dt
      const u = Math.min(1, this.knock.t / this.knock.duration)
      // Arc out then spring back to home base so dummy stays a training target
      const out = Math.sin(u * Math.PI)
      const x =
        this.baseX +
        (this.knock.toX - this.knock.fromX) * out * 0.85
      const z =
        this.baseZ +
        (this.knock.toZ - this.knock.fromZ) * out * 0.85
      const y = this.baseY + Math.sin(u * Math.PI) * 0.9
      this.root.position.set(x, y, z)
      this.body.rotation.x = Math.sin(u * Math.PI) * 0.7
      this.body.rotation.z = Math.sin(u * Math.PI * 2) * 0.35
      if (u >= 1) {
        this.root.position.set(this.baseX, this.baseY, this.baseZ)
        this.body.rotation.set(0, 0, 0)
        this.knock = null
      }
      return
    }

    if (this.hitT >= 0) {
      this.hitT += dt
      const u = Math.min(1, this.hitT / this.hitDuration)
      // Impact then spring back
      const wave = Math.sin(u * Math.PI) * (1 - u * 0.35)
      const lean = wave * 0.55
      this.body.rotation.x = this.hitDirZ * lean
      this.body.rotation.z = -this.hitDirX * lean
      this.body.position.x = this.hitDirX * wave * 0.12
      this.body.position.z = this.hitDirZ * wave * 0.12
      // Fade emissive
      const em = (1 - u) * 0.55
      for (const m of this.bodyMats) {
        if ('emissiveIntensity' in m) m.emissiveIntensity = em
      }
      if (u >= 1) {
        this.hitT = -1
        this.body.rotation.set(0, 0, 0)
        this.body.position.set(0, 0, 0)
        for (const m of this.bodyMats) {
          if (m.emissive) m.emissive.setHex(0x000000)
          if ('emissiveIntensity' in m) m.emissiveIntensity = 0
        }
      }
    }
  }

  dispose(): void {
    this.setStack([])
    this.stunFx.dispose()
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose()
        const m = o.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m?.dispose()
      }
    })
  }
}

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 64
  const ctx = c.getContext('2d')!
  ctx.fillStyle = 'rgba(15,23,42,0.75)'
  ctx.beginPath()
  ctx.roundRect(8, 8, 240, 48, 12)
  ctx.fill()
  ctx.fillStyle = '#fde68a'
  ctx.font = 'bold 28px system-ui,sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 34)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }),
  )
  sp.scale.set(1.4, 0.35, 1)
  return sp
}
