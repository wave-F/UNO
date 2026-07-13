import * as THREE from 'three'
import { SkipTrapMarker } from '../entities/SkipTrapMarker'
import type { PlacedTrapWire } from '../../shared/protocol'

/** Client-side skip trap visuals (server is authoritative). */
export class SkipTrapSystem {
  private readonly scene: THREE.Scene
  private readonly traps = new Map<string, SkipTrapMarker>()
  private localPlayerId: string | null = null

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  setLocalPlayerId(id: string | null): void {
    this.localPlayerId = id
  }

  clear(): void {
    for (const m of this.traps.values()) {
      this.scene.remove(m.root)
      m.dispose()
    }
    this.traps.clear()
  }

  setFromSnapshot(traps: PlacedTrapWire[]): void {
    this.clear()
    for (const t of traps) this.add(t)
  }

  add(trap: PlacedTrapWire): void {
    if (this.traps.has(trap.id)) return
    const isOwn =
      this.localPlayerId != null && trap.ownerId === this.localPlayerId
    const m = new SkipTrapMarker(trap.id, trap.x, trap.z, isOwn)
    this.traps.set(trap.id, m)
    this.scene.add(m.root)
  }

  remove(trapId: string): void {
    const m = this.traps.get(trapId)
    if (!m) return
    this.scene.remove(m.root)
    m.dispose()
    this.traps.delete(trapId)
  }

  update(dt: number): void {
    for (const m of this.traps.values()) m.update(dt)
  }
}
