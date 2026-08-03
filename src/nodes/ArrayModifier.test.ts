// ArrayModifier — the first geometry MODIFIER (SOP), the geometry half of V58
// (epic #201, #209). Proves: mesh data in → `ModifiedData` carrying an `array` geometry
// handle + INHERITED material; mute = identity passthrough; non-mesh data passes
// through; and — the unit-level boundary-pair — the `array` geometry KEY the node's
// evaluate emits is BYTE-IDENTICAL to the key the read-side `resolveEvaluatedMesh`
// derives for the same wired chain (H40, no drift).
//
// #415 RE-AIMED EVERY FIXTURE HERE, and the interesting one is what it DELETED. These
// cases used to feed the modifier a scene value (an `Object`, a `BakedMesh`, a
// `Transform`) and assert `out.position` came back — the modifier inheriting its
// source's pose. On the data lane there is no pose to inherit: the modifier takes DATA,
// which has none, and the Object above the stack owns it. So the TRS assertions are not
// merely moved, they are INVERTED — the output is asserted to carry no pose at all.
// That is the one behavioural claim of the whole slice, and a fixture that quietly kept
// feeding scene values would have gone on passing while asserting the opposite.
//
// REF: src/nodes/ArrayModifier.ts; src/app/modifierGeometry.ts (`modifierDataSource`);
//      src/app/resolveEvaluatedMesh.ts (the modifier branch); vyapti V58; issue #415.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from './registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { resolveEvaluatedMesh } from '../app/resolveEvaluatedMesh';
import * as geometryRegistry from '../app/geometryRegistry';
import { sphereGeometryRef } from '../app/modifierGeometry';
import { hydrateInlineMaterial } from './materialSchema';
import { makeSplitSphere } from '../test-utils/splitSphere';
import { buildAddModifierOps, resolveStackBase } from '../app/operatorStack';
import { ArrayModifierNode } from './ArrayModifier';
import type {
  BakedDataValue,
  CurveDataValue,
  MeshDataValue,
  ModifiedDataValue,
  ObjectData,
} from './types';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** #415 — the modifier's source is DATA now, so the fixture is the data value itself.
 *  It used to be the whole `Object` wrapping it, because the modifier used to consume a
 *  scene value; the Object it was wrapped in is exactly what the split took away. */
function sphereData(): MeshDataValue {
  return {
    kind: 'MeshData',
    geometry: sphereGeometryRef(1, 8, 6),
    material: hydrateInlineMaterial(null, '#888888'),
  };
}

function evalMod(
  params: { count: number; offset: [number, number, number]; muted: boolean },
  target: ObjectData | undefined,
): ObjectData | undefined {
  return ArrayModifierNode.evaluate(params, { target }, ctx) as ObjectData | undefined;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('ArrayModifier.evaluate', () => {
  it('mesh data → ModifiedData with an array geometry handle + inherited material', () => {
    const src = sphereData();
    const out = evalMod({ count: 3, offset: [2, 0, 0], muted: false }, src) as ModifiedDataValue;
    expect(out.kind).toBe('ModifiedData');
    expect(out.geometry.kind).toBe('array');
    expect(out.geometry.descriptor).toMatchObject({ kind: 'array', count: 3, offset: [2, 0, 0] });
    // INHERITED — the material rides through from the source data (#358).
    expect(out.material).toBe(src.material);
  });

  // #415 — THE SUBTRACTION, asserted rather than assumed. `ModifiedData` is
  // `ModifiedMesh` MINUS the TRS: the modifier authors in local space and the Object
  // above the stack applies the pose once, so carrying one here would re-fuse exactly
  // what the split separated. Blender 5.1.1 measured (GT §3): an evaluated mesh
  // datablock has no `matrix_world` and no `location`; Houdini states it (S8).
  it('carries NO pose — a data node has none to carry (the subtraction that defines the kind)', () => {
    const out = evalMod({ count: 3, offset: [2, 0, 0], muted: false }, sphereData());
    expect(out).not.toHaveProperty('position');
    expect(out).not.toHaveProperty('rotation');
    expect(out).not.toHaveProperty('scale');
    // Exactly the three keys the kind declares — so a pose cannot creep back in unnamed.
    expect(Object.keys(out!).sort()).toEqual(['geometry', 'kind', 'material']);
  });

  it('muted → identity passthrough (byte-identical to no modifier — the stack mute-bypass)', () => {
    const src = sphereData();
    const out = evalMod({ count: 5, offset: [2, 0, 0], muted: true }, src);
    expect(out).toBe(src); // same reference — no ModifiedData produced
  });

  it('non-mesh data (a curve) passes through unchanged — nothing to reshape', () => {
    // Measured, not assumed: Blender accepts 55 modifier types on a mesh and 0 on a
    // camera or light; a curve takes 28, none of which is Array (GT §9).
    const curve: CurveDataValue = {
      kind: 'CurveData',
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      samples: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      closed: false,
    };
    const out = evalMod({ count: 3, offset: [2, 0, 0], muted: false }, curve);
    expect(out).toBe(curve);
  });

  it('an unwired source (undefined) stays transparent (no crash)', () => {
    expect(evalMod({ count: 3, offset: [2, 0, 0], muted: false }, undefined)).toBeUndefined();
  });

  // #258 — the null-geom precondition the renderer's V38 surfacing depends on.
  // A BAKED source produces a real ModifiedMesh (baked passes sourceGeometryRef,
  // unlike glTF which passes THROUGH), but its geometry is an `array` over a
  // `baked` ref whose OPFS bytes aren't primed → geometryRegistry.get returns null.
  // ModifiedMeshR has no prime path, so this is a PERSISTENT blank the renderer
  // must surface (ex-silent). This locks that a baked-sourced modifier is exactly
  // the reachable null-geom case.
  it('baked data → ModifiedData whose geometry is null-until-primed (the #258 blank)', () => {
    __resetRegistryForTests();
    geometryRegistry.clear();
    const baked: BakedDataValue = {
      kind: 'BakedData',
      geometry: {
        key: 'baked|deadbeef-8',
        kind: 'baked',
        descriptor: { kind: 'baked', hash: 'deadbeef', vertexCount: 8 },
      },
      material: {
        materialClass: 'standard',
        color: '#ff8800',
        roughness: 0.4,
        metalness: 0.1,
        opacity: 1,
        transparent: false,
        emissive: '#000000',
        emissiveIntensity: 0,
        map: null,
        normalMap: null,
        roughnessMap: null,
        metalnessMap: null,
        aoMap: null,
        emissiveMap: null,
      },
    };
    const out = evalMod({ count: 3, offset: [2, 0, 0], muted: false }, baked) as ModifiedDataValue;
    expect(out.kind).toBe('ModifiedData'); // real modified data (not a passthrough)
    expect(out.geometry.kind).toBe('array');
    // #358 — the baked material rides through the modifier verbatim (it was silently
    // dropped to null before: a ModifiedMesh could not hold a BakedMaterialSpec).
    expect(out.material).toBe(baked.material);
    // The array wraps the unprimed baked ref → the registry cannot build it sync.
    // (Rendering a baked-sourced modifier — geometry AND material — is the deferred
    // follow-up; this test locks the VALUE-level material fix independent of that.)
    expect(geometryRegistry.getForRead(out.geometry)).toBeNull();
  });
});

describe('ArrayModifier — read-side parity (boundary-pair)', () => {
  // The source is a split sphere: an `Object` (SPHERE_ID) posing a `SphereData`.
  //
  // #415 — the chain is spliced onto the DATA node, and deliberately through the real
  // `buildAddModifierOps` rather than by hand-wiring two `connect` ops. Hand-wiring is
  // what these cases used to do, and post-flip it would have been the one place in the
  // suite still describing the old topology from memory. Going through the production
  // builder means this file cannot drift from what the panel actually does.
  const SPHERE_ID = 'n_sphere';
  const SPHERE_DATA = 'n_sphere_data';
  function withSphere() {
    return makeSplitSphere(buildDefaultDagState(), {
      objectId: SPHERE_ID,
      dataId: SPHERE_DATA,
      radius: 1,
      widthSegments: 8,
      heightSegments: 6,
      connectTo: { node: 'n_scene', socket: 'children' },
    }).state;
  }

  /** Splice a modifier onto the sphere's data lane, the way the panel does. */
  function withMod(muted: boolean) {
    const state = withSphere();
    const res = buildAddModifierOps(state, resolveStackBase(state, SPHERE_ID), 'ArrayModifier', {
      count: 4,
      offset: [3, 0, 0],
      muted,
    });
    expect(res).not.toBeNull();
    return {
      state: res!.ops.reduce((s, op) => applyOp(s, op).next, state),
      id: res!.modifierId,
    };
  }

  it('resolveEvaluatedMesh derives the SAME array geometry key the evaluate path emits', () => {
    const { state, id } = withMod(false);
    // POSSESSION (H218): the modifier really is BETWEEN the data and the Object — not
    // in front of it. Without this the key equality below would still pass on a chain
    // wired the old way, which is exactly the assertion that stopped discriminating.
    expect(state.nodes[id].inputs.target).toMatchObject({ node: SPHERE_DATA, socket: 'out' });
    expect(state.nodes[SPHERE_ID].inputs.data).toMatchObject({ node: id, socket: 'out' });

    const resolved = resolveEvaluatedMesh(state, id, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.geometry.kind).toBe('array');
    // The modified geometry is sync-buildable → real UV islands (not null), so the
    // UV-editor backdrop works for a modifier (#209 follow-up).
    expect(resolved!.uvs).not.toBeNull();
    expect(resolved!.uvs!.islands.length).toBeGreaterThan(0);

    // The evaluate path projects the SAME sphere data with the same params.
    const evald = evalMod(
      { count: 4, offset: [3, 0, 0], muted: false },
      sphereData(),
    ) as ModifiedDataValue;
    expect(resolved!.geometry.key).toBe(evald.geometry.key); // byte-identical → no drift
  });

  it('the read side takes its pose from the OBJECT, not from the source data', () => {
    // #415 — the modifier has no transform of its own and its source has none either,
    // so "where does a selected modifier's mesh sit?" is answerable ONLY downstream.
    // Walking the wrong way lands on the data node, which cannot answer at all.
    const { state, id } = withMod(false);
    const moved = applyOp(state, {
      type: 'setParam',
      nodeId: SPHERE_ID,
      paramPath: 'position',
      value: [5, 1, -2],
    }).next;
    expect(resolveEvaluatedMesh(moved, id, ctx)!.transform.position).toEqual([5, 1, -2]);
  });

  it('a muted modifier resolves to the source mesh on the read side too', () => {
    const { state, id } = withMod(true);
    const resolved = resolveEvaluatedMesh(state, id, ctx);
    expect(resolved!.geometry.kind).toBe('sphere'); // passthrough — the source's own handle
  });
});
