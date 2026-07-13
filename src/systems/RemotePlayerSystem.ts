import * as THREE from 'three'
import type { PlayerPose, PublicPlayer } from '../../shared/protocol'
import type { UnoCardData } from '../../shared/uno/types'
import { RemotePlayer } from '../entities/RemotePlayer'

/** Manages remote avatars from room_state + world_state. */
export class RemotePlayerSystem {
  readonly group = new THREE.Group()
  private remotes = new Map<string, RemotePlayer>()
  private names = new Map<string, string>()
  /** Last known backpack per player (applied when remote mesh is created). */
  private stacks = new Map<string, UnoCardData[]>()
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
      if (!this.remotes.has(p.id) && p.connected) {
        this.add(p.id, p.name)
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
      let remote = this.remotes.get(pose.id)
      if (!remote) {
        const name = this.names.get(pose.id) ?? pose.id.slice(0, 6)
        remote = this.add(pose.id, name)
      }
      remote.pushPose(pose.x, pose.y, pose.z, pose.yaw)
    }
  }

  /** Authoritative backpack for a player (local id ignored — local uses private_state). */
  setPlayerStack(playerId: string, stack: readonly UnoCardData[]): void {
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
    for (const r of this.remotes.values()) {
      r.player.setHeldStack([])
    }
  }

  update(dt: number): void {
    for (const r of this.remotes.values()) r.update(dt)
  }

  clear(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id)
    this.names.clear()
    this.stacks.clear()
    this.localId = null
  }

  dispose(): void {
    this.clear()
  }

  private add(id: string, name: string): RemotePlayer {
    const remote = new RemotePlayer(id, name, this.colorSeq++)
    this.remotes.set(id, remote)
    this.group.add(remote.root)
    const held = this.stacks.get(id)
    if (held?.length) remote.player.setHeldStack(held)
    return remote
  }

  private remove(id: string): void {
    const r = this.remotes.get(id)
    if (!r) return
    this.group.remove(r.root)
    r.dispose()
    this.remotes.delete(id)
    this.stacks.delete(id)
  }
}
