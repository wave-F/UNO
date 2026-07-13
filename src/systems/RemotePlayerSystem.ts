import * as THREE from 'three'
import { TRAINING_DUMMY_ID } from '../../shared/config/dummy'
import { getHomeSlot } from '../../shared/config/home'
import type { PlayerPose, PublicPlayer } from '../../shared/protocol'
import type { UnoCardData } from '../../shared/uno/types'
import { movementConfig as cfg } from '../config/movement'
import { RemotePlayer } from '../entities/RemotePlayer'

/** Standing height on home platform (matches server bot approx). */
const REMOTE_HOME_STAND_Y = cfg.capsuleHalfHeight + cfg.capsuleRadius + 0.25

/** Manages remote avatars from room_state + world_state. */
export class RemotePlayerSystem {
  readonly group = new THREE.Group()
  private remotes = new Map<string, RemotePlayer>()
  private names = new Map<string, string>()
  private homeById = new Map<string, number>()
  /** Last known backpack per player (applied when remote mesh is created). */
  private stacks = new Map<string, UnoCardData[]>()
  private items = new Map<string, UnoCardData>()
  private localId: string | null = null
  private colorSeq = 0

  constructor() {
    this.group.name = 'RemotePlayers'
  }

  setLocalPlayerId(id: string | null): void {
    this.localId = id
    // Ensure we never show ourselves as remote
    if (id && this.remotes.has(id)) {
      this.remove(id)
    }
  }

  /** Sync presence from room player list. */
  syncRoster(players: readonly PublicPlayer[]): void {
    const alive = new Set<string>()
    for (const p of players) {
      if (p.id === this.localId) continue
      alive.add(p.id)
      this.names.set(p.id, p.name)
      if (typeof p.homeIndex === 'number') {
        this.homeById.set(p.id, p.homeIndex)
      }
      if (!this.remotes.has(p.id) && p.connected) {
        this.add(p.id, p.name, p.homeIndex)
      }
      // Keep mesh while reconnecting grace (still in list)
      if (!p.connected && this.remotes.has(p.id)) {
        // Dim could go here; for now keep last pose
      }
    }
    for (const id of [...this.remotes.keys()]) {
      if (!alive.has(id)) this.remove(id)
    }
  }

  applyWorldState(poses: readonly PlayerPose[]): void {
    for (const pose of poses) {
      if (pose.id === this.localId) continue
      if (pose.id === TRAINING_DUMMY_ID) continue
      let remote = this.remotes.get(pose.id)
      if (!remote) {
        const name = this.names.get(pose.id) ?? pose.id.slice(0, 6)
        remote = this.add(pose.id, name, this.homeById.get(pose.id))
      }
      remote.pushPose(pose.x, pose.y, pose.z, pose.yaw)
    }
  }

  /** Authoritative backpack for a player (local id ignored — local uses private_state). */
  setPlayerStack(playerId: string, stack: readonly UnoCardData[]): void {
    if (playerId === TRAINING_DUMMY_ID) return
    const copy = [...stack]
    this.stacks.set(playerId, copy)
    if (playerId === this.localId) return
    const remote = this.remotes.get(playerId)
    if (remote) remote.player.setHeldStack(copy)
  }

  /** Full snapshot (welcome reconnect / match start). */
  applyPlayerStacks(
    entries: readonly { playerId: string; stack: readonly UnoCardData[] }[],
  ): void {
    for (const e of entries) {
      this.setPlayerStack(e.playerId, e.stack)
    }
  }

  clearAllStacks(): void {
    this.stacks.clear()
    this.items.clear()
    for (const r of this.remotes.values()) {
      r.player.setHeldStack([])
      r.player.setHeldItem(null)
    }
  }

  setPlayerItem(playerId: string, item: UnoCardData | null): void {
    if (item) this.items.set(playerId, item)
    else this.items.delete(playerId)
    if (playerId === this.localId) return
    const remote = this.remotes.get(playerId)
    if (remote) remote.player.setHeldItem(item)
  }

  playSwing(playerId: string): void {
    if (playerId === this.localId) return
    this.remotes.get(playerId)?.player.playSwing()
  }

  setStunned(playerId: string, untilMs: number, durationMs = 1500): void {
    if (playerId === this.localId) return
    if (playerId === TRAINING_DUMMY_ID) return
    this.remotes.get(playerId)?.player.setStunnedUntil(untilMs, durationMs)
  }

  playKnockback(
    playerId: string,
    knock: {
      fromX: number
      fromY: number
      fromZ: number
      toX: number
      toY: number
      toZ: number
      durationMs: number
    },
  ): void {
    if (playerId === this.localId) return
    if (playerId === TRAINING_DUMMY_ID) return
    this.remotes
      .get(playerId)
      ?.playKnockback(
        knock.fromX,
        knock.fromY,
        knock.fromZ,
        knock.toX,
        knock.toZ,
        knock.durationMs,
      )
  }

  playSlide(
    playerId: string,
    info: {
      fromX: number
      fromY: number
      fromZ: number
      toX: number
      toY: number
      toZ: number
      durationMs: number
      recoverMs: number
    },
  ): void {
    if (playerId === this.localId) return
    if (playerId === TRAINING_DUMMY_ID) return
    this.remotes
      .get(playerId)
      ?.playSlide(
        info.fromX,
        info.fromY,
        info.fromZ,
        info.toX,
        info.toZ,
        info.durationMs,
        info.recoverMs,
      )
  }

  flashSlideRange(playerId: string, dist: number): void {
    if (playerId === this.localId) return
    this.remotes.get(playerId)?.player.flashSlideRange(dist)
  }

  update(dt: number): void {
    for (const r of this.remotes.values()) r.update(dt)
  }

  clear(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id)
    this.names.clear()
    this.homeById.clear()
    this.stacks.clear()
    this.items.clear()
    this.localId = null
  }

  dispose(): void {
    this.clear()
  }

  private add(id: string, name: string, homeIndex?: number): RemotePlayer {
    const remote = new RemotePlayer(id, name, this.colorSeq++)
    this.remotes.set(id, remote)
    this.group.add(remote.root)
    // Lobby / before first world_state: sit at corner home, not world origin
    const slot =
      typeof homeIndex === 'number' ? homeIndex : this.homeById.get(id)
    if (typeof slot === 'number') {
      const sp = getHomeSlot(slot).spawn
      remote.pushPose(sp.x, REMOTE_HOME_STAND_Y, sp.z, 0)
    }
    const held = this.stacks.get(id)
    if (held?.length) remote.player.setHeldStack(held)
    const item = this.items.get(id)
    if (item) remote.player.setHeldItem(item)
    return remote
  }

  private remove(id: string): void {
    const r = this.remotes.get(id)
    if (!r) return
    this.group.remove(r.root)
    r.dispose()
    this.remotes.delete(id)
    this.homeById.delete(id)
    this.stacks.delete(id)
    this.items.delete(id)
  }
}
