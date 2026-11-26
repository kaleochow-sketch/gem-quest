/**
 * Building parts and furniture made in Blender (scripts/blender/buildings.py
 * → public/models/buildings.glb). Each helper returns a fresh, recoloured
 * copy, or null when the models aren't loaded, so callers keep their own
 * simple shapes as the fallback.
 *
 * Material names in the models: Paint (the player's chosen colour; also
 * "Paint.cloth" for fabric), Trim, Wood, WoodDark, Metal, Gold, Glass, Lamp
 * (swapped for a glowing material by the caller), Fabric, Fabric2, Stone,
 * StoneDark, Roof, Leaf, Old, SignFace (gets the sign's lettering).
 */
import * as THREE from 'three';
import { model, recolor } from './assets.js';

/** A copy of a Blender prop with materials recoloured by name, or null. */
export function prop(name: string, colors?: Record<string, string>): THREE.Object3D | null {
  const o = model(name);
  if (!o) return null;
  if (colors) recolor(o, colors);
  return o;
}

/** Puts `m` on every mesh of this copy whose material is named `name` (or `name.xxx`). */
export function useMaterial<T extends THREE.Object3D>(o: T, name: string, m: THREE.Material): T {
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (old: THREE.Material) => (old.name === name || old.name.split('.')[0] === name ? m : old);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  return o;
}

/**
 * The shop sign with its lettering on the face. The canvas texture is turned
 * the right way up for glTF UVs.
 */
export function signProp(color: string, lettering: THREE.CanvasTexture): THREE.Object3D | null {
  const o = prop('prop_sign', { Paint: color });
  if (!o) return null;
  lettering.flipY = false;
  lettering.needsUpdate = true;
  return useMaterial(o, 'SignFace', new THREE.MeshStandardMaterial({ map: lettering, roughness: 0.7 }));
}
