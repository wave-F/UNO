export class InputManager {
  private keys = new Set<string>()
  private jumpPressed = false
  private mouseDx = 0
  private mouseDy = 0
  private pointerLocked = false
  private readonly target: HTMLElement

  constructor(pointerTarget: HTMLElement = document.body) {
    this.target = pointerTarget
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    document.addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    this.target.addEventListener('click', this.onClick)
    this.target.addEventListener('contextmenu', this.onContextMenu)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    document.removeEventListener('mousemove', this.onMouseMove)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    this.target.removeEventListener('click', this.onClick)
    this.target.removeEventListener('contextmenu', this.onContextMenu)
    if (document.pointerLockElement === this.target) {
      document.exitPointerLock()
    }
  }

  isPointerLocked(): boolean {
    return this.pointerLocked
  }

  /**
   * Horizontal move on local axes, length ≤ 1.
   * x: A/D strafe (−1 left, +1 right)
   * z: W/S forward in Three.js style (−1 = W / “into screen” when yaw=0)
   */
  getMoveVector(): { x: number; z: number } {
    let x = 0
    let z = 0
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1
    const len = Math.hypot(x, z)
    if (len > 1e-6) {
      x /= len
      z /= len
    }
    return { x, z }
  }

  /** Consume accumulated mouse delta (pixels) since last call. */
  consumeMouseDelta(): { x: number; y: number } {
    const d = { x: this.mouseDx, y: this.mouseDy }
    this.mouseDx = 0
    this.mouseDy = 0
    return d
  }

  consumeJump(): boolean {
    if (!this.jumpPressed) return false
    this.jumpPressed = false
    return true
  }

  private onClick = (): void => {
    if (document.pointerLockElement !== this.target) {
      void this.target.requestPointerLock()
    }
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault()
  }

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.target
    if (!this.pointerLocked) {
      this.mouseDx = 0
      this.mouseDy = 0
    }
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return
    this.mouseDx += e.movementX
    this.mouseDy += e.movementY
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return
    this.keys.add(e.code)
    if (e.code === 'Space') {
      e.preventDefault()
      this.jumpPressed = true
    }
    if (e.code === 'Escape') {
      // browser exits pointer lock; no-op
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }

  private onBlur = (): void => {
    this.keys.clear()
    this.jumpPressed = false
    this.mouseDx = 0
    this.mouseDy = 0
  }
}
