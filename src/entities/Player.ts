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

/**
 * Visual bean: capsule body + face + backpack cards.
 * Hand item (眩晕狼牙棒) held at right-hand pivot — mace mesh only, no arm.
 */
export class Player {
  readonly mesh: THREE.Group
  /** Visual lean / tumble only — does not affect ground hit indicators. */
  private readonly bodyRoot: THREE.Group
  readonly headCard: HeadCardDisplay
  private bodyMesh: THREE.Mesh
  private heldCount = 0
  private heldItem: UnoCardData | null = null

  /** Right-hand pivot (shoulder/hand height). */
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

  constructor(opts: PlayerVisualOptions = {}) {
    this.mesh = new THREE.Group()
    this.mesh.name = opts.name ? `Player:${opts.name}` : 'Player'

    // bodyRoot: pitch/roll lean; mesh.rotation.y = facing only
    this.bodyRoot = new THREE.Group()
    this.bodyRoot.name = 'BodyRoot'
    this.mesh.add(this.bodyRoot)

    const { capsuleRadius: r, capsuleHalfHeight: h } = movementConfig
    this.totalHeight = h * 2 + r * 2

    const bodyGeo = new THREE.CapsuleGeometry(r, h * 2, 8, 16)
    const bodyMat = new THREE.MeshStandardMaterial({
      color: opts.color ?? 0xff8fab,
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

    // Right hand / hip grip — no arm mesh, just weapon
    this.handPivot = new THREE.Group()
    this.handPivot.name = 'HandPivot'
    this.handPivot.position.set(r * 0.95, this.totalHeight * 0.48, 0.12)
    this.handPivot.rotation.x = this.handRestX
    this.handPivot.rotation.z = this.handRestZ
    this.bodyRoot.add(this.handPivot)
    this.handPivot.visible = false

    // Hit indicators stay on mesh (yaw only) so slide lean does not warp them
    this.attackRange = new AttackRangeVisual()
    this.mesh.add(this.attackRange.root)

    this.slideRange = new SlideRangeVisual()
    this.mesh.add(this.slideRange.root)

    this.stunFx = new StunFx(this.totalHeight)
    this.bodyRoot.add(this.stunFx.root)
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
