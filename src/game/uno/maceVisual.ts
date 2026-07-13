import * as THREE from 'three'

/** Approximate height of a unit-scale mace (handle + head). */
export const MACE_HEIGHT = 0.95

/**
 * Procedural 狼牙棒 (morning star / spiked mace).
 * Local +Y is tip; origin near handle grip.
 */
export function createMaceMesh(scale = 1): THREE.Group {
  const root = new THREE.Group()
  root.name = 'Mace'

  const wood = new THREE.MeshStandardMaterial({
    color: 0x6b3f1d,
    roughness: 0.85,
    metalness: 0.05,
  })
  const metal = new THREE.MeshStandardMaterial({
    color: 0x64748b,
    roughness: 0.35,
    metalness: 0.75,
  })
  const spikeMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    roughness: 0.3,
    metalness: 0.85,
  })
  const gold = new THREE.MeshStandardMaterial({
    color: 0xfbbf24,
    roughness: 0.4,
    metalness: 0.55,
    emissive: 0x854d0e,
    emissiveIntensity: 0.15,
  })

  // Grip (bottom)
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045 * scale, 0.055 * scale, 0.18 * scale, 10),
    wood,
  )
  grip.position.y = 0.09 * scale
  grip.castShadow = true
  root.add(grip)

  // Handle shaft
  const shaftLen = 0.55 * scale
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032 * scale, 0.038 * scale, shaftLen, 8),
    wood,
  )
  shaft.position.y = 0.18 * scale + shaftLen / 2
  shaft.castShadow = true
  root.add(shaft)

  // Neck collar
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05 * scale, 0.05 * scale, 0.04 * scale, 10),
    metal,
  )
  collar.position.y = 0.18 * scale + shaftLen + 0.02 * scale
  collar.castShadow = true
  root.add(collar)

  // Spiked head
  const headR = 0.12 * scale
  const headY = 0.18 * scale + shaftLen + 0.04 * scale + headR * 0.85
  const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 14, 12), metal)
  head.position.y = headY
  head.castShadow = true
  root.add(head)

  // Accent band on head
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(headR * 0.72, 0.018 * scale, 6, 16),
    gold,
  )
  band.rotation.x = Math.PI / 2
  band.position.y = headY
  band.castShadow = true
  root.add(band)

  // Spikes around head (狼牙)
  const spikeCount = 10
  const up = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < spikeCount; i++) {
    const spike = new THREE.Mesh(
      new THREE.ConeGeometry(0.028 * scale, 0.12 * scale, 6),
      spikeMat,
    )
    const lat = (i / spikeCount) * Math.PI * 2
    const elev = i % 2 === 0 ? 0.35 : -0.15
    const dir = new THREE.Vector3(
      Math.cos(lat) * Math.cos(elev),
      Math.sin(elev),
      Math.sin(lat) * Math.cos(elev),
    ).normalize()
    spike.position.set(0, headY, 0).addScaledVector(dir, headR * 0.92)
    spike.quaternion.setFromUnitVectors(up, dir)
    spike.castShadow = true
    root.add(spike)
  }

  // Top spike
  const topSpike = new THREE.Mesh(
    new THREE.ConeGeometry(0.03 * scale, 0.14 * scale, 6),
    spikeMat,
  )
  topSpike.position.y = headY + headR * 0.85
  topSpike.castShadow = true
  root.add(topSpike)

  return root
}

export function disposeMaceMesh(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry?.dispose()
      const m = o.material
      if (Array.isArray(m)) m.forEach((x) => x.dispose())
      else m?.dispose()
    }
  })
}
