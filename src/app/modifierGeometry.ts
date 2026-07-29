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
  MeshTransform,
  MirrorAxis,
  ObjectData,
  SceneChild,
  Vec3,
} from '../nodes/types';
import { evaluate } from '../core/dag/evaluator';
import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';

const IDENTITY_SCALE: Vec3 = [1, 1, 1];

/**
 * The ONE place a box `size` becomes a box `GeometryRef` (deterministic key +
 * descriptor). Shared by the fused `BoxMesh` source projection (below) AND the
 * `BoxData` node of the object↔data split (#361), so both roads hand the registry
 * the identical key → one cached build, byte-identical geometry (H40, no drift).
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
 * `GeometryRef` (deterministic key + descriptor). Parallel to {@link boxGeometryRef}:
 * shared by the fused `SphereMesh` source projection (below) + the read road
 * (`resolveEvaluatedMesh`) AND the `SphereData` node of the object↔data split (#384),
 * so every road hands the registry the identical key → one cached build,
 * byte-identical geometry (H40, no drift). Coexists with `SphereMesh` until the
 * fused value kind retires; then only `SphereData` calls it.
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
 * Everything a geometry modifier needs from its source value: the handle to
 * reshape, the pose to carry forward so the result sits where the source sat, and
 * the material to inherit. `null` from {@link modifierSource} means "this value is
 * not a modifiable source" — the modifier passes through unchanged.
 */
export interface ModifierSource {
  readonly geometry: GeometryRef;
  readonly transform: MeshTransform;
  readonly material: InlineMaterialSpec | BakedMaterialSpec | null;
}

/**
 * Everything a geometry modifier needs from its source DATA — the same thing minus
 * the pose, because on the data lane (#415) there is no pose to take: the Object
 * above the stack owns it, and a data node has none of its own. Both references
 * state it (Houdini S8: authored in object space, the transform applied once above
 * the stack; Blender 5.1.1 measured: the evaluated mesh datablock has no
 * `matrix_world`) — see `ModifiedDataValue` in src/nodes/types.ts.
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
 * own `evaluate` asks, and the one `canModifyGeometry` and the read road ask too. The
 * SceneObject-side twin {@link modifierSource} delegates its `Object` arm here — it has
 * no production callers left, so that delegation is now the only thing keeping the two
 * answers provably identical while it waits to be deleted.
 *
 * The switch is CLOSED BY A `never` ([[V109]]) — this is the same exhaustive guard
 * #388 installed in `modifierSource`, MOVED here rather than deleted, and it must stay
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
 * ⚠️ NO PRODUCTION CALLERS AS OF #415 — SLICE 4 DELETES THIS. Read that before treating
 * its test coverage as evidence it is load-bearing.
 *
 * The modifier used to consume a scene VALUE, so this was the classifier its `evaluate`
 * asked. On the data lane it asks {@link modifierDataSource} instead, and
 * `canModifyGeometry` and the read road followed. What is left is a function exercised
 * only by `modifierGeometry.test.ts` — which is exactly the shape that survives longest
 * unnoticed ([[H219]]: a retired thing lives on wherever it was never the subject). It is
 * kept for one slice rather than deleted here because #415 slice 4 collapses the whole
 * read road together, with its own falsification; deleting it mid-flip would enlarge an
 * already atomic commit for no gain. If slice 4 slips, this note is the reason to come
 * back — not a reason to keep it.
 *
 * Project a resolved mesh VALUE into the source a modifier consumes — THE ONE
 * kind-dispatch for "can this be modified, and with what?".
 *
 * It was three separate switches over one union (geometry / transform / material),
 * which is the parallel-list shape [[V101]] warns about: the object↔data split
 * added an `Object` arm to the read road (`resolveEvaluatedMesh`) and to none of
 * these, so a modifier on a split cube RESOLVED as an array and RENDERED as a
 * plain cube — the two roads disagreed with nothing to catch it (#377). One
 * classifier means a new kind is answered once or not at all, never half.
 *
 * The switch is CLOSED BY A `never` ([[V109]]): adding a `SceneChild` kind is a
 * COMPILE ERROR here, not a silent passthrough. Do NOT reintroduce a `default:` —
 * the defensive-looking arm is precisely the bug. Stage C puts five more data
 * kinds behind `Object`, and every one of them must land here deliberately.
 *
 * Sphere/Box build the SAME deterministic key `resolveEvaluatedMesh` builds (so
 * the array key matches on both roads); BakedMesh/ModifiedMesh already carry a
 * handle (chained modifiers); an `Object` reaches THROUGH its `data` socket for
 * geometry+material while keeping its OWN TRS — the same reach the read road does,
 * so read==render by construction.
 */
export function modifierSource(value: SceneChild): ModifierSource | null {
  switch (value.kind) {
    case 'ModifiedMesh':
      return { geometry: value.geometry, transform: trsOf(value), material: value.material };
    case 'BakedMesh':
      // A baked source carries its captured BakedMaterialSpec (scalars + maps).
      // ModifiedMeshValue.material was widened to that union (#358), so the material
      // now rides through verbatim instead of dropping to null. RENDERING a baked
      // material on a modifier is the deferred baked-sourced-modifier follow-up (the
      // array geometry over a baked ref is not sync-buildable either); ModifiedMeshR
      // narrows a baked spec to its fallback exactly as ObjectR does.
      return { geometry: value.geometry, transform: trsOf(value), material: value.material };
    case 'Object': {
      // The object↔data split (#377): the Object owns the pose, the data node owns
      // geometry + material. Reach through `data` — the modifier reshapes the mesh
      // DATA and inherits the OBJECT's TRS, which is the attachment the design and
      // both references agree on (Blender: mesh datablock → the Object's modifier
      // stack → object transform; Houdini: SOP chain in object space → OBJ transform).
      //
      // #415 — the `data.kind` dispatch that used to be written out HERE now lives in
      // {@link modifierDataSource}, because the modifier's own `evaluate` asks the same
      // question of the same union on the data lane. It was MOVED, not weakened: it is
      // still the one `never`-closed switch, so a new `ObjectData` member is still a
      // compile error rather than a silently missing "+ Add Modifier". Delegating is
      // what makes "can I modify this?" impossible to answer two ways.
      const data = value.data;
      if (!data) return null; // an Empty
      const src = modifierDataSource(data);
      if (!src) return null;
      // Substance off the data, pose off the Object — the split's whole shape.
      return { geometry: src.geometry, transform: trsOf(value), material: src.material };
    }
    // Not leaf meshes — a modifier passes through them unchanged (v1 scope).
    case 'GltfAsset':
    case 'Transform':
    case 'Null':
    case 'Group':
    case 'MaterialOverride':
    case 'Scatter':
    case 'Character':
      return null;
    default: {
      const exhaustive: never = value;
      void exhaustive;
      return null;
    }
  }
}

/**
 * Can a geometry modifier actually reshape the mesh produced by `nodeId`?
 *
 * This is the OFFER half of [[V108]]: the UI must gate "+ Add Modifier" on the
 * SAME condition the modifier's own `evaluate` accepts — literally by evaluating
 * the source and asking {@link modifierSource}, never by matching a list of node
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

/** The full TRS band of a value that carries one, with the C-1 (V10/H14) hydrate guard. */
function trsOf(value: { position: Vec3; rotation: Vec3; scale: Vec3 }): MeshTransform {
  return {
    position: value.position,
    rotation: value.rotation,
    scale: value.scale ?? IDENTITY_SCALE,
  };
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
 * source ref becomes a mirror descriptor — both the evaluate road
 * (`MirrorModifier.evaluate`) and the read-side walk (`resolveEvaluatedMesh`) call
 * it → one deterministic key on both roads (H40, no drift).
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
