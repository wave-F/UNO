import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import {
  getHomeSlot,
  homeConfig,
  HOME_FENCE_DEATH_MS,
  isInsideHomeSlot,
} from '../config/home'
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
import { SkipTrapSystem } from '../systems/SkipTrapSystem'
import { TRAINING_DUMMY_ID } from '../../shared/config/dummy'
import {
  MATCH_DURATION_MS,
  MATCH_UNO_REMAINING,
  MATCH_WIN_SCORE,
} from '../../shared/config/match'
import type { PublicPlayer } from '../../shared/protocol'
import {
  isSkipTrap,
  SLIDE_BASE_DIST,
  SLIDE_COOLDOWN_MS,
  SLIDE_DIST_MIN_MULT,
  SLIDE_DIST_PENALTY_PER_CARD,
  SLIDE_DURATION_MS,
  SLIDE_HIT_RADIUS,
  SLIDE_RECOVER_MS,
  STUN_DURATION_MS,
  randomSlideDropCount,
  type UnoCardData,
} from '../game/uno/types'
import type { OfflineBotHitPlayer } from '../systems/OfflineBotSystem'
import { TrainingDummy } from '../entities/TrainingDummy'
import { WorldSlideCorridor } from '../entities/SlideRangeVisual'
import { ElectrocuteFx } from '../entities/ElectrocuteFx'
import { OfflineBotSystem } from '../systems/OfflineBotSystem'

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
  private trapSystem: SkipTrapSystem | null = null
  private trainingDummy: TrainingDummy | null = null
  private pendingDummyStack: UnoCardData[] | null = null
  private slideCorridor: WorldSlideCorridor | null = null
  private zapFx: ElectrocuteFx[] = []
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
    // No distance fog: even mild fog made far field look like solid sky while HUD stayed up.
    this.scene.fog = null
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

  private onUnoMoment:
    | ((info: {
        playerId: string
        playerName: string
        score: number
        remaining: number
        winScore: number
        message: string
      }) => void)
    | null = null

  setUnoMomentListener(
    cb: (info: {
      playerId: string
      playerName: string
      score: number
      remaining: number
      winScore: number
      message: string
    }) => void,
  ): void {
    this.onUnoMoment = cb
  }

  private onSlideCd: (() => void) | null = null

  setSlideCdListener(cb: () => void): void {
    this.onSlideCd = cb
  }

  private onDeath:
    | ((info: { until: number; durationMs: number } | null) => void)
    | null = null

  setDeathListener(
    cb: (info: { until: number; durationMs: number } | null) => void,
  ): void {
    this.onDeath = cb
  }

  private matchLive = false
  /** Solo offline match (local cards + client bots, no WebSocket). */
  private offlineSolo = false
  private offlineBots = new OfflineBotSystem()
  private offlineLocalId = 'local_player'
  private offlineLocalName = '你'
  private offlineEndsAt = 0
  private offlineEnding = false
  private offlineUnoAnnounced = new Set<string>()
  private offlineLastSlideAt = 0
  private offlineWasDead = false
  /** Skip fence checks for a few frames after offline respawn (teleport settle). */
  private offlineFenceGraceUntil = 0

  /**
   * Single-player setup: local field + bots standing at homes.
   * Match timer / AI do not run until {@link beginOfflineMatch}.
   */
  startOfflineSolo(playerName = '你', botCount = 3): void {
    if (this.net?.isPlaying) return
    // Always full reset (also clears frozen post-match state)
    this.endOfflineSolo()
    this.offlineSolo = true
    this.offlineEnding = false
    this.offlineUnoAnnounced.clear()
    this.offlineLastSlideAt = 0
    this.offlineWasDead = false
    this.offlineFenceGraceUntil = 0
    this.offlineScoresKey = ''
    this.offlineLocalName = (playerName || '你').trim().slice(0, 16) || '你'
    // Paused until how-to panel dismisses
    this.matchLive = false
    this.offlineEndsAt = 0

    this.trapSystem?.clear()
    this.applyDummyActive(false)
    this.remotes.clear()
    this.remotes.setLocalPlayerId(this.offlineLocalId)
    this.homeYard.clearAllPiles()
    this.cardSystem.enterOfflineMode()
    this.cardSystem.setHomeIndex(homeConfig.defaultSlot)
    this.cardSystem.setOfflineHomeYard(this.homeYard)
    // Block pick/deposit until match actually starts
    this.cardSystem.setInteractBlocked(true)
    this.playerCtrl.player.setHeldStack([])
    this.playerCtrl.player.setHeldItem(null)
    this.playerCtrl.clearDeath()
    this.onDeath?.(null)
    this.onItem?.(null)
    this.onMatchClock?.(null, MATCH_WIN_SCORE)

    const owners = new Map<string, { homeIndex: number; name: string }>()
    owners.set(this.offlineLocalId, {
      homeIndex: homeConfig.defaultSlot,
      name: this.offlineLocalName,
    })
    // Bots will use homes 1–3
    const cornerNames = ['东南', '西北', '东北'] as const
    for (let i = 0; i < Math.min(3, botCount); i++) {
      owners.set(`offline_bot_${i + 1}`, {
        homeIndex: i + 1,
        name: cornerNames[i] ?? `Bot${i + 1}`,
      })
    }
    this.homeByPlayer.clear()
    for (const [id, o] of owners) this.homeByPlayer.set(id, o.homeIndex)
    this.clearAllUnoAlerts()
    this.homeYard.applyOwnership({
      localHomeIndex: homeConfig.defaultSlot,
      owners,
      localPlayerId: this.offlineLocalId,
    })
    this.teleportLocalToHome()

    this.offlineBots.start(botCount, this.cardSystem, this.homeYard, this.remotes, {
      onHitPlayer: (hit) => this.applyOfflinePlayerSlideHit(hit),
      onLocalHomeStolen: () => {
        this.cardSystem.setDeliveredTotal(
          this.homeYard.getCount(homeConfig.defaultSlot),
        )
        this.pushOfflineScores()
        this.onPickupFeedback({
          type: 'toast',
          text: '老家被偷了一张！',
          kind: 'bad',
        })
      },
    })
    this.pushOfflineScores()
  }

  /**
   * After how-to panel: start 2 min clock, enable AI / pickups / slide.
   */
  beginOfflineMatch(): void {
    if (!this.offlineSolo || this.offlineEnding || this.matchLive) return
    this.matchLive = true
    this.cardSystem.setInteractBlocked(false)
    this.offlineEndsAt = Date.now() + MATCH_DURATION_MS
    this.onMatchClock?.(this.offlineEndsAt, MATCH_WIN_SCORE)
    this.pushOfflineScores()
    this.onPickupFeedback({
      type: 'toast',
      text: `开始！你 vs 机器人 · 先送达 ${MATCH_WIN_SCORE} 张或 2 分钟比谁多`,
      kind: 'ok',
    })
  }

  isOfflineSolo(): boolean {
    return this.offlineSolo
  }

  private offlineScoresKey = ''

  private pushOfflineScores(): void {
    if (!this.offlineSolo) return
    const scores = this.offlineBots.getScores(
      this.offlineLocalId,
      this.offlineLocalName,
      this.cardSystem.getDeliveredTotal(),
      this.cardSystem.getStack().length,
    )
    // Avoid rewriting HUD DOM every frame (was ~60×/s for entire match)
    const key = scores.map((s) => `${s.id}:${s.score}:${s.stackCount}`).join(';')
    if (key === this.offlineScoresKey) return
    this.offlineScoresKey = key
    this.onScores?.(scores)
  }

  private maybeOfflineUno(playerId: string, name: string, score: number): void {
    if (!this.offlineSolo || this.offlineEnding) return
    if (this.offlineUnoAnnounced.has(playerId)) return
    const remaining = MATCH_WIN_SCORE - score
    if (remaining <= 0 || remaining > MATCH_UNO_REMAINING) return
    this.offlineUnoAnnounced.add(playerId)
    this.fireUnoMoment({
      playerId,
      playerName: name,
      score,
      remaining,
      winScore: MATCH_WIN_SCORE,
      message: `${name}玩家还差${remaining}张牌就获得胜利，UNO时刻！`,
    })
  }

  /** Home UNO + head UNO + HUD banner. */
  private fireUnoMoment(info: {
    playerId: string
    playerName: string
    score: number
    remaining: number
    winScore: number
    message: string
  }): void {
    const slot = this.homeByPlayer.get(info.playerId)
    if (typeof slot === 'number') {
      this.homeYard?.setUnoAlert(slot, true)
    }
    const isLocal =
      info.playerId === this.offlineLocalId ||
      (!!this.net?.playerId && info.playerId === this.net.playerId)
    if (isLocal) {
      this.playerCtrl?.player.setUnoAlert(true)
    } else {
      this.remotes.setUnoAlert(info.playerId, true)
    }
    this.onUnoMoment?.(info)
  }

  private clearAllUnoAlerts(): void {
    this.homeYard?.clearUnoAlerts()
    this.remotes.clearAllUnoAlerts()
    this.playerCtrl?.player.setUnoAlert(false)
  }

  private checkOfflineWin(): void {
    if (!this.offlineSolo || this.offlineEnding || !this.matchLive) return
    const localScore = this.cardSystem.getDeliveredTotal()
    if (localScore >= MATCH_WIN_SCORE) {
      this.finishOfflineMatch('score', this.offlineLocalId)
      return
    }
    const botWin = this.offlineBots.anyReached(MATCH_WIN_SCORE)
    if (botWin) {
      this.finishOfflineMatch('score', botWin.id)
      return
    }
    if (this.offlineEndsAt > 0 && Date.now() >= this.offlineEndsAt) {
      this.finishOfflineMatch('timeout', null)
    }
  }

  private finishOfflineMatch(
    reason: 'score' | 'timeout',
    winnerId: string | null,
  ): void {
    if (!this.offlineSolo || this.offlineEnding) return
    this.offlineEnding = true
    this.matchLive = false

    const scores = this.offlineBots.getScores(
      this.offlineLocalId,
      this.offlineLocalName,
      this.cardSystem.getDeliveredTotal(),
      this.cardSystem.getStack().length,
    )
    let winners = scores.filter((s) => s.id === winnerId)
    if (reason === 'timeout' || !winners.length) {
      const best = Math.max(0, ...scores.map((s) => s.score))
      winners = scores.filter((s) => s.score === best)
    }
    const names = winners.map((w) => w.name || w.id).join('、')
    const message =
      reason === 'score'
        ? winners.length > 1
          ? `率先送达 ${MATCH_WIN_SCORE} 张！并列：${names}`
          : `${names} 率先送达 ${MATCH_WIN_SCORE} 张，获胜！`
        : winners.length
          ? `时间到！${names} 收集最多（${winners[0]!.score} 张）`
          : '时间到！无人得分'

    // Freeze play: remove bots, block interact, keep field as-is under result UI
    this.offlineBots.clear()
    this.remotes.clear()
    this.clearAllUnoAlerts()
    this.cardSystem.setInteractBlocked(true)
    this.cardSystem.setOfflineHomeYard(null)
    this.onDeath?.(null)
    this.playerCtrl.clearDeath()
    this.playerCtrl.player.setHeldStack([])
    this.onItem?.(null)
    this.onMatchClock?.(null, MATCH_WIN_SCORE)
    this.onScores?.(scores)

    // Unlock mouse so settlement / lobby buttons receive clicks
    try {
      document.exitPointerLock()
    } catch {
      /* ignore */
    }

    this.onMatchEnd?.({
      reason,
      winners,
      scores,
      winScore: MATCH_WIN_SCORE,
      message,
    })
    // Full field reset happens in cleanupAfterOfflineMatch() when user dismisses UI
  }

  /**
   * After settlement dialog dismissed — reset field and return to idle/lobby state.
   */
  cleanupAfterOfflineMatch(): void {
    this.endOfflineSolo()
  }

  /** Stop offline solo and reset field for lobby / next match. */
  private endOfflineSolo(): void {
    this.offlineBots.clear()
    this.offlineSolo = false
    this.matchLive = false
    this.offlineEndsAt = 0
    this.offlineEnding = false
    this.offlineWasDead = false
    this.offlineFenceGraceUntil = 0
    this.offlineUnoAnnounced.clear()
    this.offlineLastSlideAt = 0
    this.offlineScoresKey = ''
    this.remotes.clear()
    this.applyDummyActive(false)
    this.onDeath?.(null)
    this.playerCtrl?.clearDeath()
    if (this.cardSystem) {
      this.cardSystem.setOfflineHomeYard(null)
      this.cardSystem.setInteractBlocked(false)
      this.cardSystem.enterOfflineMode()
      this.cardSystem.setHomeIndex(homeConfig.defaultSlot)
      this.homeYard.clearAllPiles()
      this.clearAllUnoAlerts()
      this.applyOfflineHomeLabels()
      this.playerCtrl.player.setHeldStack([])
      this.playerCtrl.player.setHeldItem(null)
      this.teleportLocalToHome()
    }
    this.onMatchClock?.(null, MATCH_WIN_SCORE)
    this.onScores?.([])
  }

  /** Bot slide hit local player: knock + random 1–4 drop + stun. */
  private applyOfflinePlayerSlideHit(hit: OfflineBotHitPlayer): void {
    if (!this.offlineSolo || this.playerCtrl.isDead()) return
    const n = randomSlideDropCount(this.cardSystem.getStack().length)
    const dropped = this.dropLocalStackBurst(hit.fromX, hit.fromZ, n)
    this.playerCtrl.playKnockback(hit.toX, hit.toZ, hit.durationMs)
    this.playerCtrl.setStunUntil(Date.now() + STUN_DURATION_MS)
    this.playerCtrl.player.setStunnedUntil(
      Date.now() + STUN_DURATION_MS,
      STUN_DURATION_MS,
    )
    this.onPickupFeedback({
      type: 'toast',
      text:
        dropped > 0
          ? `被铲中！掉 ${dropped} 张 · 眩晕 ${(STUN_DURATION_MS / 1000).toFixed(1)}s`
          : `被铲中！眩晕 ${(STUN_DURATION_MS / 1000).toFixed(1)}s`,
      kind: 'bad',
    })
    this.pushOfflineScores()
  }

  /**
   * Burst-drop local backpack cards onto field.
   * @param max if set, only top N cards (slide/mace); omit = all (fence death)
   */
  private dropLocalStackBurst(
    x: number,
    z: number,
    max?: number,
  ): number {
    const cards =
      max == null
        ? this.cardSystem.takeAllStack()
        : this.cardSystem.takeTopFromStack(max)
    this.playerCtrl.player.setHeldStack([...this.cardSystem.getStack()])
    if (!cards.length) return 0
    const drops = cards.map((card, i) => {
      const ang = (i / Math.max(1, cards.length)) * Math.PI * 2 + 0.2
      const rad = 0.75 + (i % 3) * 0.3
      return {
        card,
        x: x + Math.cos(ang) * rad,
        y: 0.55,
        z: z + Math.sin(ang) * rad,
      }
    })
    this.cardSystem.spawnDropped(drops, { x, y: 1.0, z })
    return cards.length
  }

  private spawnZapFx(x: number, y: number, z: number): void {
    const fx = new ElectrocuteFx(x, y, z)
    this.scene.add(fx.root)
    this.zapFx.push(fx)
  }

  private updateZapFx(dt: number): void {
    for (let i = this.zapFx.length - 1; i >= 0; i--) {
      const fx = this.zapFx[i]!
      if (fx.update(dt)) {
        this.scene.remove(fx.root)
        fx.dispose()
        this.zapFx.splice(i, 1)
      }
    }
  }

  /** Local player steps into active foreign fence. */
  private electrocuteLocalOffline(fenceSlot: number): void {
    if (!this.offlineSolo || this.offlineEnding || !this.matchLive) return
    if (this.playerCtrl.isDead()) return
    if (Date.now() < this.offlineFenceGraceUntil) return
    const pos = this.playerCtrl.getPosition()
    // Fence death: drop entire backpack, play zap, vanish (no 5s stand-still)
    this.dropLocalStackBurst(pos.x, pos.z)
    this.spawnZapFx(pos.x, pos.y, pos.z)
    this.playerCtrl.player.setAvatarVisible(false)
    const until = Date.now() + HOME_FENCE_DEATH_MS
    this.playerCtrl.setDeathUntil(until)
    this.offlineWasDead = true
    this.onDeath?.({ until, durationMs: HOME_FENCE_DEATH_MS })
    const corner = ['西南', '东南', '西北', '东北'][fenceSlot] ?? `${fenceSlot}`
    this.onPickupFeedback({
      type: 'toast',
      text: `触电消失！${corner}电网 · ${HOME_FENCE_DEATH_MS / 1000}s 后自家重生`,
      kind: 'bad',
    })
    this.pushOfflineScores()
  }

  /**
   * When death timer ends: show avatar, teleport home, short fence grace.
   */
  private processOfflineLocalRespawn(): boolean {
    if (!this.offlineSolo) return false
    if (this.playerCtrl.isDead()) {
      this.offlineWasDead = true
      // Stay invisible while dead
      this.playerCtrl.player.setAvatarVisible(false)
      return false
    }
    if (!this.offlineWasDead) return false
    this.offlineWasDead = false
    this.playerCtrl.clearDeath()
    this.playerCtrl.player.setAvatarVisible(true)
    this.onDeath?.(null)
    this.teleportLocalToHome()
    this.offlineFenceGraceUntil = Date.now() + 400
    this.cameraFollow.snapTo(this.playerCtrl.getPosition())
    this.onPickupFeedback({
      type: 'toast',
      text: '已在自家重生',
      kind: 'ok',
    })
    return true
  }

  /** Wire LAN client (optional). Offline still works without this. */
  attachNet(net: NetClient): void {
    this.detachNet()
    this.net = net
    this.unsubs.push(
      net.on('welcome', (info) => {
        this.remotes.setLocalPlayerId(info.playerId)
        this.trapSystem?.setLocalPlayerId(info.playerId)
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
          this.trapSystem?.setFromSnapshot(info.traps ?? [])
          this.onMatchClock?.(info.matchEndsAt ?? null, info.winScore ?? MATCH_WIN_SCORE)
          if (info.dummyActive) {
            const dummyStack = (info.playerStacks ?? []).find(
              (e) => e.playerId === TRAINING_DUMMY_ID,
            )
            if (dummyStack) this.pendingDummyStack = [...dummyStack.stack]
          }
          this.applyDummyActive(!!info.dummyActive)
          this.onDummyState?.(!!info.dummyActive)
        } else {
          this.matchLive = false
          this.applyDummyActive(false)
          this.trapSystem?.clear()
          this.onMatchClock?.(null, 20)
          // Lobby: still stand at your corner
          this.teleportLocalToHome()
        }
      }),
      net.on('roomState', (info) => {
        if (net.playerId) {
          this.remotes.setLocalPlayerId(net.playerId)
          this.trapSystem?.setLocalPlayerId(net.playerId)
        }
        this.remotes.syncRoster(info.players)
        this.applyRosterHomes(info.players, net.playerId)
        if (info.phase === 'lobby' && this.matchLive) {
          // Match ended elsewhere / returned to lobby
          this.matchLive = false
          this.applyDummyActive(false)
          this.trapSystem?.clear()
          this.onMatchClock?.(null, 20)
        }
      }),
      net.on('matchStart', (ground, scores, homes, meta) => {
        this.remotes.clearAllStacks()
        this.homeYard.clearAllPiles()
        this.trapSystem?.clear()
        // Authoritative homes from match_start (do not trust only lobby roster)
        if (homes.length) {
          this.applyHomesList(homes, net.playerId, net.players)
        } else if (net.players.length) {
          this.applyRosterHomes(net.players, net.playerId)
        }
        this.beginMatch(ground, [], 0, scores, true, null)
        this.homeYard.setActiveFences([])
        this.playerCtrl.clearDeath()
        this.onDeath?.(null)
        this.onMatchClock?.(meta.endsAt, meta.winScore)
        this.applyDummyActive(false)
      }),
      net.on('dummyState', (active) => {
        if (!this.matchLive && active) return
        this.applyDummyActive(active)
        this.onDummyState?.(active)
      }),
      net.on('unoMoment', (info) => {
        if (!this.matchLive) return
        this.fireUnoMoment(info)
      }),
      net.on('matchEnd', (info) => {
        this.matchLive = false
        this.applyDummyActive(false)
        this.trapSystem?.clear()
        this.remotes.clearAllStacks()
        this.homeYard.clearAllPiles()
        this.clearAllUnoAlerts()
        this.homeYard.setActiveFences([])
        this.cardSystem.enterOnlineMode()
        this.playerCtrl.player.setHeldStack([])
        this.playerCtrl.player.setHeldItem(null)
        this.playerCtrl.clearDeath()
        this.onDeath?.(null)
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
      net.on('playerSlide', (info) => {
        if (!this.matchLive) return
        // World-fixed corridor = exact server segment (does not spin with body lean)
        this.slideCorridor?.show(
          info.fromX,
          info.fromZ,
          info.toX,
          info.toZ,
          info.durationMs + info.recoverMs,
        )
        // Hide local idle preview while sliding
        if (info.playerId === net.playerId) {
          this.playerCtrl.player.slideRange.setIdlePreview(false)
          this.playerCtrl.playSlide(
            info.toX,
            info.toZ,
            info.durationMs,
            info.recoverMs,
          )
          this.onSlideCd?.()
        } else {
          this.remotes.playSlide(info.playerId, info)
        }
      }),
      net.on('attackHit', (attackerId, victimId, dropped, knock) => {
        // Knock arc + card burst (cards come via cards_spawned with burstFrom)
        if (knock) {
          if (victimId === TRAINING_DUMMY_ID) {
            this.trainingDummy?.playHit(knock.durationMs, knock.fromX, knock.fromZ)
            this.trainingDummy?.playKnockback(
              knock.fromX,
              knock.fromZ,
              knock.toX,
              knock.toZ,
              knock.durationMs,
            )
          } else if (victimId === net.playerId) {
            this.playerCtrl.playKnockback(knock.toX, knock.toZ, knock.durationMs)
          } else {
            this.remotes.playKnockback(victimId, knock)
          }
        } else if (victimId === TRAINING_DUMMY_ID) {
          const pos = this.playerCtrl.getPosition()
          this.trainingDummy?.playHit(1500, pos.x, pos.z)
        }
        if (attackerId === net.playerId) {
          const who =
            victimId === TRAINING_DUMMY_ID ? '木头人' : '对方'
          this.onPickupFeedback({
            type: 'toast',
            text: `击中${who}！击飞并掉落 ${dropped} 张 · 狼牙棒已消耗`,
            kind: 'ok',
          })
        } else if (attackerId !== net.playerId) {
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
      net.on('trapPlaced', (trap) => {
        if (!this.matchLive) return
        this.trapSystem?.add(trap)
        if (trap.ownerId === net.playerId) {
          this.onPickupFeedback({
            type: 'toast',
            text: '已布置 Skip 陷阱（自己不会踩中）',
            kind: 'ok',
          })
        }
      }),
      net.on('trapRemoved', (trapId) => {
        this.trapSystem?.remove(trapId)
      }),
      net.on('trapTriggered', (info) => {
        if (!this.matchLive) return
        if (info.victimId === net.playerId) {
          this.onPickupFeedback({
            type: 'toast',
            text: '踩中 Skip 陷阱！眩晕 2 秒',
            kind: 'bad',
          })
        } else if (info.ownerId === net.playerId) {
          this.onPickupFeedback({
            type: 'toast',
            text: '有人踩中了你的 Skip 陷阱！',
            kind: 'ok',
          })
        }
      }),
      net.on('playerItem', (playerId, item) => {
        if (playerId === net.playerId) return
        this.remotes.setPlayerItem(playerId, item)
      }),
      net.on('homeFences', (active) => {
        if (!this.matchLive) return
        this.homeYard.setActiveFences(active)
      }),
      net.on('playerDied', (info) => {
        if (!this.matchLive) return
        const pos = this.playerCtrl.getPosition()
        if (info.playerId === net.playerId) {
          this.spawnZapFx(pos.x, pos.y, pos.z)
          this.playerCtrl.player.setAvatarVisible(false)
          this.playerCtrl.setDeathUntil(info.until)
          this.playerCtrl.player.setHeldStack([])
          this.playerCtrl.player.setHeldItem(null)
          this.onItem?.(null)
          this.onDeath?.({ until: info.until, durationMs: info.durationMs })
          this.onPickupFeedback({
            type: 'toast',
            text: '触电消失！稍后在自家重生',
            kind: 'bad',
          })
        } else {
          this.remotes.setVisible(info.playerId, false)
          this.onPickupFeedback({
            type: 'toast',
            text: '有人被老家电网电死了',
            kind: 'ok',
          })
        }
      }),
      net.on('playerRespawned', (info) => {
        if (!this.matchLive) return
        if (info.playerId === net.playerId) {
          this.playerCtrl.clearDeath()
          this.playerCtrl.player.setAvatarVisible(true)
          this.playerCtrl.teleport(info.x, info.y, info.z, 0)
          this.cameraFollow.snapTo(this.playerCtrl.getPosition())
          this.onDeath?.(null)
          this.onPickupFeedback({
            type: 'toast',
            text: '已在自家重生',
            kind: 'ok',
          })
        } else {
          this.remotes.setVisible(info.playerId, true)
        }
        // Remotes snap via next world_state poses
      }),
      net.on('status', (status) => {
        if (status === 'disconnected' || status === 'error') {
          this.matchLive = false
          this.remotes.clear()
          this.removeTrainingDummy()
          this.trapSystem?.clear()
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
    this.clearAllUnoAlerts()
    if (!this.cardSystem.isOnline()) this.cardSystem.enterOnlineMode()
    if (teleportHome) this.teleportLocalToHome()
    this.cardSystem.applyGroundSnapshot(ground)
    this.applyLocalInventory(stack, score, item)
    this.onScores?.(scores)
    // Dummy only after server dummy_state active
    this.applyDummyActive(false)
  }

  private spawnTrainingDummy(): void {
    this.removeTrainingDummy()
    this.trainingDummy = new TrainingDummy()
    this.trainingDummy.root.visible = true
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
    this.pendingDummyStack = null
  }

  /**
   * Apply authoritative dummy presence (mesh + local flag).
   * Server owns hit target / backpack; inactive means fully gone.
   */
  applyDummyActive(active: boolean): void {
    if (!active) {
      this.removeTrainingDummy()
      return
    }
    if (!this.matchLive) return
    if (!this.trainingDummy) this.spawnTrainingDummy()
    else this.trainingDummy.root.visible = true
  }

  /** Request server spawn/despawn (logic + model for all clients). */
  requestDummyActive(active: boolean): boolean {
    if (!this.matchLive || !this.net?.isPlaying) return false
    this.net.debugSetDummy(active)
    return true
  }

  isDummyVisible(): boolean {
    return !!this.trainingDummy
  }

  private onDummyState: ((active: boolean) => void) | null = null

  setDummyStateListener(cb: (active: boolean) => void): void {
    this.onDummyState = cb
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
      const text = isSkipTrap(item)
        ? '手持 Skip 陷阱 · 左键布置到脚下（不进背包）'
        : '手持眩晕棒 · 左键挥击（不进背包）'
      this.onPickupFeedback({
        type: 'toast',
        text,
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
    // Soft stand height (not fall-in y=2.2) — avoids long drop / void after respawn
    const y = this.playerCtrl.standingBodyY()
    this.playerCtrl.teleport(sp.x, y, sp.z, 0)
    this.cameraFollow.snapTo(this.playerCtrl.getPosition())
  }

  /**
   * If player fell off the map or NaN pose, pull back home.
   * Mid-match "blue screen" is almost always camera following a void fall (sky clear color).
   */
  private rescueLocalIfNeeded(): void {
    if (!this.playerCtrl) return
    const ok = this.playerCtrl.ensureInArena(18.5)
    if (!ok) {
      this.teleportLocalToHome()
      this.onPickupFeedback({
        type: 'toast',
        text: '已拉回场地',
        kind: 'ok',
      })
      return
    }
    const p = this.playerCtrl.getPosition()
    // Extreme fall still possible if ensure only clamps Y once — snap home
    if (p.y < -2 || p.y > 20) {
      this.teleportLocalToHome()
      this.onPickupFeedback({
        type: 'toast',
        text: '已拉回场地',
        kind: 'ok',
      })
    }
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

    this.slideCorridor = new WorldSlideCorridor()
    this.scene.add(this.slideCorridor.root)

    this.cardSystem = new CardPickupSystem(
      (fb) => {
        if (fb.type === 'picked') {
          this.playerCtrl.player.setHeldStack(fb.stack)
        } else if (fb.type === 'deposited') {
          this.playerCtrl.player.setHeldStack([])
          if (this.offlineSolo) {
            this.maybeOfflineUno(
              this.offlineLocalId,
              this.offlineLocalName,
              fb.deliveredTotal,
            )
            this.pushOfflineScores()
            this.checkOfflineWin()
          }
        }
        this.onPickupFeedback(fb)
      },
      (cards) => this.homeYard.depositTo(this.cardSystem.getHomeIndex(), cards),
    )
    this.scene.add(this.cardSystem.group)
    this.scene.add(this.remotes.group)
    this.trapSystem = new SkipTrapSystem(this.scene)

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
    this.trapSystem?.clear()
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
    // After knock / stun / death: keep body in arena
    this.rescueLocalIfNeeded()
    // Slide / knock end: re-pin camera on standing pose
    if (
      this.playerCtrl.consumeSlideJustEnded() ||
      this.playerCtrl.consumeKnockJustEnded()
    ) {
      this.rescueLocalIfNeeded()
      this.cameraFollow.ensurePlayablePitch()
      this.cameraFollow.snapTo(this.playerCtrl.getPosition())
    }
    let pos = this.playerCtrl.getPosition()
    this.cameraFollow.updatePosition(pos, dt)
    // Continuous heal: orbit broken / too far → hard re-seat (mid-match “blue sky”)
    if (this.cameraFollow.healIfBroken(pos)) {
      pos = this.playerCtrl.getPosition()
      this.cameraFollow.snapTo(pos)
    }

    // Respawn even if bots already cleared (e.g. mid death when match freezes)
    if (this.offlineSolo && this.matchLive) {
      const justRespawned = this.processOfflineLocalRespawn()
      if (justRespawned) {
        pos = this.playerCtrl.getPosition()
        this.cameraFollow.snapTo(pos)
      }
    }

    if (this.offlineSolo && this.offlineBots.isActive && this.matchLive) {
      const hi = this.cardSystem.getHomeIndex()
      pos = this.playerCtrl.getPosition()
      const playerSnap = {
        x: pos.x,
        z: pos.z,
        dead: this.playerCtrl.isDead(),
        stunned: this.playerCtrl.isStunned(),
        onOwnHome: isInsideHomeSlot(hi, pos.x, pos.z),
        homeIndex: hi,
        stackCount: this.cardSystem.getStack().length,
      }
      const fences = this.offlineBots.computeOwnerFences(playerSnap)
      this.homeYard.setActiveFences(fences)
      this.cardSystem.setFencedSlots(fences)
      this.offlineBots.setFencedSlots(fences)

      // Step into fenced foreign home → death (skip grace after respawn)
      if (
        !playerSnap.dead &&
        Date.now() >= this.offlineFenceGraceUntil
      ) {
        const slot = this.homeYard.slotAt(pos.x, pos.z)
        if (slot !== null && slot !== hi && fences.includes(slot)) {
          this.electrocuteLocalOffline(slot)
        }
      }

      this.cardSystem.setInteractBlocked(
        this.playerCtrl.isDead() || this.playerCtrl.isStunned(),
      )
      this.cardSystem.update(pos, dt)
      // UNO band: bots raid harder / target threat homes
      {
        const scoreRows = this.offlineBots.getScores(
          this.offlineLocalId,
          this.offlineLocalName,
          this.cardSystem.getDeliveredTotal(),
          this.cardSystem.getStack().length,
        )
        this.offlineBots.setUnoPressureFromScores(
          scoreRows.map((s) => ({
            homeIndex:
              s.id === this.offlineLocalId
                ? homeConfig.defaultSlot
                : (this.homeByPlayer.get(s.id) ?? -1),
            score: s.score,
          })),
        )
      }
      this.offlineBots.tick(dt, {
        ...playerSnap,
        x: this.playerCtrl.getPosition().x,
        z: this.playerCtrl.getPosition().z,
        dead: this.playerCtrl.isDead(),
      })
      for (const z of this.offlineBots.takePendingZaps()) {
        this.spawnZapFx(z.x, z.y, z.z)
      }
      this.pushOfflineScores()
      const botScores = this.offlineBots.getScores(
        this.offlineLocalId,
        this.offlineLocalName,
        this.cardSystem.getDeliveredTotal(),
        this.cardSystem.getStack().length,
      )
      for (const s of botScores) {
        if (s.id.startsWith('offline_bot_')) {
          this.maybeOfflineUno(s.id, s.name || s.id, s.score)
        }
      }
      this.checkOfflineWin()
    } else if (this.offlineSolo && this.offlineBots.isActive && !this.matchLive) {
      // How-to / pre-start: freeze bots & interactions, keep field visible
      this.cardSystem.setInteractBlocked(true)
      this.cardSystem.update(pos, dt)
    } else {
      this.cardSystem.update(pos, dt)
      // Non-match offline / lobby: only own-home fence visual
      if (!this.net?.isPlaying && this.homeYard) {
        const hi = this.cardSystem?.getHomeIndex?.() ?? homeConfig.defaultSlot
        const onHome = isInsideHomeSlot(hi, pos.x, pos.z)
        this.homeYard.setActiveFences(onHome ? [hi] : [])
      }
    }
    this.remotes.update(dt)
    this.trapSystem?.update(dt)
    this.trainingDummy?.update(dt)
    this.slideCorridor?.update(dt)
    this.homeYard?.update(dt)
    this.updateZapFx(dt)

    if (this.net?.isPlaying) {
      this.net.tickPose(dt, {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw: this.playerCtrl.getYaw(),
      })
      if (
        this.input.consumeAttack() &&
        !this.playerCtrl.isStunned() &&
        !this.playerCtrl.isDead()
      ) {
        const held = this.playerCtrl.player.getHeldItem()
        const yaw = this.playerCtrl.getYaw()
        if (held) {
          // Has prop: use item (skip place / legacy mace)
          if (!isSkipTrap(held)) {
            this.playerCtrl.player.playSwing()
          }
          this.net.attack(yaw)
        } else {
          // Empty hand: slide tackle (server is authority)
          this.net.slide(yaw)
        }
      }
      if (
        this.input.consumeDiscardItem() &&
        !this.playerCtrl.isStunned() &&
        !this.playerCtrl.isDead()
      ) {
        const held = this.playerCtrl.player.getHeldItem()
        if (!held) {
          this.onPickupFeedback({
            type: 'toast',
            text: '没有可丢弃的道具',
            kind: 'bad',
          })
        } else {
          this.net.discardItem(this.playerCtrl.getYaw())
          this.onPickupFeedback({
            type: 'toast',
            text: '丢弃道具',
            kind: 'ok',
          })
        }
      }
    } else if (this.offlineSolo && this.matchLive && !this.offlineEnding) {
      // Local solo: slide works without WebSocket
      if (
        this.input.consumeAttack() &&
        !this.playerCtrl.isStunned() &&
        !this.playerCtrl.isDead()
      ) {
        const held = this.playerCtrl.player.getHeldItem()
        if (held) {
          this.onPickupFeedback({
            type: 'toast',
            text: '单机暂无道具攻击，空手左键铲球',
            kind: 'bad',
          })
        } else {
          this.tryOfflineSlide()
        }
      }
    }

    try {
      void this.renderer.render(this.scene, this.camera)
    } catch (err) {
      console.error('[render]', err)
    }
  }

  /** Client-side slide tackle vs offline bots (mirrors server trySlide). */
  private tryOfflineSlide(): void {
    if (!this.offlineSolo || this.offlineEnding) return
    const now = Date.now()
    if (now - this.offlineLastSlideAt < SLIDE_COOLDOWN_MS) {
      this.onPickupFeedback({
        type: 'toast',
        text: '铲球冷却中',
        kind: 'bad',
      })
      return
    }
    if (this.playerCtrl.isStunned() || this.playerCtrl.isDead()) return

    const pos = this.playerCtrl.getPosition()
    const yaw = this.playerCtrl.getYaw()
    const stackLen = this.cardSystem.getStack().length
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    const mult = Math.max(
      SLIDE_DIST_MIN_MULT,
      1 - SLIDE_DIST_PENALTY_PER_CARD * stackLen,
    )
    const dist = SLIDE_BASE_DIST * mult
    const lim = 17
    const toX = Math.max(-lim, Math.min(lim, pos.x + fx * dist))
    const toZ = Math.max(-lim, Math.min(lim, pos.z + fz * dist))

    let bestId: string | null = null
    let bestT = Infinity
    for (const b of this.offlineBots.listPoses()) {
      if (now < b.stunUntil || now < b.deathUntil) continue
      const hit = pointNearSegment(
        b.x,
        b.z,
        pos.x,
        pos.z,
        toX,
        toZ,
        SLIDE_HIT_RADIUS,
      )
      if (!hit) continue
      if (hit.t < bestT) {
        bestT = hit.t
        bestId = b.id
      }
    }

    this.offlineLastSlideAt = now
    this.playerCtrl.playSlide(toX, toZ, SLIDE_DURATION_MS, SLIDE_RECOVER_MS)
    this.slideCorridor?.show(
      pos.x,
      pos.z,
      toX,
      toZ,
      SLIDE_DURATION_MS + SLIDE_RECOVER_MS,
    )
    this.playerCtrl.player.slideRange.setIdlePreview(false)
    this.onSlideCd?.()

    if (bestId) {
      const dropped = this.offlineBots.applyHit(
        bestId,
        fx,
        fz,
        pos.x,
        pos.z,
      )
      this.onPickupFeedback({
        type: 'toast',
        text:
          dropped > 0
            ? `铲中！打落 ${dropped} 张`
            : '铲中！（对方背包为空）',
        kind: 'ok',
      })
      this.pushOfflineScores()
    } else {
      this.onPickupFeedback({
        type: 'toast',
        text: '铲球落空',
        kind: 'bad',
      })
    }
  }

  private onResize = (): void => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera.aspect = w / Math.max(h, 1)
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }
}

/** Point-to-segment hit in XZ (same idea as server GameSim). */
function pointNearSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  radius: number,
): { t: number } | null {
  const abx = bx - ax
  const abz = bz - az
  const len2 = abx * abx + abz * abz
  if (len2 < 1e-8) {
    const d = Math.hypot(px - ax, pz - az)
    return d <= radius ? { t: 0 } : null
  }
  let t = ((px - ax) * abx + (pz - az) * abz) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + abx * t
  const cz = az + abz * t
  const d = Math.hypot(px - cx, pz - cz)
  return d <= radius ? { t } : null
}
