import * as THREE from 'three'
import { movementConfig } from '../config/movement'
import { HeadCardDisplay } from './HeadCardDisplay'
import { AttackRangeVisual } from './AttackRangeVisual'
import { SlideRangeVisual } from './SlideRangeVisual'
import { StunFx } from './StunFx'
import {
  createCardMesh,
  disposeCardMesh,
} from '../game/uno/cardVisual'
import { createMaceMesh, disposeMaceMesh } from '../game/uno/maceVisual'
import { isSkipTrap, isStunBat, type UnoCardData } from '../game/uno/types'

export type PlayerVisualOptions = {
  /** Body color (default local pink). */
  color?: number
  name?: string
}

/** Procedural limb pose mode (visual only). */
export type LimbMode = 'normal' | 'slide' | 'knock' | 'stun'

/**
 * Visual bean: capsule body + stubby arms/legs + face + backpack cards.
 * Hand item (眩晕狼牙棒) held at right-hand pivot on the right arm.
 */
export class Player {
  readonly mesh: THREE.Group
  /** Visual lean / tumble only — does not affect ground hit indicators. */
  private readonly bodyRoot: THREE.Group
  readonly headCard: HeadCardDisplay
  private bodyMesh: THREE.Mesh
  private heldCount = 0
  private heldItem: UnoCardData | null = null

  /** Right-hand pivot (on right arm / hand). */
  private readonly handPivot: THREE.Group
  private weaponRoot: THREE.Group | null = null
  private weaponFaceTex: THREE.CanvasTexture | null = null

  private swingT = -1
  private readonly swingDuration = 0.34
  private readonly handRestZ = 0.15
  private readonly handRestX = -0.25
  /** Swing arc for mace. */
  private readonly handSwingZ = -Math.PI * 0.95
  private readonly handSwingX = -0.55

  private readonly totalHeight: number
  readonly attackRange: AttackRangeVisual
  readonly slideRange: SlideRangeVisual
  private readonly stunFx: StunFx

  /** Floating UNO! above head (match moment; on mesh so it stays upright). */
  private unoAlert = false
  private readonly unoSprite: THREE.Sprite
  private readonly unoTex: THREE.CanvasTexture
  private unoPulse = 0
  private readonly unoBaseY: number

  // --- Stubby Fall-Guys limbs (visual only) ---
  private readonly armL: THREE.Group
  private readonly armR: THREE.Group
  private readonly legL: THREE.Group
  private readonly legR: THREE.Group
  private limbPhase = 0
  private moveSpeed = 0
  private limbMode: LimbMode = 'normal'
  private readonly bodyColor: number

  constructor(opts: PlayerVisualOptions = {}) {
    this.mesh = new THREE.Group()
    this.mesh.name = opts.name ? `Player:${opts.name}` : 'Player'

    // bodyRoot: pitch/roll lean; mesh.rotation.y = facing only
    this.bodyRoot = new THREE.Group()
    this.bodyRoot.name = 'BodyRoot'
    this.mesh.add(this.bodyRoot)

    const { capsuleRadius: r, capsuleHalfHeight: h } = movementConfig
    this.totalHeight = h * 2 + r * 2
    this.bodyColor = opts.color ?? 0xff8fab

    const bodyGeo = new THREE.CapsuleGeometry(r, h * 2, 8, 16)
    const bodyMat = new THREE.MeshStandardMaterial({
      color: this.bodyColor,
      roughness: 0.4,
      metalness: 0.05,
    })
    this.bodyMesh = new THREE.Mesh(bodyGeo, bodyMat)
    this.bodyMesh.castShadow = true
    this.bodyMesh.position.y = this.totalHeight / 2
    this.bodyRoot.add(this.bodyMesh)

    const eyeGeo = new THREE.SphereGeometry(0.08, 8, 8)
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1e1e2e })
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
    eyeL.position.set(-0.14, this.totalHeight * 0.72, r * 0.75)
    eyeR.position.set(0.14, this.totalHeight * 0.72, r * 0.75)
    this.bodyRoot.add(eyeL, eyeR)

    const mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.05, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x7f1d1d }),
    )
    mouth.position.set(0, this.totalHeight * 0.55, r * 0.85)
    this.bodyRoot.add(mouth)

    this.headCard = new HeadCardDisplay()
    this.bodyRoot.add(this.headCard.root)

    // Stubby arms + legs (Fall Guys style proportions)
    const limbMat = new THREE.MeshStandardMaterial({
      color: this.bodyColor,
      roughness: 0.45,
      metalness: 0.05,
    })
    const handMat = new THREE.MeshStandardMaterial({
      color: 0xffe4ec,
      roughness: 0.55,
      metalness: 0.0,
    })
    const footMat = new THREE.MeshStandardMaterial({
      color: 0x3b3b52,
      roughness: 0.7,
      metalness: 0.05,
    })

    // Stubby arms stick OUT from body (Z sign: L negative / R positive = outward)
    // Length ~1/3 of previous 0.52×height so hands stay short Fall-Guys nubs
    const armLen = this.totalHeight * 0.173
    const armRad = r * 0.2
    const legLen = this.totalHeight * 0.28
    const legRad = r * 0.24
    const shoulderY = this.totalHeight * 0.56
    // Slightly outside capsule surface so mesh does not spawn inside body
    const shoulderX = r * 1.08

    this.armL = this.makeLimb({
      name: 'ArmL',
      length: armLen,
      radius: armRad,
      limbMat,
      tipMat: handMat,
      tipScale: 1.35,
      tipIsFoot: false,
    })
    this.armL.position.set(-shoulderX, shoulderY, 0.02)
    // Rest: ~70° out to the side + slight down (hands clear of belly)
    this.armL.rotation.z = -1.15
    this.armL.rotation.x = 0.2
    this.bodyRoot.add(this.armL)

    this.armR = this.makeLimb({
      name: 'ArmR',
      length: armLen,
      radius: armRad,
      limbMat,
      tipMat: handMat,
      tipScale: 1.35,
      tipIsFoot: false,
    })
    this.armR.position.set(shoulderX, shoulderY, 0.02)
    this.armR.rotation.z = 1.15
    this.armR.rotation.x = 0.2
    this.bodyRoot.add(this.armR)

    const hipY = this.totalHeight * 0.18
    const hipX = r * 0.32
    this.legL = this.makeLimb({
      name: 'LegL',
      length: legLen,
      radius: legRad,
      limbMat,
      tipMat: footMat,
      tipScale: 1.45,
      tipIsFoot: true,
    })
    this.legL.position.set(-hipX, hipY, 0.02)
    this.legL.rotation.x = 0.08
    this.bodyRoot.add(this.legL)

    this.legR = this.makeLimb({
      name: 'LegR',
      length: legLen,
      radius: legRad,
      limbMat,
      tipMat: footMat,
      tipScale: 1.45,
      tipIsFoot: true,
    })
    this.legR.position.set(hipX, hipY, 0.02)
    this.legR.rotation.x = 0.08
    this.bodyRoot.add(this.legR)

    // Weapon pivot sits on right hand tip
    this.handPivot = new THREE.Group()
    this.handPivot.name = 'HandPivot'
    this.handPivot.position.set(0, -armLen * 0.95, 0)
    this.handPivot.rotation.x = this.handRestX
    this.handPivot.rotation.z = this.handRestZ
    this.armR.add(this.handPivot)
    this.handPivot.visible = false

    // Hit indicators stay on mesh (yaw only) so slide lean does not warp them
    this.attackRange = new AttackRangeVisual()
    this.mesh.add(this.attackRange.root)

    this.slideRange = new SlideRangeVisual()
    this.mesh.add(this.slideRange.root)

    this.stunFx = new StunFx(this.totalHeight)
    this.bodyRoot.add(this.stunFx.root)

    // Head UNO banner (above stun / name; does not pitch with body lean)
    const unoCanvas = document.createElement('canvas')
    unoCanvas.width = 320
    unoCanvas.height = 112
    const unoCtx = unoCanvas.getContext('2d')!
    paintHeadUno(unoCtx, unoCanvas.width, unoCanvas.height)
    this.unoTex = new THREE.CanvasTexture(unoCanvas)
    this.unoTex.colorSpace = THREE.SRGBColorSpace
    this.unoSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.unoTex,
        transparent: true,
        depthWrite: false,
      }),
    )
    this.unoBaseY = this.totalHeight + 0.85
    this.unoSprite.scale.set(2.4, 0.85, 1)
    this.unoSprite.position.set(0, this.unoBaseY, 0)
    this.unoSprite.visible = false
    this.mesh.add(this.unoSprite)
  }

  /** Show / hide UNO moment flag above this avatar's head. */
  setUnoAlert(active: boolean): void {
    this.unoAlert = active
    this.unoSprite.visible = active
    if (!active) {
      this.unoPulse = 0
      this.unoSprite.position.y = this.unoBaseY
      this.unoSprite.scale.set(2.4, 0.85, 1)
    }
  }

  isUnoAlert(): boolean {
    return this.unoAlert
  }

  /**
   * Short stub: capsule hangs along -Y from pivot + tip sphere (hand/foot).
   */
  private makeLimb(opts: {
    name: string
    length: number
    radius: number
    limbMat: THREE.Material
    tipMat: THREE.Material
    tipScale: number
    tipIsFoot: boolean
  }): THREE.Group {
    const g = new THREE.Group()
    g.name = opts.name
    // Cylinder part length; hemispheres add 2*radius to total visual length
    const cyl = Math.max(0.04, opts.length - opts.radius * 2)
    const limb = new THREE.Mesh(
      new THREE.CapsuleGeometry(opts.radius, cyl, 4, 8),
      opts.limbMat,
    )
    limb.castShadow = true
    limb.position.y = -opts.length * 0.5
    g.add(limb)

    const tipR = opts.radius * opts.tipScale
    const tip = new THREE.Mesh(
      opts.tipIsFoot
        ? new THREE.SphereGeometry(tipR, 8, 6)
        : new THREE.SphereGeometry(tipR, 8, 8),
      opts.tipMat,
    )
    tip.castShadow = true
    tip.position.y = -opts.length
    if (opts.tipIsFoot) {
      tip.scale.set(1.15, 0.65, 1.35)
      tip.position.z = tipR * 0.25
    }
    g.add(tip)
    return g
  }

  /** Horizontal move speed (m/s) for walk/run limb swing. */
  setMoveSpeed(speed: number): void {
    this.moveSpeed = Math.max(0, speed)
  }

  /** Visual limb pose mode (slide / knock / stun / normal). */
  setLimbMode(mode: LimbMode): void {
    this.limbMode = mode
  }

  /** Slide lean / knock tumble — body only, ground FX stay level. */
  setBodyPitch(pitch: number, roll = 0): void {
    this.bodyRoot.rotation.x = pitch
    this.bodyRoot.rotation.z = roll
  }

  /** Show stun stars (local clock via duration). */
  setStunnedUntil(untilMs: number, durationMs = 1500): void {
    this.stunFx.setStunnedUntil(untilMs, durationMs)
  }

  playStun(durationMs: number): void {
    this.stunFx.play(durationMs)
  }

  /** Whether stun FX is currently active (for remote limb pose). */
  isStunFxActive(): boolean {
    return this.stunFx.isActive()
  }

  /** Hide / show whole avatar (fence death vanish). */
  setAvatarVisible(visible: boolean): void {
    this.mesh.visible = visible
  }

  setHeldStack(stack: readonly UnoCardData[]): void {
    this.heldCount = stack.length
    this.headCard.setStack(stack)
    this.slideRange.setStackCount(stack.length)
    // Empty hand → show slide corridor preview
    this.slideRange.setIdlePreview(!this.heldItem)
  }

  getHeldCount(): number {
    return this.heldCount
  }

  setHeldItem(item: UnoCardData | null): void {
    const same =
      (this.heldItem?.id ?? null) === (item?.id ?? null) &&
      !!this.heldItem === !!item
    this.heldItem = item
    if (!same) {
      // Keep mesh during active swing so hit-consume still looks like a follow-through
      if (item || this.swingT < 0) this.rebuildWeaponMesh()
    }
    this.handPivot.visible = !!item || this.swingT >= 0
    // Melee cone only for mace; skip is place-at-feet
    this.attackRange.setHolding(!!item && isStunBat(item))
    // Slide strip when empty-handed
    this.slideRange.setIdlePreview(!item)
    if (!item && this.swingT < 0) {
      this.handPivot.rotation.set(this.handRestX, 0, this.handRestZ)
    }
  }

  /** Flash slide hit corridor (actual distance when known). */
  flashSlideRange(dist?: number): void {
    this.slideRange.flashSlide(dist)
  }

  getHeldItem(): UnoCardData | null {
    return this.heldItem
  }

  /** Play one melee swing (local attack or network hit fx). */
  playSwing(): void {
    if (!this.heldItem && !this.weaponRoot) return
    this.swingT = 0
    this.handPivot.visible = true
    this.attackRange.flashSwing()
  }

  updateVisuals(dt: number): void {
    this.headCard.update(dt)
    this.stunFx.update(dt)
    this.attackRange.update(dt)
    this.slideRange.update(dt)
    if (this.unoAlert) {
      this.unoPulse += dt * 4.5
      const bob = Math.sin(this.unoPulse) * 0.08
      const sc = 1 + 0.08 * Math.sin(this.unoPulse * 1.8)
      this.unoSprite.position.y = this.unoBaseY + bob
      this.unoSprite.scale.set(2.4 * sc, 0.85 * sc, 1)
    }
    this.updateLimbs(dt)
    if (this.swingT >= 0) {
      this.swingT += dt
      const u = Math.min(1, this.swingT / this.swingDuration)
      const ease =
        u < 0.35
          ? (u / 0.35) * 0.25
          : 0.25 + ((u - 0.35) / 0.65) * 0.75
      const wave = Math.sin(ease * Math.PI)
      this.handPivot.rotation.z =
        this.handRestZ + (this.handSwingZ - this.handRestZ) * wave
      this.handPivot.rotation.x =
        this.handRestX + (this.handSwingX - this.handRestX) * wave
      this.handPivot.rotation.y = 0.4 * wave
      if (u >= 1) {
        this.swingT = -1
        this.handPivot.rotation.set(this.handRestX, 0, this.handRestZ)
        if (!this.heldItem) {
          this.rebuildWeaponMesh()
          this.handPivot.visible = false
        }
      }
    }
  }

  private updateLimbs(dt: number): void {
    // L: z < 0, R: z > 0 → arms point outward (not into belly)
    const restArmZL = -1.15
    const restArmZR = 1.15
    const restArmX = 0.2
    const restLegX = 0.08

    if (this.limbMode === 'slide') {
      // Feet-first slide: legs kick forward, arms trail back & stay wide
      this.armL.rotation.set(-1.05, 0, -1.05)
      this.armR.rotation.set(-1.05, 0, 1.05)
      this.legL.rotation.set(1.15, 0, 0.1)
      this.legR.rotation.set(1.15, 0, -0.1)
      return
    }

    if (this.limbMode === 'knock') {
      // Floppy mid-air: soft sin tumble on limbs
      this.limbPhase += dt * 10
      const w = Math.sin(this.limbPhase)
      this.armL.rotation.set(0.5 + w * 0.5, 0, -1.0 - w * 0.15)
      this.armR.rotation.set(0.5 - w * 0.5, 0, 1.0 + w * 0.15)
      this.legL.rotation.set(0.4 + w * 0.6, 0, 0.25)
      this.legR.rotation.set(0.4 - w * 0.6, 0, -0.25)
      return
    }

    if (this.limbMode === 'stun') {
      this.limbPhase += dt * 6
      const w = Math.sin(this.limbPhase) * 0.12
      this.armL.rotation.set(0.35 + w, 0, restArmZL - 0.1)
      this.armR.rotation.set(0.35 - w, 0, restArmZR + 0.1)
      this.legL.rotation.set(restLegX, 0, 0.08)
      this.legR.rotation.set(restLegX, 0, -0.08)
      return
    }

    // normal: idle or run cycle driven by moveSpeed
    const maxSp = movementConfig.maxSpeed
    const runAmt = THREE.MathUtils.clamp(this.moveSpeed / Math.max(maxSp, 0.01), 0, 1)
    if (runAmt < 0.08) {
      // Idle: tiny bob — keep arms wide out
      this.limbPhase += dt * 2.2
      const bob = Math.sin(this.limbPhase) * 0.05
      this.armL.rotation.set(restArmX + bob, 0, restArmZL)
      this.armR.rotation.set(restArmX - bob, 0, restArmZR)
      this.legL.rotation.set(restLegX, 0, 0.05)
      this.legR.rotation.set(restLegX, 0, -0.05)
      return
    }

    // Run: swing forward/back on X, keep strong outward Z so hands stay visible
    const cadence = 8 + runAmt * 6
    this.limbPhase += dt * cadence
    const swing = Math.sin(this.limbPhase) * (0.5 * runAmt + 0.1)
    const armSwing = swing * 0.75
    const legSwing = swing * 0.95

    this.armL.rotation.set(restArmX + armSwing, 0, restArmZL)
    this.armR.rotation.set(restArmX - armSwing, 0, restArmZR)
    this.legL.rotation.set(restLegX - legSwing, 0, 0.06)
    this.legR.rotation.set(restLegX + legSwing, 0, -0.06)
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

  private rebuildWeaponMesh(): void {
    this.clearWeaponMesh()
    if (!this.heldItem) return

    this.weaponRoot = new THREE.Group()

    if (isStunBat(this.heldItem)) {
      // Mace grip at hand: tip points up/forward slightly
      const mace = createMaceMesh(0.85)
      mace.position.set(0.05, -0.08, 0.02)
      mace.rotation.x = 0.15
      mace.rotation.z = -0.2
      this.weaponRoot.add(mace)
    } else if (isSkipTrap(this.heldItem)) {
      const { mesh, texture } = createCardMesh(this.heldItem, 0.42, 0.35)
      this.weaponFaceTex = texture
      mesh.position.set(0.04, -0.02, 0.06)
      mesh.rotation.x = 0.35
      mesh.rotation.z = -0.15
      this.weaponRoot.add(mesh)
    } else {
      const mace = createMaceMesh(0.7)
      this.weaponRoot.add(mace)
    }

    this.handPivot.add(this.weaponRoot)
  }

  private clearWeaponMesh(): void {
    if (!this.weaponRoot) return
    this.handPivot.remove(this.weaponRoot)
    if (this.weaponFaceTex) {
      let disposed = false
      this.weaponRoot.traverse((o) => {
        if (!disposed && o instanceof THREE.Mesh && this.weaponFaceTex) {
          disposeCardMesh(o, this.weaponFaceTex)
          disposed = true
        }
      })
      this.weaponFaceTex = null
    } else {
      disposeMaceMesh(this.weaponRoot)
    }
    this.weaponRoot = null
  }
}

function paintHeadUno(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h)
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#fbbf24')
  g.addColorStop(0.55, '#f97316')
  g.addColorStop(1, '#ef4444')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.roundRect(10, 14, w - 20, h - 28, 18)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 5
  ctx.stroke()
  ctx.fillStyle = '#1a0a00'
  ctx.font = 'bold 58px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('UNO!', w / 2, h / 2 + 2)
}
