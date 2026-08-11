// #635 (ns-1) — UVs as a CORNER-domain attribute, with absence that says why.
//
// ── WHY A UV READ CANNOT ANSWER `null` ────────────────────────────────────────────────
//
// Three different situations produce "no UVs here", and they need three different responses
// from the consumer:
//
//   loading   — the bytes exist and are in flight (a baked geometry's OPFS read). WAIT.
//   elsewhere — this kind never keeps its buffers in the registry; they live in a loaded
//               asset clone. LOOK SOMEWHERE ELSE.
//   none      — there genuinely are none, and waiting will not help. RENDER UNTEXTURED.
//
// Collapsing `loading` into `none` makes an in-flight read indistinguishable from a mesh
// that has no UVs — the consumer renders untextured and calls it correct. That defect has
// already landed once, in the file that reads this one. So absence is typed, not nulled, and
// the reason is inherited from the registry's own availability model rather than re-derived
// here: one place knows the rule.
//
// ── WHY THE UV ATTRIBUTE IS FILLED ON THE READ ROAD, NOT AT EVALUATE ──────────────────
//
// `material_index` is derivable from params alone — every face on slot 0, and only the COUNT
// depends on the geometry. UV VALUES are not: they come out of the tessellation, and a pure
// synchronous `evaluate()` has no business tessellating. So the UV attribute is lifted off
// geometry the registry has ALREADY built, on the read road, and counted as `read` growth
// rather than as an evaluate.
//
// That is not the async road and must not be confused with it: nothing here awaits. When the
// bytes are not there yet the answer is `loading` and the loader hook primes the registry, at
// which point the next read finds them. Making this async to "just await the UVs" would
// invert the resolver's purity and turn every read-side consumer into a suspense boundary.
//
// REF: src/app/geometryRegistry.ts (`readGeometry` — the tri-state this inherits);
//      src/nodes/attributes.ts (`UV_MAP`); src/app/uvIslands.ts (the display projection);
//      src/app/resolveMeshUVSpace.ts (the consumer); issues #635, #633, #630.

import type { BufferAttribute, BufferGeometry } from 'three';
import { readGeometry } from './geometryRegistry';
import { insert } from './attributeStore';
import { extractUVIslands } from './uvIslands';
import { UV_MAP, type AttributeData } from '../nodes/attributes';
import { mintAttributes } from '../nodes/attributeKey';
import type { EvaluatedUVs, GeometryRef } from '../nodes/types';

/**
 * A mesh's UVs, or the reason there are none — the same four-way answer the geometry read
 * gives, because the UVs cannot be more available than the buffers they live in.
 */
export type MeshUVRead =
  | {
      readonly status: 'ok';
      /** The display projection (islands), for the UV editor. */
      readonly islands: EvaluatedUVs;
      /** The corner-domain attribute's content key, resident in the attribute store. */
      readonly attributeKey: string;
    }
  /** The buffers live in a loaded asset clone — ask it, not the registry. */
  | { readonly status: 'elsewhere' }
  /** The bytes exist but have not been read in yet. Waiting helps. */
  | { readonly status: 'loading' }
  /** There genuinely are none. Waiting does not help. */
  | { readonly status: 'none' };

const ELSEWHERE: MeshUVRead = { status: 'elsewhere' };
const LOADING: MeshUVRead = { status: 'loading' };
const NONE: MeshUVRead = { status: 'none' };

/** Lift the `uv` buffer off a built geometry as a corner-domain attribute, or `null`. */
function uvAttributeOf(geometry: BufferGeometry): AttributeData | null {
  const uv = geometry.getAttribute('uv') as BufferAttribute | undefined;
  if (!uv) return null;
  return {
    domain: 'corner',
    type: 'float2',
    count: uv.count,
    data: Float32Array.from(uv.array as ArrayLike<number>),
  };
}

/**
 * Read a mesh's UVs through the attribute system. Synchronous, and total: every arm returns
 * an answer that says what it is.
 */
export function readMeshUVs(ref: GeometryRef): MeshUVRead {
  const result = readGeometry(ref);
  switch (result.status) {
    case 'elsewhere':
      return ELSEWHERE;
    case 'pending':
      return LOADING;
    case 'none':
      return NONE;
    case 'ok': {
      const attribute = uvAttributeOf(result.geometry);
      // Built, and genuinely carrying no UV layer. Distinct from every arm above: this one
      // is an answer about the mesh, not about the read.
      if (attribute === null) return NONE;
      const minted = mintAttributes({ [UV_MAP]: attribute });
      if (minted === null) return NONE;
      insert(minted.key, minted.set, 'read');
      return {
        status: 'ok',
        islands: extractUVIslands(result.geometry),
        attributeKey: minted.key,
      };
    }
    default: {
      const unreachable: never = result;
      throw new Error(`readMeshUVs: undeclared read status ${JSON.stringify(unreachable)}`);
    }
  }
}
