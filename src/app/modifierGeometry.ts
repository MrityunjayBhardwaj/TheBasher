// modifierGeometry — the shared geometry-handle projection for the SOP / modifier
// half of [[V58]] (epic #201, #209). A geometry modifier is a `data → data` sub-chain
// node (the §2.2 model that did NOT fit constraints but DOES fit geometry ops, because
// a modifier needs only the mesh VALUE, never world position). It rewrites the source
// mesh's geometry into a NEW `GeometryRef` handle the registry rebuilds on demand
// (geometryRegistry.build → 'array' case).
//
// THE ONE PLACE that turns a mesh value into a source `GeometryRef` + the ONE place
// that wraps a source ref in an `array` descriptor. #415 collapsed the two roads that
// used to walk the chain separately — the evaluator and a recursive read-side twin —
// so `modifierDataSource` is now asked by the modifier's `evaluate`, by the offer
// predicate, and by the read road alike. One classifier means "can this be modified?"
// cannot be answered two ways, which is what it was split into three switches to do
// before #377 consolidated it.
//
// #415 SLICE 4 FINISHED THAT COLLAPSE by deleting the last remnant of the old shape:
// `modifierSource`, the SceneObject-side classifier that took a posed scene value and
// returned geometry + material + a TRS to carry forward. The flip left it with no
// production callers and only its own tests, which is the state a dead function is
// hardest to see from ([[H219]]) — full coverage, green suite, zero callers. Its `never`
// gate and its baked/chained arms did not go with it; they live in `modifierDataSource`,
// which answers the same question of the data lane where the stack now sits.
//
// v1 scope: box/sphere data (the registry builds it SYNC). Baked data carries its
// material through but is not sync-buildable (OPFS — outside the sync registry);
// modifiers over it are a clean follow-up. Non-mesh data passes through untouched.
//
// REF: src/app/resolveEvaluatedMesh.ts (the modifier branch); src/app/operatorStack.ts
//      (the wiring authority); src/app/geometryRegistry.ts (build 'array');
//      src/nodes/ArrayModifier.ts; docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1;
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §5 / §2.2; vyapti V58; issue #415.

import type {
  BakedMaterialSpec,
  GeometryDescriptor,
  GeometryRef,
  InlineMaterialSpec,
  MirrorAxis,
  ObjectData,
  Vec3,
} from '../nodes/types';
import { evaluate } from '../core/dag/evaluator';
import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { dataSectionCapability } from './dataSectionCapability';
import { rebuiltMeshAttributes } from '../nodes/meshAttributes';

/**
 * The box descriptor for a size — the ONE spelling of that literal.
 *
 * Exported because two things need it and neither may re-spell it: this module's
 * {@link boxGeometryRef}, and the producer that has to mint the attribute set BEFORE
 * the handle exists (`BoxData.evaluate`). A second literal in the producer would agree
 * today and stop agreeing the first time the descriptor gains a field — with the face
 * count then derived from an incomplete descriptor, silently.
 */
export function boxDescriptor(size: Vec3): Extract<GeometryDescriptor, { kind: 'box' }> {
  return { kind: 'box', size };
}

/** The sphere descriptor — the ONE spelling, for the same reason as {@link boxDescriptor}. */
export function sphereDescriptor(
  radius: number,
  widthSegments: number,
  heightSegments: number,
): Extract<GeometryDescriptor, { kind: 'sphere' }> {
  return { kind: 'sphere', radius, widthSegments, heightSegments };
}

/**
 * Fold an attribute component into a geometry key, or leave the key alone — the ONE
 * place `GeometryRef.attributeKey` is written (#638, ns-1b step 3).
 *
 * ⚠️ `undefined` is REFUSED BY NAME, and that refusal is load-bearing rather than
 * defensive. `attributeKey` is a required parameter on the two primitive builders, so
 * production cannot omit it — but `npm run typecheck` does not see `*.test.*` and vitest
 * does not typecheck at all, so a test call site that never answered would arrive here as
 * `undefined`, take the fold branch, and produce a key ending `|a:undefined` beside a ref
 * whose `attributeKey` field is present-and-`undefined`. That object hashes differently
 * from one without the field, so every mesh value carrying it re-keys — a full cold start
 * with no error anywhere. A caller that has no attributes says `null` and means it.
 */
function withAttributeComponent(
  base: Omit<GeometryRef, 'attributeKey'>,
  attributeKey: string | null,
): GeometryRef {
  if (attributeKey === undefined) {
    throw new Error(
      `geometryRef: '${base.descriptor.kind}' was built without answering the attribute question — pass the minted key, or null for none`,
    );
  }
  // Absent, never present-and-undefined: the two are different objects to `Object.keys`
  // and to the value hash, and only one of them means "this geometry has no attributes".
  if (attributeKey === null) return base;
  return { ...base, key: `${base.key}|a:${attributeKey}`, attributeKey };
}

/**
 * The same geometry, carrying a DIFFERENT attribute component (#638, ns-1b step 6).
 *
 * An operator that writes a per-face assignment onto a source's geometry has to hand
 * downstream a handle whose key says so — otherwise two meshes with different assignments
 * collide onto one cached `BufferGeometry` and the group layout of whichever built first
 * wins. It cannot simply append: the source's key already carries ITS component (every
 * primitive mints a uniform one), so appending would produce `…|a:x|a:y`, a key that no
 * builder would ever mint and that names a geometry with two answers.
 *
 * The old component is removed by its own exact text rather than by parsing for `|a:` —
 * the ref's sibling field says precisely what was folded, so there is nothing to guess at
 * and no attribute key containing a delimiter can confuse it.
 */
export function refWithAttributeKey(ref: GeometryRef, attributeKey: string | null): GeometryRef {
  const carried = ref.attributeKey;
  const base =
    carried === undefined
      ? { key: ref.key, descriptor: ref.descriptor }
      : {
          key: ref.key.slice(0, ref.key.length - `|a:${carried}`.length),
          descriptor: ref.descriptor,
        };
  return withAttributeComponent(base, attributeKey);
}

/**
 * The ONE place a box `size` becomes a box `GeometryRef` (deterministic key +
 * descriptor). It was shared by the fused `BoxMesh`'s source projection and by
 * `BoxData`; the fused kind is retired, so `BoxData` (#361) is the only caller left
 * and the "one cached build, byte-identical geometry" claim (H40, no drift) is now
 * held by construction rather than by two roads agreeing.
 *
 * `attributeKey` is REQUIRED (#638). It is not defaulted, and the omission is what the
 * requirement exists to make unconstructible: the cache keys on `key` (a string) while
 * the group layout is derived from `attributeKey` (a sibling field), so correctness
 * needs `key ⇒ attributeKey` to be a function. A two-field split enforces nothing on its
 * own — any ref whose key carries a component its sibling does not, or the reverse,
 * breaks it silently. Minting both in one expression, in a function that cannot be
 * called without both, is the enforcement.
 */
export function boxGeometryRef(size: Vec3, attributeKey: string | null): GeometryRef {
  return withAttributeComponent(
    {
      key: `box|${size[0]},${size[1]},${size[2]}`,
      descriptor: boxDescriptor(size),
    },
    attributeKey,
  );
}

/**
 * The ONE place a sphere's `radius`/`widthSegments`/`heightSegments` become a
 * `GeometryRef` (deterministic key + descriptor). Parallel to {@link boxGeometryRef},
 * and its old note has come true: it named the fused `SphereMesh` projection and the
 * read road beside `SphereData` (#384), and predicted that "then only `SphereData`
 * calls it". `SphereMesh` is retired and the read road no longer rebuilds a handle of
 * its own (#415 — it reads the one the evaluator already produced), so that is now the
 * measured state, not a forecast.
 */
export function sphereGeometryRef(
  radius: number,
  widthSegments: number,
  heightSegments: number,
  attributeKey: string | null,
): GeometryRef {
  return withAttributeComponent(
    {
      key: `sphere|${radius}|${widthSegments}|${heightSegments}`,
      descriptor: sphereDescriptor(radius, widthSegments, heightSegments),
    },
    attributeKey,
  );
}

/**
 * Everything a geometry modifier needs from its source DATA: the handle to reshape
 * and the material to inherit. `null` from {@link modifierDataSource} means "this
 * value is not a modifiable source" — the modifier passes it through unchanged.
 *
 * There is NO pose here, and that absence is the point. On the data lane (#415) there
 * is none to take: the Object above the stack owns it, and a data node has none of its
 * own. Both references state it (Houdini S8: authored in object space, the transform
 * applied once above the stack; Blender 5.1.1 measured: the evaluated mesh datablock
 * has no `matrix_world`) — see `ModifiedDataValue` in src/nodes/types.ts. The
 * predecessor of this interface carried a `transform` field for the SceneObject-side
 * road, which is what #415 removed.
 */
export interface ModifierDataSource {
  readonly geometry: GeometryRef;
  readonly material: InlineMaterialSpec | BakedMaterialSpec | null;
}

/**
 * Project a resolved `ObjectData` value into the source a geometry modifier consumes
 * — THE ONE kind-dispatch for "is this data reshapeable, and with what?". `null` means
 * "not a mesh face" and the modifier passes the value through unchanged.
 *
 * #415 moved the modifier onto the data lane, so THIS is the classifier the modifier's
 * own `evaluate` asks, and the one `canModifyGeometry` and the read road ask too. It is
 * now the ONLY one: the SceneObject-side twin `modifierSource` — which answered the same
 * question of a posed scene value and delegated its `Object` arm here — was deleted once
 * the flip left it with no production callers. There is no second answer to keep in step.
 *
 * The switch is CLOSED BY A `never` ([[V109]]) — this is the same exhaustive guard
 * #388 installed in the twin, MOVED here rather than deleted, and it must stay
 * exhaustive for the same reason: an inequality guard (`data.kind !== 'MeshData'`) is
 * ALREADY TOTAL, so widening `ObjectData` cannot redden it and a genuinely mesh-like
 * new member gets absorbed in silence with the wrong answer. A new data kind is a
 * COMPILE ERROR here, which is the point.
 */
export function modifierDataSource(data: ObjectData): ModifierDataSource | null {
  switch (data.kind) {
    // `ModifiedData` is here for the CHAIN case — a modifier over a modifier's output,
    // which is the reason the stack composes at all: each operator reshapes the
    // cumulative result below it.
    case 'MeshData':
    case 'BakedData':
    case 'ModifiedData':
      // All three carry a rebuildable/authoritative handle + an inherited material.
      // `MeshData.material` is the narrower Inline|null (#388), which fits the wide
      // union verbatim; a baked or modified source's BakedMaterialSpec rides through
      // instead of dropping to null (#358).
      return { geometry: data.geometry, material: data.material };
    case 'CurveData':
    case 'LightData':
    case 'CameraData':
      // Not a mesh face — nothing for a geometry modifier to reshape. Measured, not
      // assumed: Blender 5.1.1 accepts 55 modifier types on a mesh and ZERO on a
      // camera or a light (`ref/GROUND_TRUTH_BLENDER_MODIFIER_DATA.md` §9).
      return null;
    default: {
      const exhaustiveData: never = data;
      void exhaustiveData;
      return null;
    }
  }
}

/**
 * Can a geometry modifier actually reshape the mesh produced by `nodeId`?
 *
 * This is the OFFER half of [[V108]]: the UI must gate "+ Add Modifier" on the
 * SAME condition the modifier's own `evaluate` accepts — literally by evaluating
 * the source and asking {@link modifierDataSource}, never by matching a list of node
 * types. The list it replaces (`SUPPORTED_BASE_TYPES`) had drifted both ways at
 * once: it still named `BoxMesh`, retired in Slice 2, and had never gained
 * `Object`, so the banner called a split cube unsupported while a fused relic was
 * still advertised. A predicate that asks the resolver cannot drift — a kind that
 * becomes modifiable is offered the day it lands, and one that retires stops being
 * offered the day it goes.
 */
export function canModifyGeometry(state: DagState, nodeId: string): boolean {
  const node = state.nodes[nodeId];
  if (!node) return false;
  // #415 — the stack lives on the DATA lane now, so the offer is a question about a
  // data node, not about a scene object. "Is this a data node?" is DERIVED from the
  // registry (does it emit the `ObjectData` socket?), never matched against a type
  // list: that is the same drift this predicate was written to end (#377 — the list it
  // replaced named a retired type AND missed a live one at the same time). A Group or
  // a glTF import fails here because it emits `SceneObject`, which is also why it can
  // no longer be WIRED to a modifier at all.
  const def = getNodeType(node.type);
  if (def?.outputs.out?.type !== 'ObjectData') return false;
  try {
    const value = evaluate(state, nodeId).value as ObjectData | undefined;
    return value ? modifierDataSource(value) !== null : false;
  } catch {
    // `evaluate` THROWS on a cycle, a dangling input ref, or the depth limit — and
    // this predicate runs during a React render, where the type-set lookup it
    // replaced could not throw at all. An un-evaluable source is not modifiable,
    // which is the honest answer AND the safe one: the banner explains itself
    // instead of the inspector panel unmounting mid-edit.
    return false;
  }
}

/**
 * The `ObjectData` KIND a node evaluates to, or null when it is not a data node or
 * cannot be evaluated.
 *
 * #498 — the offer needs the kind, not just the boolean {@link canModifyGeometry}
 * returns. That predicate answers false identically for a curve, a light and a camera,
 * and the panel has to say something different about a curve (a real gap, #349) than
 * about a camera (nothing to reshape, ever). Deliberately the SAME registry check and
 * the SAME try/catch as `canModifyGeometry` — it is the one road, asked for one more
 * fact, rather than a second way of finding out what a node is.
 *
 * ⚠️ CALL THIS FROM A COMPONENT BODY, NEVER FROM A STORE SELECTOR. It evaluates, and
 * `evaluate` hashes params BEFORE the cache lookup, so an uncached call is not free
 * ([[H48]] — a read-side resolver re-evaluating per inspector row is what produced the
 * measured ~458ms edit-lag on a heavy asset). A zustand selector runs on every store
 * change, including every playhead tick while playing.
 */
export function resolveDataKind(state: DagState, nodeId: string): ObjectData['kind'] | null {
  const node = state.nodes[nodeId];
  if (!node) return null;
  const def = getNodeType(node.type);
  if (def?.outputs.out?.type !== 'ObjectData') return null;
  try {
    const value = evaluate(state, nodeId).value as ObjectData | undefined;
    return value?.kind ?? null;
  } catch {
    return null;
  }
}

/**
 * Can a material operator actually be added over the data `nodeId` produces? (#394 S3d.)
 *
 * The material sibling of {@link canModifyGeometry}, and the difference in HOW it answers
 * is the point rather than an inconsistency. `canModifyGeometry` asks the modifier's own
 * accept (`modifierDataSource`) because a modifier reaches into the value and needs a
 * geometry handle out of it. A material operator reaches into no such thing — its `target`
 * socket takes `ObjectData` flat and its `evaluate` composes over whatever material is
 * there — so there is no resolver to ask, and asking the value would return "yes" for a
 * camera. The accept therefore IS the capability table, which is where the reference
 * measurement lives ([[V108]]: one phrasing, two readers).
 *
 * 'supported' only. A 'not-yet' kind (a curve, #528) still OFFERS the section with an
 * honest banner — that is {@link sectionAppliesToData}'s job — but adding an operator to
 * one today would mint an inert node, so the accept refuses it exactly as the modifier
 * road refuses a curve.
 *
 * ⚠️ Same evaluation cost as {@link resolveDataKind}: component bodies, never selectors.
 */
export function canWearMaterial(state: DagState, nodeId: string): boolean {
  const kind = resolveDataKind(state, nodeId);
  return kind !== null && dataSectionCapability(kind, 'material').state === 'supported';
}

/**
 * Wrap a source `GeometryRef` in an `array` descriptor: `count` copies of the
 * source, each translated by `i*offset` in the source's LOCAL space, merged. The
 * key folds the source key + params so identical inputs share a registry-cached
 * build (and two different params never false-share, §48). count is clamped ≥1.
 */
export function arrayGeometryRef(source: GeometryRef, count: number, offset: Vec3): GeometryRef {
  const n = Math.max(1, Math.floor(count));
  return {
    key: `array|${source.key}|${n}|${offset[0]},${offset[1]},${offset[2]}`,
    descriptor: { kind: 'array', source, count: n, offset },
  };
}

/**
 * Wrap a source `GeometryRef` in a `mirror` descriptor: reflect the source across
 * the plane through the LOCAL origin whose normal is `axis`, then merge the
 * reflection back with the original (Blender's Mirror → a symmetric whole, 2× the
 * vertices). The key folds the source key + axis so identical inputs share a
 * registry-cached build and two axes never false-share (§48). The ONE place a
 * source ref becomes a mirror descriptor.
 *
 * It used to be called on BOTH roads — `MirrorModifier.evaluate` and the read-side
 * walk in `resolveEvaluatedMesh`, which rebuilt the handle itself and relied on the
 * two agreeing (H40, no drift). #415 removed the second caller: the read road now
 * reads the handle the evaluator already produced, so the roads share the VALUE
 * rather than a recipe for reproducing it. Same invariant, one fewer place to break.
 */
export function mirrorGeometryRef(
  source: GeometryRef,
  axis: MirrorAxis,
  offset: number,
): GeometryRef {
  return {
    key: `mirror|${source.key}|${axis}|${offset}`,
    descriptor: { kind: 'mirror', source, axis, offset },
  };
}

// ── #537 — REBUILDING A HANDLE THE ANIMATION OVERLAY HAS WRITTEN THROUGH ───────────────
//
// The four builders above are called by the EVALUATOR, once per evaluation, from the node's
// params. The render-time overlay does not re-evaluate: it clones the evaluated value and
// writes the animated param at its param path. For material that lands on the value and is
// read (#536 S1 kept the IR inline for exactly this reason). For geometry it lands on a
// field nothing consumes — `MeshDataValue` has no `size`; it has a `GeometryRef`, and the
// renderer draws through `getForAttach(data.geometry)`. Hence the freeze (#537).
//
// So the overlay owes the handle the same debt it owes an identity key, with the opposite
// repair. A material key can be CLEARED because its consumer re-derives from the spec it
// still holds; a geometry ref cannot, because the registry needs a descriptor to build
// ANYTHING and a null ref draws nothing. The repair is to fold the written params into the
// descriptor and re-mint — through the builders above, so a key still has one spelling.

/**
 * The descriptor fields a node's PARAMS feed, i.e. the ones an animated channel can write.
 *
 * Derived from the descriptor itself rather than tabulated per kind, because a table would
 * be a second enumeration of the same fields and would go stale the first time a descriptor
 * gained one. Two exclusions, both structural:
 *   `kind`   — the discriminant, not a param.
 *   `source` — a nested handle carrying ANOTHER producer's identity. A modifier animates its
 *              own `count`, never its input; rebuilding a source from a param write would
 *              overwrite someone else's minted key with this node's guess.
 *
 * The correspondence this rests on — a descriptor field is named exactly like the param that
 * feeds it — is not assumed. `geometryHandleReach.gate.test.ts` checks it against each
 * producing node's own param schema, so a descriptor field that no param can reach (or a
 * rename that breaks the pairing) is a red rather than a silent freeze.
 */
export function descriptorParamFields(descriptor: GeometryDescriptor): readonly string[] {
  return Object.keys(descriptor).filter((k) => k !== 'kind' && k !== 'source');
}

/**
 * Messages already reported, so a per-frame drag says a thing once instead of once per
 * frame. Bounded by DISTINCT (old count → new count) pairs, which is the same bound the
 * attribute store's own growth has — not by frames.
 */
const reportedRebinds = new Set<string>();

/** The rebuilt handle's attribute key, reporting once if an assignment had to be dropped. */
function reboundAttributeKey(ref: GeometryRef, rebuilt: GeometryDescriptor): string | null {
  const { key, reason } = rebuiltMeshAttributes(ref.attributeKey, rebuilt);
  if (reason !== null && !reportedRebinds.has(reason)) {
    reportedRebinds.add(reason);
    console.warn(reason);
  }
  return key;
}

/**
 * Re-mint `ref` with `values` folded into its descriptor, through the same builder the
 * evaluator used. Returns `ref` UNCHANGED (by reference) when `values` names nothing the
 * descriptor is built from — the caller uses that to avoid touching a handle a write never
 * reached.
 *
 * ⚠️ `gltf` and `baked` are deliberately returned untouched rather than rebuilt, and this is
 * the one arm worth reading twice. Their identity does not come from params at all — a glTF
 * child is keyed by (assetRef, childName) and a baked geometry by the CONTENT HASH of bytes
 * in OPFS, which is authoritative and not rebuildable from anything on the value. Minting a
 * key for either here would be a second spelling of a key this module does not own, and for
 * `baked` it would be a fabricated hash pointing at bytes that do not exist.
 *
 * ── #638 — THE BOX AND SPHERE ARMS NOW WRITE TO THE ATTRIBUTE STORE ───────────────────
 *
 * They RE-MINT the attribute component from the REBUILT descriptor rather than carrying the
 * old one, which is the same rule the doc line above already states: re-mint through the
 * same builder the evaluator used. Under the required attribute parameter, the evaluator's
 * call is `boxGeometryRef(size, mintMeshAttributes(..., 'evaluate'))`, so doing anything else here would
 * be the exception. `rebuiltMeshAttributes` owns the three-arm decision and the reason it
 * reports; see it for why carrying forward is wrong for a sphere in particular.
 *
 * Three consequences, stated rather than left to be discovered:
 *
 *   1. THIS FUNCTION NOW HAS A SIDE EFFECT. `mintMeshAttributes` inserts into the attribute
 *      store, and this runs per frame during a drag. The insert is content-keyed and
 *      idempotent — a second insert of an equal set is a hit — so re-deriving per frame
 *      costs nothing extra in the store. Safe is not the same as undocumented.
 *   2. The insertions are tagged with their own growth origin (`overlay`), so the two
 *      producers of a mesh attribute set stay countable apart. Growth here is bounded by
 *      DISTINCT integer segment counts, not by frames: a 121-frame drag over
 *      `widthSegments` 8→32 touches at most 25 distinct sets.
 *   3. THE BY-REFERENCE CONTRACT IS UNCHANGED, and that was checked rather than assumed.
 *      The only path that returns `ref` itself is the empty-`values` early return below,
 *      which runs BEFORE any arm — so the insert only ever happens on paths that were
 *      already minting a new object, and `rebuildInvalidatedHandles`'s `rebuilt !== ref`
 *      test still means exactly what it meant.
 */
export function rebuildGeometryRef(
  ref: GeometryRef,
  values: Readonly<Record<string, unknown>>,
): GeometryRef {
  if (Object.keys(values).length === 0) return ref;
  const d = ref.descriptor;
  switch (d.kind) {
    case 'box': {
      const size = (values.size ?? d.size) as Vec3;
      return boxGeometryRef(size, reboundAttributeKey(ref, boxDescriptor(size)));
    }
    case 'sphere': {
      // Each field falls back to what the descriptor already holds, so animating one of the
      // three does not reset the other two.
      const rebuilt = sphereDescriptor(
        (values.radius ?? d.radius) as number,
        (values.widthSegments ?? d.widthSegments) as number,
        (values.heightSegments ?? d.heightSegments) as number,
      );
      return sphereGeometryRef(
        rebuilt.radius,
        rebuilt.widthSegments,
        rebuilt.heightSegments,
        reboundAttributeKey(ref, rebuilt),
      );
    }
    case 'array':
      return arrayGeometryRef(
        d.source,
        (values.count ?? d.count) as number,
        (values.offset ?? d.offset) as Vec3,
      );
    case 'mirror':
      return mirrorGeometryRef(
        d.source,
        (values.axis ?? d.axis) as MirrorAxis,
        (values.offset ?? d.offset) as number,
      );
    case 'gltf':
    case 'baked':
      return ref;
    default: {
      const exhaustive: never = d;
      void exhaustive;
      return ref;
    }
  }
}
