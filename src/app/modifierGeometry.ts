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
  GeometryRef,
  InlineMaterialSpec,
  MirrorAxis,
  ObjectData,
  Vec3,
} from '../nodes/types';
import { evaluate } from '../core/dag/evaluator';
import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';

/**
 * The ONE place a box `size` becomes a box `GeometryRef` (deterministic key +
 * descriptor). It was shared by the fused `BoxMesh`'s source projection and by
 * `BoxData`; the fused kind is retired, so `BoxData` (#361) is the only caller left
 * and the "one cached build, byte-identical geometry" claim (H40, no drift) is now
 * held by construction rather than by two roads agreeing.
 */
export function boxGeometryRef(size: Vec3): GeometryRef {
  return {
    key: `box|${size[0]},${size[1]},${size[2]}`,
    kind: 'box',
    descriptor: { kind: 'box', size },
  };
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
): GeometryRef {
  return {
    key: `sphere|${radius}|${widthSegments}|${heightSegments}`,
    kind: 'sphere',
    descriptor: { kind: 'sphere', radius, widthSegments, heightSegments },
  };
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
 * Wrap a source `GeometryRef` in an `array` descriptor: `count` copies of the
 * source, each translated by `i*offset` in the source's LOCAL space, merged. The
 * key folds the source key + params so identical inputs share a registry-cached
 * build (and two different params never false-share, §48). count is clamped ≥1.
 */
export function arrayGeometryRef(source: GeometryRef, count: number, offset: Vec3): GeometryRef {
  const n = Math.max(1, Math.floor(count));
  return {
    key: `array|${source.key}|${n}|${offset[0]},${offset[1]},${offset[2]}`,
    kind: 'array',
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
    kind: 'mirror',
    descriptor: { kind: 'mirror', source, axis, offset },
  };
}
