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

import type { BufferAttribute } from 'three';
import { readGeometry } from './geometryRegistry';
import { polygonLayoutOf } from './polygonLayout';
import { insert } from './attributeStore';
import { extractUVIslands } from './uvIslands';
import { UV_MAP, type AttributeData } from '../nodes/attributes';
import { mintAttributes } from '../nodes/attributeKey';
import type { EvaluatedUVs, GeometryDescriptor, GeometryRef } from '../nodes/types';

/**
 * A mesh's UVs, or the reason there are none — the same four-way answer the geometry read
 * gives, because the UVs cannot be more available than the buffers they live in.
 */
/**
 * Where the corner-domain UV layer is, or why there is none — #776.
 *
 * Typed rather than nulled, for the reason the whole module is: the layer can be absent while
 * the ISLANDS are present, and a `null` key beside a drawable projection would read as "this
 * mesh has no UVs" at a call site that can see them on screen.
 */
export type UVAttributeVerdict =
  /** Minted and resident in the attribute store, under this content key. */
  | { readonly kind: 'resident'; readonly key: string }
  /** The buffer is there and cannot be expressed at the corner domain; this says why. */
  | { readonly kind: 'not-derivable'; readonly why: string };

export type MeshUVRead =
  | {
      readonly status: 'ok';
      /** The display projection (islands), for the UV editor. */
      readonly islands: EvaluatedUVs;
      /** The corner-domain layer, or the named reason it could not be lifted. */
      readonly attribute: UVAttributeVerdict;
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

/**
 * Lift the `uv` buffer off a built geometry as a corner-domain attribute.
 *
 * 🔴 #776 — THIS USED TO HAND BACK `uv.count` AND CALL IT A CORNER COUNT, WHICH WAS FALSE FOR
 * EVERY SHAPE THAT IS NOT A BOX. `uv.count` is the SPLIT RENDER VERTEX count. A box has 24 of
 * those and 24 loops, so the label passed every test it had; an 8x6 sphere has 63 render
 * vertices against 176 loops, and the attribute declared 63 elements at a domain with 176. The
 * model's own rule — *"an attribute at a domain must carry exactly as many elements as that
 * domain has"* — was being broken by one of its four producers, silently, because nothing in
 * production reads this key and nothing checked the count against the domain.
 *
 * So the buffer is GATHERED through the polygon rims instead of copied: loop `k` of face `f`
 * names split vertex `rim[k]`, and its UV is that vertex's. A render vertex serving several
 * loops is read several times, which is exactly what materialisation deduplicated on the way
 * in — this is that quotient undone, and it is why the sphere grows from 63 to 176.
 *
 * ⚠️ IT IS NOT THE INVERSE OF A LOSSLESS MAP, and that is worth saying because the round trip
 * looks total. Going back the other way — a per-loop layer to a render buffer — is many-to-one
 * and only collapses when the loops at one vertex AGREE. Authoring a layer where they do not
 * needs vertex splitting, which is a tessellation change and is #786 rather than this.
 */
function uvAttributeOf(
  uv: BufferAttribute,
  descriptor: GeometryDescriptor,
): AttributeData | UVAttributeVerdict {
  const layout = polygonLayoutOf(descriptor);
  if (layout.kind !== 'laid-out')
    // 🔑 PROPAGATED VERBATIM, NEVER RE-WORDED — the discipline `edgeCountOf` keeps one domain
    // over. `polygonLayoutOf` refuses for two unrelated reasons: a derived kind's rim needs a
    // SPLIT vertex count only a built geometry has (`not-yet`, until #777), and a `gltf` or
    // `baked` keeps its buffers outside the descriptor entirely (`outside-the-descriptor`,
    // permanent). Minting one message here would have to pick one of them, and the first draft
    // of this did: it cited #777 at every arm, so a PRIMED baked mesh — which reaches this line,
    // the registry having built it — would have named an issue that has nothing to do with it.
    //
    // ⚠️ AND #777 IS WHY THIS MATTERS RATHER THAN BEING TIDINESS. This is that refusal's FIRST
    // BLOCKED consumer: every previous caller wanted something composing without a derived rim
    // — an arity, a welded rim — and a UV cannot, because it lives on a SPLIT vertex. The
    // `until` travels with the reason so the issue number is the layout's to state, not this
    // module's to remember.
    return {
      kind: 'not-derivable',
      why: layout.kind === 'not-yet' ? `${layout.why} — until ${layout.until}` : layout.why,
    };

  const components = 2;
  let corners = 0;
  for (const rim of layout.polygons) corners += rim.length;
  const data = new Float32Array(corners * components);
  let at = 0;
  for (const rim of layout.polygons) {
    for (const vertex of rim) {
      data[at] = uv.getX(vertex);
      data[at + 1] = uv.getY(vertex);
      at += components;
    }
  }
  return { domain: 'corner', type: 'float2', count: corners, data };
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
      // Built, and genuinely carrying no UV layer. Distinct from every arm above: this one is
      // an answer about the mesh, not about the read — and it is asked HERE rather than inside
      // the lift, so that "no buffer" and "a buffer this descriptor cannot place on a corner"
      // stay two answers to two questions.
      const uv = result.geometry.getAttribute('uv') as BufferAttribute | undefined;
      if (!uv) return NONE;

      // 🔴 THE ISLANDS DO NOT WAIT ON THE ATTRIBUTE, AND THEY USED TO. Before #776 a failure to
      // lift the layer returned `none`, which is the status meaning "there genuinely are no UVs
      // and waiting will not help" — on a mesh whose UV editor can draw them. The projection
      // comes off the built geometry directly and has never needed the attribute; the two are
      // reported separately now because exactly one of them can be absent on its own.
      const islands = extractUVIslands(result.geometry);
      const lifted = uvAttributeOf(uv, ref.descriptor);
      if ('kind' in lifted) return { status: 'ok', islands, attribute: lifted };

      const minted = mintAttributes({ [UV_MAP]: lifted });
      if (minted === null)
        return {
          status: 'ok',
          islands,
          attribute: { kind: 'not-derivable', why: 'the corner-domain layer would not mint' },
        };
      insert(minted.key, minted.set, 'read');
      return { status: 'ok', islands, attribute: { kind: 'resident', key: minted.key } };
    }
    default: {
      const unreachable: never = result;
      throw new Error(`readMeshUVs: undeclared read status ${JSON.stringify(unreachable)}`);
    }
  }
}
