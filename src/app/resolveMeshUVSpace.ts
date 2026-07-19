// resolveMeshUVSpace — the ONE projection over the (mesh, material) pair (#406).
//
// UV layout and base-color texture are not two questions. They are one domain object:
// every reference system joins them as a pairing — glTF binds each texture to a UV set
// per-texture via `texCoord` → TEXCOORD_n; Blender binds an Image Texture to a named
// `uv_layers` entry through a UV Map node; Houdini carries `uv` as a vertex-class
// (per-corner) attribute. "What does the 2D View show for this selection?" is a single
// query over the pair, so it gets a single resolver.
//
// This REPLACES the two independent resolvers (`resolveMeshUVs` / `resolveMeshTexture`),
// which had drifted in the two ways two roads to one datum always drift:
//   - both hand-maintained a list of node type strings, and both silently missed `Object`
//     when the object↔data split introduced it (#378) — a fallthrough returning a
//     LEGITIMATE value ('none') is indistinguishable from a real answer;
//   - they disagreed on what a registry miss MEANS: the BakedMesh arm read it as 'loading',
//     the Object arm as 'none'. Same miss, opposite status.
//
// ---------------------------------------------------------------------------
// HOW IT STAYS ROBUST AS NEW MECHANISMS ARRIVE
// ---------------------------------------------------------------------------
//
// 1. KEYED ON CAPABILITY, NOT NODE TYPE. The entry point asks `resolveEvaluatedMesh` —
//    the one read-side twin of what the renderer mounts — and then branches on the
//    RESOLVED VALUE (its `GeometryRef.kind` and material shape), never on `node.type`.
//    Any future node that resolves to an evaluated mesh is handled the day it lands:
//    the Stage C data kinds behind `Object`, new modifiers (Array/Mirror already work
//    through the recursive resolver arms), anything else. There is no list to update,
//    so there is no list to forget.
//
// 2. THE MISS RULE IS DERIVED FROM THE SOURCE'S AVAILABILITY MODEL, NOT GUESSED.
//    `geometryRegistry.get()` returns null for THREE different reasons, and collapsing
//    them into one rule is wrong twice over (geometryRegistry.ts:41-59):
//      - a `gltf` ref ALWAYS returns null — the registry does not own loaded glTF
//        geometry, the asset clone does. Null means "look elsewhere", not "wait".
//      - a `baked` MISS returns null because the bytes are in OPFS behind an async
//        read. Null means "wait" → 'loading'.
//      - a procedural ref BUILDS on miss. Null means the descriptor was malformed.
//        Null means "there genuinely isn't one" → 'none'.
//    So each geometry kind declares an AVAILABILITY CLASS, and both facets of the pair
//    inherit the correct miss semantics from it. One place knows the rule; nothing
//    re-derives it.
//
// 3. A NEW GEOMETRY KIND IS A COMPILE ERROR, NOT A SILENT DEFAULT. `availabilityOf` is
//    an exhaustive switch closed by a `never` check. Adding a kind to `GeometryRef`
//    without declaring how it becomes available fails typecheck. This is deliberately a
//    TYPE rather than a documented convention: a checklist a human must consult is not a
//    mechanism, and the whole failure this module exists to end was a list nobody updated.
//
// 4. STATUS IS PER-FACET, SEMANTICS ARE SHARED. The pair resolves in one walk, but `uvs`
//    and `texture` keep independent statuses — a baked mesh can have primed geometry while
//    its texture is still decoding, and the panel must show islands immediately rather than
//    block on the backdrop. Shared code path, shared vocabulary, independent readiness.
//
// EXTENSION POINT (deliberately NOT built yet — see #406). The references bind textures to
// UV sets BY NAME/INDEX, per-map; we carry one anonymous set and one `uvTransform` shared
// across all six map slots. Adding named sets is gated on vertex-class (per-corner)
// attributes, which the substrate lacks — without them a UV SEAM cannot be represented at
// all, so a naming layer would be a vocabulary with nothing to say. When per-corner
// attributes land, the binding becomes an additive field on `MeshUVSpace` plus a selector
// on the texture facet; consumers that ignore it keep working. That is the whole reason to
// consolidate BEFORE the naming question arrives rather than after.
//
// Non-throwing / sync throughout: async sources report 'loading' and are re-polled by the
// caller. NEVER a Suspense throw — the UV panel is not inside a Suspense boundary and the
// e2e seams must not throw.
//
// REF: geometryRegistry.ts:41-59 (the three meanings of a null get); resolveEvaluatedMesh.ts
//      (the shared read-side twin); vyapti V33 (read-only projection), V48 (flipY
//      registration); hetvabhasa H178. Issue #406, follow-up from #378.

import type { BufferGeometry, Material, Mesh, Object3D, Texture } from 'three';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type {
  BakedMaterialSpec,
  BakedTextureRef,
  EvaluatedUVs,
  GeometryRef,
  InlineMaterialSpec,
  UVIsland,
} from '../nodes/types';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { extractUVIslands } from './uvIslands';
import { getGltfClone } from './asset/gltfCloneRegistry';
import { peekBakedTexture } from './asset/bakedTextureLoader';
import { get as getRegistryGeometry } from './geometryRegistry';

// UV layout and texture placement are both time-independent (geometry UVs are static;
// the map binding is a material param, not a channel), so a zero ctx is exact for the
// whole pair. This is WHY the pair has exactly one resolution road each rather than the
// base/channel/transient trilogy a time-varying param needs.
const STATIC_CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

export type UVSpaceStatus = 'ok' | 'loading' | 'none';

export interface UVSource {
  readonly uvs: EvaluatedUVs | null;
  readonly status: UVSpaceStatus;
}

export interface MeshTextureSource {
  /** Drawable base-color image (HTMLImageElement / ImageBitmap / canvas), or null. */
  readonly image: CanvasImageSource | null;
  /** Texture flipY — selects the backdrop's vertical orientation (see V48). */
  readonly flipY: boolean;
  readonly width: number;
  readonly height: number;
  readonly status: UVSpaceStatus;
}

/** The (mesh, material) pair as ONE resolved value — see the header. */
export interface MeshUVSpace {
  readonly uvs: UVSource;
  readonly texture: MeshTextureSource;
}

const UV_NONE: UVSource = { uvs: null, status: 'none' };
const UV_LOADING: UVSource = { uvs: null, status: 'loading' };
const TEX_NONE: MeshTextureSource = {
  image: null,
  flipY: false,
  width: 0,
  height: 0,
  status: 'none',
};
const TEX_LOADING: MeshTextureSource = { ...TEX_NONE, status: 'loading' };

const SPACE_NONE: MeshUVSpace = { uvs: UV_NONE, texture: TEX_NONE };
const SPACE_LOADING: MeshUVSpace = { uvs: UV_LOADING, texture: TEX_LOADING };

/**
 * How a geometry kind's underlying buffers BECOME available — which is what decides what a
 * registry miss means for it (see header point 2).
 *
 *   'procedural' — the registry builds it synchronously on demand. A miss is a malformed
 *                  descriptor, i.e. there genuinely is no geometry → 'none'.
 *   'primed'     — authoritative bytes live in OPFS and are primed after an async read.
 *                  A miss is "not read yet" → 'loading'.
 *   'clone'      — the buffers live in a loaded glTF asset clone, never in the registry.
 *                  An absent clone is "still loading the asset" → 'loading'.
 */
type Availability = 'procedural' | 'primed' | 'clone';

function availabilityOf(kind: GeometryRef['kind']): Availability {
  switch (kind) {
    case 'box':
    case 'sphere':
    case 'array':
    case 'mirror':
      return 'procedural';
    case 'baked':
      return 'primed';
    case 'gltf':
      return 'clone';
    default: {
      // Exhaustiveness gate: a new GeometryRef kind must declare how it becomes
      // available. Deliberately a compile error rather than a default — see header 3.
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** First isMesh descendant's BufferGeometry under `root` (or root itself). */
function firstMeshGeometry(root: Object3D | null | undefined): BufferGeometry | null {
  if (!root) return null;
  let geo: BufferGeometry | null = null;
  root.traverse((o) => {
    if (!geo && (o as Mesh).isMesh) geo = (o as Mesh).geometry;
  });
  return geo;
}

/** Union the UV islands of every mesh under a clone root (whole-asset view). */
function extractCloneUVs(root: Object3D): EvaluatedUVs {
  const islands: UVIsland[] = [];
  let triangleCount = 0;
  let sampled = false;
  root.traverse((o) => {
    if ((o as Mesh).isMesh) {
      const u = extractUVIslands((o as Mesh).geometry);
      islands.push(...u.islands);
      triangleCount += u.triangleCount;
      sampled = sampled || u.sampled;
    }
  });
  return { islands, triangleCount, sampled };
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

/** True for an image we can hand to CanvasRenderingContext2D.drawImage. Guards against
 *  DataTexture-style `{ data, width, height }` images and absent globals (this module is
 *  also reachable from non-DOM test contexts). */
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
  return { width: i.naturalWidth || i.width || 0, height: i.naturalHeight || i.height || 0 };
}

/** A three Texture → the drawable backdrop source, or null when not drawable. */
function fromTexture(tex: Texture | null | undefined): MeshTextureSource | null {
  if (!tex || !isDrawable(tex.image)) return null;
  const { width, height } = dims(tex.image);
  return { image: tex.image, flipY: tex.flipY !== false, width, height, status: 'ok' };
}

/** Peek a BakedTextureRef from the loader cache without throwing Suspense: 'ok' (cached +
 *  drawable), 'loading' (read kicked off / decoding), or 'none' (absent ref). A decode
 *  FAILURE resolves to 'loading' and never blanks the editor — peek returns null on the
 *  cached error, so the panel just shows the grid (resilience by construction). */
function fromBakedRef(ref: BakedTextureRef | null | undefined): MeshTextureSource {
  if (!ref) return TEX_NONE;
  const tex = peekBakedTexture(ref);
  if (!tex) return TEX_LOADING;
  return fromTexture(tex) ?? TEX_LOADING;
}

/**
 * The base-color map carried by a resolved mesh material, whichever spec shape it is.
 * Discriminated on `materialClass` (the baked spec's marker) exactly as the renderer and
 * the bake path do — one vocabulary, not a per-call-site guess.
 */
function textureFromMaterial(
  material: InlineMaterialSpec | BakedMaterialSpec | null,
): MeshTextureSource {
  if (!material) return TEX_NONE;
  if ('materialClass' in material) return fromBakedRef(material.map ?? null);
  return fromBakedRef(material.maps?.albedo ?? null);
}

/**
 * Resolve the (mesh, material) pair for `nodeId` — the ONE query behind everything the 2D
 * View shows. See the header for why this is a single projection and how it stays robust.
 *
 * Pure and sync: no store reads, never throws, async sources report 'loading'.
 */
export function resolveMeshUVSpace(state: DagState, nodeId: string): MeshUVSpace {
  const node = state.nodes[nodeId];
  if (!node) return SPACE_NONE;

  const mesh = resolveEvaluatedMesh(state, nodeId, STATIC_CTX);

  if (!mesh) {
    // THE ONE named exception to capability-keying, and it is structural rather than an
    // oversight: a GltfAsset is an AGGREGATE over every mesh in the clone, so it has no
    // single EvaluatedMesh to resolve — `resolveEvaluatedMesh` correctly returns null for
    // it. The whole-asset union is a different question from "this mesh's UVs", so it gets
    // its own arm instead of being forced through the shared shape.
    if (node.type === 'GltfAsset') {
      const assetRef = (node.params as { assetRef?: string }).assetRef;
      const clone = assetRef ? getGltfClone(assetRef) : null;
      if (!clone) return SPACE_LOADING;
      return {
        uvs: { uvs: extractCloneUVs(clone), status: 'ok' },
        texture: fromTexture(firstBaseColorMap(clone)) ?? TEX_NONE,
      };
    }
    return SPACE_NONE; // not a mesh producer
  }

  const geometry = mesh.geometry;

  switch (availabilityOf(geometry.kind)) {
    case 'clone': {
      // glTF: both facets come from the loaded asset clone, keyed by the RESOLVED
      // descriptor rather than the node's params — so any node that resolves to a
      // gltf-kind geometry works, not just the GltfChild type.
      const d = geometry.descriptor as { assetRef?: string; childName?: string };
      const clone = d.assetRef ? getGltfClone(d.assetRef) : null;
      if (!clone) return SPACE_LOADING;
      const sub = d.childName ? clone.getObjectByName(d.childName) : clone;
      const geo = firstMeshGeometry(sub);
      return {
        uvs: geo ? { uvs: extractUVIslands(geo), status: 'ok' } : UV_NONE,
        texture: fromTexture(firstBaseColorMap(sub)) ?? TEX_NONE,
      };
    }
    case 'primed':
    case 'procedural': {
      // Registry-backed geometry. The two classes share this arm because the LOOKUP is
      // identical — they differ only in what a miss means, which is exactly what the
      // availability class encodes.
      const geo = getRegistryGeometry(geometry);
      const uvs: UVSource = geo
        ? { uvs: extractUVIslands(geo), status: 'ok' }
        : availabilityOf(geometry.kind) === 'primed'
          ? UV_LOADING // OPFS bytes not read yet
          : UV_NONE; // malformed descriptor — nothing to build
      return { uvs, texture: textureFromMaterial(mesh.material) };
    }
  }
}
