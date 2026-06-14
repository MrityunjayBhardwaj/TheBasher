// resolveMeshTexture — the ONE producer-aware base-color-texture resolver for
// the UV editor (UX-BACKLOG #10). The V33 read-only-projection SIBLING of
// `resolveMeshUVs`: given a mesh node, return the bound base-color (albedo) map
// image so the UVEditor can paint it as a backdrop UNDER the UV islands,
// Blender-style. Read-only, non-throwing, sync where possible (async geometry /
// baked bytes not ready yet return status 'loading', NEVER a Suspense throw —
// the panel is not inside a Suspense boundary, same discipline as resolveMeshUVs).
//
//   - glTF / GltfChild / GltfAsset → the loaded clone's material.map (decoded by
//     GLTFLoader, sync once the clone is registered). UV(0,0) origin depends on
//     the texture's flipY (glTF maps are flipY=false → top-left origin).
//   - BakedMesh → the baked material's `map` BakedTextureRef, peeked from the
//     baked-texture loader cache (null on miss = 'loading'; never the throwing
//     resolveBakedTexture).
//   - Box / Sphere → the inline material's `maps.albedo` BakedTextureRef, same
//     non-throwing peek.
//
// WHY flipY MATTERS (the registration invariant — V48):
//   The UVEditor draws an island vertex (u,v) at screen (ox+u·sz, oy+(1-v)·sz)
//   (V-up display flip). For the texel a vertex samples to sit BEHIND it, the
//   backdrop's orientation must follow the texture's flipY:
//     flipY=true  (OpenGL / three default) → UV(0,0)=image bottom-left → draw upright.
//     flipY=false (glTF / DirectX)         → UV(0,0)=image top-left    → draw flipped.
//   The resolver reports flipY; the draw side applies the conditional flip.
//
// REF: UX-BACKLOG #10; resolveMeshUVs.ts (the UV-layout sibling); vyapti V48.

import type { Material, Mesh, Object3D, Texture } from 'three';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type { BakedTextureRef } from '../nodes/types';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { getGltfClone } from './asset/gltfCloneRegistry';
import { peekBakedTexture } from './asset/bakedTextureLoader';

// Texture layout is time-independent, so a zero ctx is exact (mirrors resolveMeshUVs).
const STATIC_CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

export type TextureSourceStatus = 'ok' | 'loading' | 'none';

export interface MeshTextureSource {
  /** Drawable base-color image (HTMLImageElement / ImageBitmap / canvas), or null. */
  readonly image: CanvasImageSource | null;
  /** Texture flipY — selects the backdrop's vertical orientation (see V48). */
  readonly flipY: boolean;
  readonly width: number;
  readonly height: number;
  readonly status: TextureSourceStatus;
}

const NONE: MeshTextureSource = { image: null, flipY: false, width: 0, height: 0, status: 'none' };
const LOADING: MeshTextureSource = {
  image: null,
  flipY: false,
  width: 0,
  height: 0,
  status: 'loading',
};

/** True for an image we can hand to CanvasRenderingContext2D.drawImage. Guards
 *  against DataTexture-style `{ data, width, height }` images and absent globals
 *  (the resolver is also reachable from non-DOM test contexts). */
function isDrawable(image: unknown): image is CanvasImageSource {
  if (!image || typeof image !== 'object') return false;
  const g = globalThis as Record<string, unknown>;
  for (const name of ['HTMLImageElement', 'HTMLCanvasElement', 'ImageBitmap', 'OffscreenCanvas']) {
    const ctor = g[name] as { new (): unknown } | undefined;
    if (typeof ctor === 'function' && image instanceof (ctor as never)) return true;
  }
  return false;
}

/** Read `tex.image` width/height defensively (HTMLImageElement uses naturalWidth). */
function dims(image: CanvasImageSource): { width: number; height: number } {
  const i = image as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  };
  return {
    width: i.naturalWidth || i.width || 0,
    height: i.naturalHeight || i.height || 0,
  };
}

/** A three Texture → the drawable backdrop source, or null when not drawable. */
function fromTexture(tex: Texture | null | undefined): MeshTextureSource | null {
  if (!tex || !isDrawable(tex.image)) return null;
  const { width, height } = dims(tex.image);
  return { image: tex.image, flipY: tex.flipY !== false, width, height, status: 'ok' };
}

/** First base-color (`material.map`) texture among the meshes under `root`. */
function firstBaseColorMap(root: Object3D | null | undefined): Texture | null {
  if (!root) return null;
  let map: Texture | null = null;
  root.traverse((o) => {
    if (map) return;
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const t = (m as { map?: Texture | null }).map;
      if (t) {
        map = t;
        return;
      }
    }
  });
  return map;
}

/** Peek a BakedTextureRef from the loader cache without throwing Suspense:
 *  'ok' (cached + drawable), 'loading' (read kicked off / decoding), or null
 *  (absent ref). A decode FAILURE resolves to 'loading' here and never blanks
 *  the editor — peek returns null on the cached error, so the editor just shows
 *  the grid (resilience by construction). */
function fromBakedRef(ref: BakedTextureRef | null | undefined): MeshTextureSource {
  if (!ref) return NONE;
  const tex = peekBakedTexture(ref);
  if (!tex) return LOADING;
  return fromTexture(tex) ?? LOADING;
}

export function resolveMeshTexture(state: DagState, nodeId: string): MeshTextureSource {
  const node = state.nodes[nodeId];
  if (!node) return NONE;

  if (node.type === 'GltfChild') {
    const p = node.params as { assetRef?: string; childName?: string };
    const clone = p.assetRef ? getGltfClone(p.assetRef) : null;
    if (!clone) return LOADING;
    const sub = p.childName ? clone.getObjectByName(p.childName) : clone;
    return fromTexture(firstBaseColorMap(sub)) ?? NONE;
  }

  if (node.type === 'GltfAsset') {
    const p = node.params as { assetRef?: string };
    const clone = p.assetRef ? getGltfClone(p.assetRef) : null;
    if (!clone) return LOADING;
    return fromTexture(firstBaseColorMap(clone)) ?? NONE;
  }

  if (node.type === 'BakedMesh') {
    const mesh = resolveEvaluatedMesh(state, nodeId, STATIC_CTX);
    if (!mesh || mesh.geometry.kind !== 'baked') return NONE;
    const mat = mesh.material as { map?: BakedTextureRef | null } | null;
    return fromBakedRef(mat?.map ?? null);
  }

  if (node.type === 'BoxMesh' || node.type === 'SphereMesh') {
    const mesh = resolveEvaluatedMesh(state, nodeId, STATIC_CTX);
    const mat = mesh?.material as { maps?: { albedo?: BakedTextureRef | null } } | null;
    return fromBakedRef(mat?.maps?.albedo ?? null);
  }

  return NONE;
}
