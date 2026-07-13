import RAPIER from '@dimforge/rapier3d-compat'

let initPromise: Promise<void> | null = null

export async function initRapier(): Promise<typeof RAPIER> {
  if (!initPromise) {
    initPromise = RAPIER.init()
  }
  await initPromise
  return RAPIER
}

export class PhysicsWorld {
  readonly world: RAPIER.World
  readonly RAPIER: typeof RAPIER

  constructor(R: typeof RAPIER) {
    this.RAPIER = R
    this.world = new R.World({ x: 0, y: -9.81, z: 0 })
    // Fixed timestep feel; gravity on world is backup — player gravity is custom.
  }

  step(): void {
    this.world.step()
  }

  dispose(): void {
    this.world.free()
  }
}
