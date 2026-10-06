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
//    returns ok / loading / none, inherited from the registry's own typed read
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

import type { Texture } from 'three';
import type { DagState } from '../core/dag/state';
import type { EvaluatorCache } from '../core/dag/evaluator';
import type { EvalCtx } from '../core/dag/types';
import type {
  BakedMaterialSpec,
  BakedTextureRef,
  EvaluatedUVs,
  InlineMaterialSpec,
} from '../nodes/types';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
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
  // #1053 — an EMPTY hash names no stored file (a clone road's imported-texture descriptor, whose
  // pixels lived only in the render clone, or an old save's "cleared" placeholder). Peeking one
  // starts a read that fails and raises the missing-image banner; there is nothing to show.
  if (!ref || ref.hash === '') return TEX_NONE;
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
 * Narrow the resolver's UV answer into this module's own facet. Written out rather than
 * defaulted, so a new status is a visible edit instead of a silent collapse into "no UVs".
 */
function uvSourceOf(read: MeshUVRead): UVSource {
  switch (read.status) {
    case 'ok':
      return { uvs: read.islands, status: 'ok' };
    case 'loading':
      return UV_LOADING;
    case 'none':
      return UV_NONE;
    default: {
      const unreachable: never = read;
      throw new Error(`uvSourceOf: undeclared UV read status ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Narrow the assignment's slot answer into this module's texture facet — the twin of
 * {@link uvSourceOf}. Taken through `primarySlotMaterial` rather than `primaryMaterial`, so an
 * absence stays an answer the switch below must name.
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
    default: {
      const unreachable: never = slot;
      throw new Error(`textureSourceOf: undeclared slot status ${JSON.stringify(unreachable)}`);
    }
  }
}

export function resolveMeshUVSpace(
  state: DagState,
  nodeId: string,
  cache?: EvaluatorCache,
): MeshUVSpace {
  const node = state.nodes[nodeId];
  if (!node) return SPACE_NONE;

  const mesh = resolveEvaluatedMesh(state, nodeId, STATIC_CTX, cache);

  if (!mesh) {
    // Nothing resolves a mesh here — a light, a camera, an Empty (a kept clone-road import is
    // one, #1053) — so there is nothing to show: `none`, not a `loading` that never ends.
    return SPACE_NONE;
  }

  // Registry-backed geometry. Procedural and primed share this arm because the resolver has
  // ALREADY made the read and typed its absence — nothing here re-derives what a miss means.
  const slot = primarySlotMaterial(mesh.materials);
  return {
    uvs: uvSourceOf(mesh.uvRead),
    texture: textureSourceOf(slot),
  };
}
