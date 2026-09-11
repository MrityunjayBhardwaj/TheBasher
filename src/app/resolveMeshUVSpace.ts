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
// 2. THE MISS RULE IS INHERITED, NOT RESTATED. This paragraph used to spell out the three
//    meanings of an empty registry read and which status each maps to. It no longer does,
//    and the deletion is the point: prose describing a rule is a second copy of it, and the
//    two agree only until someone changes one. The rule is now a TYPE — `readMeshUVs`
//    returns ok / elsewhere / loading / none, inherited from the registry's own typed read
//    (#630) — and this module consumes that answer instead of deriving one.
//
// 3. A NEW GEOMETRY KIND IS A COMPILE ERROR, NOT A SILENT DEFAULT. `availabilityOf` is
//    an exhaustive switch closed by a `never` check. Adding a kind to `GeometryRef`
//    without declaring how it becomes available fails typecheck. It now lives in
//    `geometryRegistry` (#630) rather than here: the registry is the code that decides to
//    return nothing, so it owns the reason. This file no longer even calls it — #635 put a
//    typed UV read between them, and the `never` chain runs unbroken from the geometry kind
//    through that read into this module's own narrowing. This is
//    deliberately a
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

import type { Material, Mesh, Object3D, Texture } from 'three';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type {
  BakedMaterialSpec,
  BakedTextureRef,
  EvaluatedUVs,
  InlineMaterialSpec,
  UVIsland,
} from '../nodes/types';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { extractUVIslands } from './uvIslands';
import { firstMeshGeometry } from './firstMeshGeometry';
import { getGltfClone } from './asset/gltfCloneRegistry';
import { cloneAddressOf } from './geometryRegistry';
import { peekBakedTexture } from './asset/bakedTextureLoader';
import { primarySlotMaterial, type SlotMaterial } from './materialAssignment';
import type { MeshUVRead } from '../nodes/types';

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
/**
 * Narrow the resolver's four-way UV answer into this module's own three-status facet.
 *
 * `elsewhere` cannot arrive here — the clone-backed arm above answers those from the asset
 * itself — so it is mapped to `none` explicitly rather than by a default, which is what
 * makes a fifth status a visible edit instead of a silent collapse into "no UVs".
 *
 * #367 — that exclusion still holds, and now by construction rather than by coincidence:
 * `elsewhere` is produced only for a `gltf` descriptor, and every `gltf` descriptor is taken
 * by the arm above before reaching here.
 */
function uvSourceOf(read: MeshUVRead): UVSource {
  switch (read.status) {
    case 'ok':
      return { uvs: read.islands, status: 'ok' };
    case 'loading':
      return UV_LOADING;
    case 'elsewhere':
    case 'none':
      return UV_NONE;
    default: {
      const unreachable: never = read;
      throw new Error(`uvSourceOf: undeclared UV read status ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Narrow the assignment's four-way slot answer into this module's texture facet — the twin of
 * {@link uvSourceOf}, and the reason this arm no longer calls `primaryMaterial`.
 *
 * `primaryMaterial` returns `M | null`, which has no room for the difference between *"there
 * is no material"* and *"a mounted clone owns what draws and we hold no capture"* — so it
 * re-merged them here and the panel went blank for a clone-drawn mesh (#1015). Taking the
 * widened road means the collapse cannot come back by someone editing this body.
 *
 * `elsewhere` cannot arrive: the clone arm above takes every descriptor `cloneAddressOf`
 * answers for, and `absentSlot` is `'elsewhere'` on exactly the same condition — both are
 * defined in terms of `availabilityOf(descriptor) === 'clone'`, one rule read twice rather
 * than two that happen to agree. It is written out rather than defaulted anyway, because that
 * is what makes a fifth status a visible edit, and `cloneAddress.gate.test.ts` reds if the two
 * ever select different sets.
 */
function textureSourceOf(
  slot: SlotMaterial<InlineMaterialSpec | BakedMaterialSpec>,
): MeshTextureSource {
  switch (slot.status) {
    case 'ok':
      return textureFromMaterial(slot.material);
    // No material on the slot, and no slot at all: both are "nothing to draw", and they are
    // different questions that this facet genuinely answers the same way.
    case 'none':
    case 'no-such-slot':
      return TEX_NONE;
    case 'elsewhere':
      return TEX_NONE;
    default: {
      const unreachable: never = slot;
      throw new Error(`textureSourceOf: undeclared slot status ${JSON.stringify(unreachable)}`);
    }
  }
}

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

  // #635 took this branch on the RESOLVER'S TYPED ANSWER rather than a re-derived
  // availability class, because `elsewhere` meant exactly "these buffers live in a loaded
  // asset clone, not in the registry" — the glTF road and nothing else.
  //
  // 🔴 #367 BROKE THAT COINCIDENCE, AND THE BRANCH NOW ASKS THE QUESTION IT ACTUALLY MEANS.
  // The registry delegates a `gltf` read to the mounted clone, so `elsewhere` no longer
  // identifies glTF — it now means "the clone has not mounted YET", and a mounted glTF mesh
  // reads `ok`. One status was answering two questions: where the UVs come from, and where
  // the TEXTURE comes from. Only the first moved.
  //
  // The texture did not move because glTF materials have no data half at all (#389/#605):
  // `resolveEvaluatedMesh` gives a glTF mesh `EMPTY_ASSIGNMENT`, so the registry-backed arm
  // below resolves its texture to `none`. MEASURED, on a mounted clone carrying a base-colour
  // map: keyed on the status, the arm flipped and the UV editor's backdrop went from `ok`
  // with an image to `none` — and NOTHING IN THE SUITE REDDENED. The row below is what makes
  // that observable, because nothing else did.
  //
  // So the branch keys on the descriptor's own discriminant, which is the fact its body
  // already consumes two lines down. That is not the re-derived availability class #635
  // removed — it is a question about where this mesh's MATERIALS live, asked of the only
  // thing that can answer it.
  // 🔴 #1015 — KEYED ON THE CLONE ADDRESS, NOT ON THE KIND, AND THE SET HAS ACTUALLY DIVERGED.
  // The block below argued its way to the descriptor's own discriminant and that was right for
  // the question it was then asking. It is a NAMING TIER now: `availabilityOf` is `'clone'` for
  // a `gltf` descriptor AND for a `uvProject` that cannot materialise over one (#738/#786 — the
  // projection passes its source's availability through and `get()` delegates its read to the
  // source), so a projected imported mesh is drawn by the clone while its kind is `uvProject`.
  // `drawnByAssetClone`'s own doc names this trap; this is the third time and the first where a
  // kind test and the availability class select different sets.
  //
  // MEASURED, on a mounted clone carrying a base-colour map with a UV Project over it: the arm
  // fell through, the backdrop resolved `none` with a null image, and that is byte-identical to
  // a cube that genuinely has no map — the panel could neither show the texture nor say why it
  // was blank. `cloneAddressOf` answers WHICH child draws, by the same recursion that decides
  // whether one does, so the two cannot drift into disagreement.
  const cloneAddress = cloneAddressOf(geometry.descriptor);
  if (cloneAddress) {
    // glTF: both facets come from the loaded asset clone, keyed by the RESOLVED descriptor
    // rather than the node's params — so any node that resolves to a gltf-kind geometry
    // works, not just the GltfChild type.
    // #367 — NO CAST HERE ANY MORE, and the branch condition above is why. While this arm was
    // keyed on `uvRead.status === 'elsewhere'` the descriptor stayed a union, so reading
    // `assetRef` off it needed a widening cast — and that cast made two REQUIRED fields
    // optional, which grew two fallbacks for states the type cannot hold. One of them
    // (`childName` absent) would have answered with the whole asset's first mesh: a different
    // question, silently. Keying on the discriminant narrows the descriptor, so both fields
    // are `string` and both fallbacks are gone rather than merely unreachable.
    const clone = getGltfClone(cloneAddress.assetRef);
    if (!clone) return SPACE_LOADING;
    const sub = clone.getObjectByName(cloneAddress.childName);
    const geo = firstMeshGeometry(sub);
    return {
      uvs: geo ? { uvs: extractUVIslands(geo), status: 'ok' } : UV_NONE,
      texture: fromTexture(firstBaseColorMap(sub)) ?? TEX_NONE,
    };
  }

  // Registry-backed geometry. Procedural and primed share this arm because the resolver has
  // ALREADY made the read and typed its absence — nothing here re-derives what a miss means.
  return {
    uvs: uvSourceOf(mesh.uvRead),
    texture: textureSourceOf(primarySlotMaterial(mesh.materials)),
  };
}
