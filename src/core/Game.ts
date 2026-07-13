import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { initRapier, PhysicsWorld } from './Physics'
import { InputManager } from '../managers/InputManager'
import { Environment } from '../entities/Environment'
import { HomeBase } from '../entities/HomeBase'
import { PlayerController } from '../entities/PlayerController'
import { CameraFollow } from '../systems/CameraFollow'
import {
  CardPickupSystem,
  type PickupFeedback,
} from '../systems/CardPickupSystem'

export class Game {
  private renderer!: WebGPURenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200)
  private physics!: PhysicsWorld
  private input!: InputManager
  private playerCtrl!: PlayerController
  private cameraFollow!: CameraFollow
  private cardSystem!: CardPickupSystem
  private homeBase!: HomeBase
  private clock = new THREE.Clock()
  private running = false
  private container: HTMLElement
  private onPickupFeedback: (fb: PickupFeedback) => void
  private onPointerLockChange: ((locked: boolean) => void) | null = null

  constructor(
    container: HTMLElement,
    onPickupFeedback: (fb: PickupFeedback) => void = () => {},
  ) {
    this.container = container
    this.onPickupFeedback = onPickupFeedback
    this.scene.background = new THREE.Color(0x87ceeb)
    this.scene.fog = new THREE.Fog(0x87ceeb, 35, 70)
  }

  setPointerLockListener(cb: (locked: boolean) => void): void {
    this.onPointerLockChange = cb
  }

  async init(): Promise<void> {
    this.renderer = new WebGPURenderer({ antialias: true })
    await this.renderer.init()
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.renderer.shadowMap.enabled = true
    this.container.appendChild(this.renderer.domElement)

    this.input = new InputManager(this.renderer.domElement)
    document.addEventListener('pointerlockchange', this.handlePointerLock)

    this.setupLights()

    const R = await initRapier()
    this.physics = new PhysicsWorld(R)

    const env = new Environment(this.physics)
    this.scene.add(env.group)

    this.homeBase = new HomeBase()
    this.scene.add(this.homeBase.group)

    this.cameraFollow = new CameraFollow(this.camera, this.input)
    this.playerCtrl = new PlayerController(this.physics, this.input, this.cameraFollow)
    this.scene.add(this.playerCtrl.player.mesh)

    this.cardSystem = new CardPickupSystem(
      (fb) => {
        if (fb.type === 'picked') {
          this.playerCtrl.player.setHeldStack(fb.stack)
        } else if (fb.type === 'deposited') {
          this.playerCtrl.player.setHeldStack([])
        }
        this.onPickupFeedback(fb)
      },
      (cards) => this.homeBase.deposit(cards),
    )
    this.scene.add(this.cardSystem.group)

    this.cameraFollow.snapTo(this.playerCtrl.getPosition())

    window.addEventListener('resize', this.onResize)
    this.onResize()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.clock.start()
    this.renderer.setAnimationLoop(this.tick)
  }

  stop(): void {
    this.running = false
    this.renderer.setAnimationLoop(null)
  }

  dispose(): void {
    this.stop()
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('pointerlockchange', this.handlePointerLock)
    this.input.dispose()
    this.cardSystem?.dispose()
    this.homeBase?.dispose()
    this.physics.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private handlePointerLock = (): void => {
    const locked = document.pointerLockElement === this.renderer.domElement
    this.onPointerLockChange?.(locked)
  }

  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xfff1f2, 0x4ade80, 1.1)
    this.scene.add(hemi)

    const sun = new THREE.DirectionalLight(0xfff7ed, 1.6)
    sun.position.set(12, 22, 10)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 60
    sun.shadow.camera.left = -25
    sun.shadow.camera.right = 25
    sun.shadow.camera.top = 25
    sun.shadow.camera.bottom = -25
    this.scene.add(sun)
  }

  private tick = (): void => {
    const dt = Math.min(this.clock.getDelta(), 0.05)

    this.cameraFollow.updateLook()
    this.playerCtrl.update(dt)
    this.physics.step()
    const pos = this.playerCtrl.getPosition()
    this.cameraFollow.updatePosition(pos, dt)
    this.cardSystem.update(pos, dt)

    void this.renderer.render(this.scene, this.camera)
  }

  private onResize = (): void => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera.aspect = w / Math.max(h, 1)
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }
}
