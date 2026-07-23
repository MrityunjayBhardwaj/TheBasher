// modifierGeometry — the shared geometry-handle projection for the SOP / modifier
// half of [[V58]] (epic #201, #209). A geometry modifier is a `Mesh → Mesh`
// wrapper sub-chain node (the §2.2 model that did NOT fit constraints but DOES fit
// geometry ops, because a modifier needs only the mesh VALUE, never world
// position). It rewrites the source mesh's geometry into a NEW `GeometryRef`
// handle the registry rebuilds on demand (geometryRegistry.build → 'array' case).
//
// THE ONE PLACE that turns a mesh VALUE into a source `GeometryRef` + the ONE
// place that wraps a source ref in an `array` descriptor. Two consumers walk the
// chain on DIFFERENT roads — the DAG evaluator (`ArrayModifier.evaluate`, which
// has the resolved source VALUE) and the pure read-side walk
// (`resolveEvaluatedMesh`, which recurses on the source NODE). Both build the
// array key through `arrayGeometryRef`, so the rendered geometry and the resolved
// geometry share one deterministic key (H40 one-band, no drift) — asserted by the
// boundary-pair e2e + a key-equality unit test.
//
// v1 scope: box/sphere sources (the registry builds them SYNC). A glTF/baked
// source returns null here (its geometry is async — asset clone / OPFS — outside
// the sync registry); modifiers over those are a clean follow-up.
//
// REF: src/app/resolveEvaluatedMesh.ts (the recursive array branch);
//      src/app/geometryRegistry.ts (build 'array'); src/nodes/ArrayModifier.ts;
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §5 / §2.2; vyapti V58.

import type {
  BakedMaterialSpec,
  GeometryRef,
  InlineMaterialSpec,
  MeshTransform,
  MirrorAxis,
  SceneChild,
  Vec3,
} from '../nodes/types';
import { evaluate } from '../core/dag/evaluator';
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
      // stack → object transform; Houdini: SOP chain in object space → OBJ
      // transform). Wiring the stack into the data lane itself is the follow-on
      // increment; it needs every data kind to exist first (Stage C).
      const data = value.data;
      if (!data || data.kind !== 'MeshData') return null; // an Empty / non-mesh data
      return {
        geometry: data.geometry,
        transform: trsOf(value),
        // MeshData holds either spec; carry it verbatim (#358). ObjectR narrows a
        // baked data material to its fallback, so widening here is render-safe.
        material: data.material,
      };
    }
    // Not leaf meshes — a modifier passes through them unchanged (v1 scope).
    case 'GltfAsset':
    case 'Transform':
    case 'Null':
    case 'Curve':
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
  if (!state.nodes[nodeId]) return false;
  try {
    const value = evaluate(state, nodeId).value as SceneChild | undefined;
    return value ? modifierSource(value) !== null : false;
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
