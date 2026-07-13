import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { getHomeSlot, homeConfig } from '../config/home'
import { initRapier, PhysicsWorld } from './Physics'
import { InputManager } from '../managers/InputManager'
import { Environment } from '../entities/Environment'
import { HomeYard } from '../entities/HomeBase'
import { PlayerController } from '../entities/PlayerController'
import type { NetClient } from '../net/NetClient'
import { CameraFollow } from '../systems/CameraFollow'
import {
  CardPickupSystem,
  type PickupFeedback,
} from '../systems/CardPickupSystem'
import { RemotePlayerSystem } from '../systems/RemotePlayerSystem'
import { TRAINING_DUMMY_ID } from '../../shared/config/dummy'
import type { PublicPlayer } from '../../shared/protocol'
import type { UnoCardData } from '../game/uno/types'
import { TrainingDummy } from '../entities/TrainingDummy'

export class Game {
  private renderer!: WebGPURenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200)
  private physics!: PhysicsWorld
  private input!: InputManager
  private playerCtrl!: PlayerController
  private cameraFollow!: CameraFollow
  private cardSystem!: CardPickupSystem
  private homeYard!: HomeYard
  private remotes = new RemotePlayerSystem()
  private trainingDummy: TrainingDummy | null = null
  private pendingDummyStack: UnoCardData[] | null = null
  private net: NetClient | null = null
  private unsubs: Array<() => void> = []
  private clock = new THREE.Clock()
  private running = false
  private container: HTMLElement
  private onPickupFeedback: (fb: PickupFeedback) => void
  private onPointerLockChange: ((locked: boolean) => void) | null = null
  /** playerId → homeIndex (online roster). */
  private homeByPlayer = new Map<string, number>()

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

  private onScores: ((scores: { id: string; name?: string; score: number; stackCount: number }[]) => void) | null =
    null

  setScoresListener(
    cb: (scores: { id: string; name?: string; score: number; stackCount: number }[]) => void,
  ): void {
    this.onScores = cb
  }

  private onItem: ((item: UnoCardData | null) => void) | null = null

  setItemListener(cb: (item: UnoCardData | null) => void): void {
    this.onItem = cb
  }

  private onMatchClock: ((endsAt: number | null, winScore: number) => void) | null =
    null

  setMatchClockListener(
    cb: (endsAt: number | null, winScore: number) => void,
  ): void {
    this.onMatchClock = cb
  }

  private onMatchEnd:
    | ((info: {
        reason: 'score' | 'timeout'
        winners: { id: string; name?: string; score: number }[]
        scores: { id: string; name?: string; score: number; stackCount: number }[]
        winScore: number
        message: string
      }) => void)
    | null = null

  setMatchEndListener(
    cb: (info: {
      reason: 'score' | 'timeout'
      winners: { id: string; name?: string; score: number }[]
      scores: { id: string; name?: string; score: number; stackCount: number }[]
      winScore: number
      message: string
    }) => void,
  ): void {
    this.onMatchEnd = cb
  }

  private matchLive = false

  /** Wire LAN client (optional). Offline still works without this. */
  attachNet(net: NetClient): void {
    this.detachNet()
    this.net = net
    this.unsubs.push(
      net.on('welcome', (info) => {
        this.remotes.setLocalPlayerId(info.playerId)
        this.remotes.syncRoster(info.players)
        this.applyRosterHomes(info.players, info.playerId)
        // Always switch off local authority while in a network room
        this.cardSystem.enterOnlineMode()
        this.playerCtrl.player.setHeldStack([])
        this.remotes.clearAllStacks()
        this.homeYard.clearAllPiles()
        this.onScores?.([])

        if (info.phase === 'playing') {
          this.beginMatch(
            info.groundCards,
            info.yourStack,
            info.yourScore,
            info.scores,
            /*teleportHome*/ true,
            info.yourItem ?? null,
          )
          this.remotes.applyPlayerStacks(info.playerStacks ?? [])
          this.onMatchClock?.(info.matchEndsAt ?? null, info.winScore ?? 20)
        } else {
          this.matchLive = false
          this.removeTrainingDummy()
          this.onMatchClock?.(null, 20)
          // Lobby: still stand at your corner
          this.teleportLocalToHome()
        }
      }),
      net.on('roomState', (info) => {
        if (net.playerId) this.remotes.setLocalPlayerId(net.playerId)
        this.remotes.syncRoster(info.players)
        this.applyRosterHomes(info.players, net.playerId)
        if (info.phase === 'lobby' && this.matchLive) {
          // Match ended elsewhere / returned to lobby
          this.matchLive = false
          this.removeTrainingDummy()
          this.onMatchClock?.(null, 20)
        }
      }),
      net.on('matchStart', (ground, scores, homes, meta) => {
        this.remotes.clearAllStacks()
        this.homeYard.clearAllPiles()
        // Authoritative homes from match_start (do not trust only lobby roster)
        if (homes.length) {
          this.applyHomesList(homes, net.playerId, net.players)
        } else if (net.players.length) {
          this.applyRosterHomes(net.players, net.playerId)
        }
        this.beginMatch(ground, [], 0, scores, true, null)
        this.onMatchClock?.(meta.endsAt, meta.winScore)
      }),
      net.on('matchEnd', (info) => {
        this.matchLive = false
        this.removeTrainingDummy()
        this.remotes.clearAllStacks()
        this.homeYard.clearAllPiles()
        this.cardSystem.enterOnlineMode()
        this.playerCtrl.player.setHeldStack([])
        this.playerCtrl.player.setHeldItem(null)
        this.onItem?.(null)
        this.onMatchClock?.(null, info.winScore)
        this.onScores?.(info.scores)
        this.onMatchEnd?.(info)
      }),
      net.on('worldState', (_t, poses) => {
        if (!this.matchLive) return
        this.remotes.applyWorldState(poses)
      }),
      net.on('cardsSpawned', (cards, burstFrom) => {
        if (!this.matchLive) return
        this.cardSystem.applySpawned(cards, burstFrom)
      }),
      net.on('groundSnapshot', (cards) => {
        if (!this.matchLive) return
        this.cardSystem.applyGroundSnapshot(cards)
      }),
      net.on('cardPicked', (info) => {
        if (!this.matchLive) return
        this.cardSystem.applyCardRemoved(info.cardId)
      }),
      net.on('cardIllegal', (card, top, reason) => {
        this.cardSystem.notifyIllegal(card, top, reason)
      }),
      net.on('clearIllegal', () => {
        this.cardSystem.notifyClearIllegal()
      }),
      net.on('privateState', (stack, score, item) => {
        if (!this.matchLive) return
        this.applyLocalInventory(stack, score, item)
      }),
      net.on('playerStack', (playerId, stack) => {
        if (!this.matchLive) return
        if (playerId === TRAINING_DUMMY_ID) {
          if (this.trainingDummy) this.trainingDummy.setStack(stack)
          else this.pendingDummyStack = [...stack]
          return
        }
        this.remotes.setPlayerStack(playerId, stack)
      }),
      net.on('homeStolen', (info) => {
        if (!this.matchLive) return
        // Visual: remove top of victim home pile (thief backpack via private_state)
        this.homeYard.popTopFrom(info.victimHomeIndex)
      }),
      net.on('deposited', (info) => {
        if (!this.matchLive) return
        const slot = this.homeByPlayer.get(info.playerId) ?? homeConfig.defaultSlot
        if (info.playerId === net.playerId) {
          this.cardSystem.notifyDepositedCards(info.cards, info.score)
          this.playerCtrl.player.setHeldStack([])
        } else {
          // Other player's home pile + clear backpack visual
          this.homeYard.depositTo(slot, info.cards)
          this.remotes.setPlayerStack(info.playerId, [])
        }
      }),
      net.on('scores', (scores) => {
        this.onScores?.(scores)
      }),
      net.on('playerStunned', (playerId, until, durationMs) => {
        if (playerId === TRAINING_DUMMY_ID) {
          const pos = this.playerCtrl.getPosition()
          this.trainingDummy?.playHit(durationMs, pos.x, pos.z)
          this.onPickupFeedback({
            type: 'toast',
            text: `木头人眩晕 ${(durationMs / 1000).toFixed(1)}s`,
            kind: 'ok',
          })
          return
        }
        if (playerId === net.playerId) {
          this.playerCtrl.setStunUntil(until)
          this.playerCtrl.player.setStunnedUntil(until, durationMs)
          this.onPickupFeedback({
            type: 'toast',
            text: `被眩晕！${(durationMs / 1000).toFixed(1)} 秒`,
            kind: 'bad',
          })
        } else {
          this.remotes.setStunned(playerId, until, durationMs)
        }
      }),
      net.on('attackHit', (attackerId, victimId, dropped) => {
        // Redundant hit FX if stun packet arrives late/out of order
        if (victimId === TRAINING_DUMMY_ID) {
          const pos = this.playerCtrl.getPosition()
          this.trainingDummy?.playHit(1500, pos.x, pos.z)
        }
        if (attackerId === net.playerId) {
          const who =
            victimId === TRAINING_DUMMY_ID ? '木头人' : '对方'
          this.onPickupFeedback({
            type: 'toast',
            text: `击中${who}！掉落 ${dropped} 张 · 狼牙棒已消耗`,
            kind: 'ok',
          })
        } else {
          this.remotes.playSwing(attackerId)
        }
      }),
      net.on('attackMiss', () => {
        this.onPickupFeedback({
          type: 'toast',
          text: '未命中（道具保留）',
          kind: 'bad',
        })
      }),
      net.on('playerItem', (playerId, item) => {
        if (playerId === net.playerId) return
        this.remotes.setPlayerItem(playerId, item)
      }),
      net.on('status', (status) => {
        if (status === 'disconnected' || status === 'error') {
          this.matchLive = false
          this.remotes.clear()
          this.removeTrainingDummy()
          this.homeByPlayer.clear()
          if (this.cardSystem.isOnline()) {
            this.cardSystem.enterOfflineMode()
            this.cardSystem.setHomeIndex(homeConfig.defaultSlot)
            this.playerCtrl.player.setHeldStack([])
            this.homeYard.clearAllPiles()
            this.applyOfflineHomeLabels()
            this.teleportLocalToHome()
          }
          this.onScores?.([])
        }
      }),
    )
  }

  private beginMatch(
    ground: { card: UnoCardData; x: number; y: number; z: number }[],
    stack: UnoCardData[],
    score: number,
    scores: { id: string; name?: string; score: number; stackCount: number }[],
    teleportHome: boolean,
    item: UnoCardData | null = null,
  ): void {
    this.matchLive = true
    if (!this.cardSystem.isOnline()) this.cardSystem.enterOnlineMode()
    if (teleportHome) this.teleportLocalToHome()
    this.cardSystem.applyGroundSnapshot(ground)
    this.applyLocalInventory(stack, score, item)
    this.onScores?.(scores)
    this.spawnTrainingDummy()
  }

  private spawnTrainingDummy(): void {
    this.removeTrainingDummy()
    this.trainingDummy = new TrainingDummy()
    this.scene.add(this.trainingDummy.root)
    if (this.pendingDummyStack) {
      this.trainingDummy.setStack(this.pendingDummyStack)
      this.pendingDummyStack = null
    }
  }

  private removeTrainingDummy(): void {
    if (!this.trainingDummy) return
    this.scene.remove(this.trainingDummy.root)
    this.trainingDummy.dispose()
    this.trainingDummy = null
  }

  private applyLocalInventory(
    stack: UnoCardData[],
    score: number,
    item: UnoCardData | null,
  ): void {
    this.cardSystem.applyPrivateStack(stack, score, item)
    this.playerCtrl.player.setHeldStack(stack)
    this.playerCtrl.player.setHeldItem(item)
    this.onItem?.(item)
    if (stack.length) {
      const top = stack[stack.length - 1]!
      this.onPickupFeedback({ type: 'picked', card: top, stack })
    } else {
      this.onPickupFeedback({
        type: 'deposited',
        cards: [],
        deliveredTotal: score,
      })
    }
    if (item) {
      this.onPickupFeedback({
        type: 'toast',
        text: '手持眩晕棒 · 左键挥击（不进背包）',
        kind: 'ok',
      })
    }
  }

  private applyRosterHomes(
    players: readonly PublicPlayer[],
    localId: string | null,
  ): void {
    this.homeByPlayer.clear()
    const owners = new Map<string, { homeIndex: number; name: string }>()
    for (const p of players) {
      const hi =
        typeof p.homeIndex === 'number' && Number.isFinite(p.homeIndex)
          ? p.homeIndex
          : 0
      this.homeByPlayer.set(p.id, hi)
      owners.set(p.id, { homeIndex: hi, name: p.name })
    }
    this.finishHomeOwnership(localId, owners)
  }

  /** From match_start.homes — preferred over lobby-only state. */
  private applyHomesList(
    homes: readonly { playerId: string; homeIndex: number }[],
    localId: string | null,
    players: readonly PublicPlayer[],
  ): void {
    this.homeByPlayer.clear()
    const nameById = new Map(players.map((p) => [p.id, p.name] as const))
    const owners = new Map<string, { homeIndex: number; name: string }>()
    for (const h of homes) {
      const hi =
        typeof h.homeIndex === 'number' && Number.isFinite(h.homeIndex)
          ? h.homeIndex
          : 0
      this.homeByPlayer.set(h.playerId, hi)
      owners.set(h.playerId, {
        homeIndex: hi,
        name: nameById.get(h.playerId) ?? h.playerId.slice(0, 6),
      })
    }
    this.finishHomeOwnership(localId, owners)
  }

  private finishHomeOwnership(
    localId: string | null,
    owners: Map<string, { homeIndex: number; name: string }>,
  ): void {
    let localHome: number = homeConfig.defaultSlot
    if (localId && this.homeByPlayer.has(localId)) {
      localHome = this.homeByPlayer.get(localId)!
    }
    this.cardSystem.setHomeIndex(localHome)
    this.homeYard.applyOwnership({
      localHomeIndex: localHome,
      owners,
      localPlayerId: localId,
    })
  }

  private applyOfflineHomeLabels(): void {
    this.homeYard.applyOwnership({
      localHomeIndex: homeConfig.defaultSlot,
      owners: new Map(),
      localPlayerId: null,
    })
  }

  private teleportLocalToHome(): void {
    const slot = this.cardSystem?.getHomeIndex?.() ?? homeConfig.defaultSlot
    const sp = getHomeSlot(slot).spawn
    this.playerCtrl.teleport(sp.x, sp.y, sp.z, 0)
    this.cameraFollow.snapTo(this.playerCtrl.getPosition())
  }

  private detachNet(): void {
    for (const u of this.unsubs) u()
    this.unsubs = []
    this.net = null
    this.matchLive = false
    this.remotes.clear()
    this.removeTrainingDummy()
    this.homeByPlayer.clear()
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

    this.homeYard = new HomeYard()
    this.scene.add(this.homeYard.group)
    this.applyOfflineHomeLabels()

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
      (cards) => this.homeYard.depositTo(this.cardSystem.getHomeIndex(), cards),
    )
    this.scene.add(this.cardSystem.group)
    this.scene.add(this.remotes.group)

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
    this.detachNet()
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('pointerlockchange', this.handlePointerLock)
    this.input.dispose()
    this.cardSystem?.dispose()
    this.homeYard?.dispose()
    this.remotes.dispose()
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
    this.remotes.update(dt)
    this.trainingDummy?.update(dt)

    if (this.net?.isPlaying) {
      this.net.tickPose(dt, {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw: this.playerCtrl.getYaw(),
      })
      if (this.input.consumeAttack() && !this.playerCtrl.isStunned()) {
        const held = this.playerCtrl.player.getHeldItem()
        if (!held) {
          this.onPickupFeedback({
            type: 'toast',
            text: '没有狼牙棒，先去场上捡',
            kind: 'bad',
          })
        } else {
          // Local swing FX immediately; server resolves hit
          this.playerCtrl.player.playSwing()
          this.net.attack(this.playerCtrl.getYaw())
        }
      }
    }

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
