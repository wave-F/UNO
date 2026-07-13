import * as THREE from 'three'

/** Approximate height of field skip prop. */
export const SKIP_PICKUP_HEIGHT = 0.75

/**
 * Distinct field pickup for Skip trap (not a flat number card).
 * Teal pad + big ban ring so it is easy to spot among maces/numbers.
 */
export function createSkipPickupMesh(scale = 1): THREE.Group {
  const root = new THREE.Group()
  root.name = 'SkipPickup'

  const teal = new THREE.MeshStandardMaterial({
    color: 0x0f766e,
    emissive: 0x115e59,
    emissiveIntensity: 0.35,
    roughness: 0.45,
    metalness: 0.15,
  })
  const cyan = new THREE.MeshStandardMaterial({
    color: 0x5eead4,
    emissive: 0x14b8a6,
    emissiveIntensity: 0.25,
    roughness: 0.4,
    metalness: 0.2,
  })
  const red = new THREE.MeshStandardMaterial({
    color: 0xf87171,
    emissive: 0xb91c1c,
    emissiveIntensity: 0.3,
    roughness: 0.4,
    metalness: 0.1,
  })

  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42 * scale, 0.48 * scale, 0.08 * scale, 24),
    teal,
  )
  pad.position.y = 0.04 * scale
  pad.castShadow = true
  root.add(pad)

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.32 * scale, 0.045 * scale, 10, 28),
    cyan,
  )
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.12 * scale
  ring.castShadow = true
  root.add(ring)

  const slash = new THREE.Mesh(
    new THREE.BoxGeometry(0.55 * scale, 0.06 * scale, 0.08 * scale),
    red,
  )
  slash.position.y = 0.2 * scale
  slash.rotation.z = Math.PI / 4
  slash.castShadow = true
  root.add(slash)

  // Vertical flag pole + SKIP plate
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03 * scale, 0.035 * scale, 0.55 * scale, 8),
    cyan,
  )
  pole.position.y = 0.12 * scale + 0.28 * scale
  pole.castShadow = true
  root.add(pole)

  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.55 * scale, 0.32 * scale, 0.05 * scale),
    teal,
  )
  plate.position.y = 0.12 * scale + 0.55 * scale
  plate.castShadow = true
  root.add(plate)

  // Canvas "SKIP" label
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#0f766e'
  ctx.fillRect(0, 0, 256, 128)
  ctx.strokeStyle = '#5eead4'
  ctx.lineWidth = 10
  ctx.strokeRect(8, 8, 240, 112)
  ctx.fillStyle = '#ecfdf5'
  ctx.font = 'bold 64px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('SKIP', 128, 64)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5 * scale, 0.25 * scale),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
  )
  label.position.y = plate.position.y
  label.position.z = 0.035 * scale
  root.add(label)
  const labelB = label.clone()
  labelB.position.z = -0.035 * scale
  labelB.rotation.y = Math.PI
  root.add(labelB)

  ;(root as THREE.Object3D & { userData: { skipFaceTex?: THREE.CanvasTexture } }).userData = {
    skipFaceTex: tex,
  }

  return root
}

export function disposeSkipPickupMesh(root: THREE.Object3D): void {
  const tex = (root as THREE.Object3D & { userData: { skipFaceTex?: THREE.CanvasTexture } })
    .userData?.skipFaceTex
  tex?.dispose()
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry?.dispose()
      const m = o.material
      if (Array.isArray(m)) m.forEach((x) => x.dispose())
      else m?.dispose()
    }
  })
}
