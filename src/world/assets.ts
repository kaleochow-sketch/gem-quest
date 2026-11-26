/**
 * Models made in Blender (scripts/blender/*.py → public/models/*.glb).
 *
 * Every top-level object in each .glb becomes a named model. They are all
 * loaded once before the 3D world opens; code that builds the scene asks for
 * `model(name)` and falls back to its own simple shapes when a model is
 * missing (an old cached build, a failed download), so nothing ever breaks.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** The .glb files under models/, one per Blender script. */
export const MODEL_FILES = ['characters', 'nature', 'buildings'];

const library = new Map<string, THREE.Object3D>();
let loading: Promise<void> | null = null;

/** Loads every model file once; resolves even if some fail. */
export function loadModels(): Promise<void> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  loading = Promise.all(
    MODEL_FILES.map((file) =>
      loader
        .loadAsync(`models/${file}.glb`)
        .then((gltf) => {
          for (const child of [...gltf.scene.children]) {
            child.traverse((o) => {
              const mesh = o as THREE.Mesh;
              if (mesh.isMesh) {
                mesh.castShadow = true;
                mesh.receiveShadow = true;
              }
            });
            library.set(child.name, child);
          }
        })
        .catch((err) => console.warn(`3D models "${file}" not loaded; using simple shapes`, err)),
    ),
  ).then(() => undefined);
  return loading;
}

export function hasModel(name: string): boolean {
  return library.has(name);
}

/**
 * A fresh copy of a model, or null if it isn't loaded. Geometry and
 * materials are shared between copies; use `recolor` to change colours on
 * one copy only.
 */
export function model(name: string): THREE.Object3D | null {
  const src = library.get(name);
  if (!src) return null;
  const copy = src.clone(true);
  copy.position.set(0, 0, 0);
  copy.rotation.set(0, 0, 0);
  copy.scale.set(1, 1, 1);
  return copy;
}

/** All loaded model names starting with a prefix (e.g. variants "tree_round_1", "tree_round_2"). */
export function modelNames(prefix: string): string[] {
  return [...library.keys()].filter((n) => n.startsWith(prefix)).sort();
}

/**
 * Recolours materials by their Blender material name on this copy only
 * (materials are cloned first, so other copies keep their colours).
 * Names match exactly or as a prefix before a dot ("Paint" matches "Paint.001").
 */
export function recolor(obj: THREE.Object3D, colors: Record<string, string | THREE.Color>): void {
  const cloned = new Map<THREE.Material, THREE.Material>();
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (m: THREE.Material): THREE.Material => {
      const base = m.name.split('.')[0];
      const want = colors[m.name] ?? colors[base];
      if (want === undefined) return m;
      let c = cloned.get(m);
      if (!c) {
        c = m.clone();
        (c as THREE.MeshStandardMaterial).color?.set(want);
        cloned.set(m, c);
      }
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
}

/** Sets cast/receive shadow on every mesh in a model copy. */
export function shadows(obj: THREE.Object3D, cast = true, receive = true): THREE.Object3D {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
    }
  });
  return obj;
}
