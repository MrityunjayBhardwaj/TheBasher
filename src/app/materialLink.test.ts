// materialLink — the material data-block row's builders (#394 S3d-c).
//
// THE CLAIM THIS FILE EXISTS FOR is the one that would have shipped silently: the
// `material` socket is `cardinality: 'list'`, `applyConnect` APPENDS to a list binding,
// and `materialSocket` reads ENTRY 0. So a picker that merely connects would leave the
// FIRST material winning forever — the graph changes, the op succeeds, undo records a
// step, and the viewport keeps drawing the old material. That is the covered-value
// defect with the surface and the renderer on opposite sides, and no op-shaped assertion
// ("a connect was emitted") can see it. Every case here therefore asserts the EVALUATED
// material, not the ops.
//
// REF: src/app/materialLink.ts; src/nodes/materialSocket.ts; src/core/dag/ops.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import { getNodeType } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import type { MeshDataValue } from '../nodes/types';
import {
  buildLinkMaterialOps,
  buildNewMaterialOps,
  buildUnlinkMaterialOps,
  hasMaterialSocket,
  materialCandidates,
  materialUserCount,
  resolveMaterialLink,
} from './materialLink';

const BOX_DATA = 'n_box_data';

function applyOps(state: DagState, ops: Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

/** The colour the RENDERER would draw for this data node — the seam the picker's whole
 *  claim is about. Never the binding, never the param. */
function drawnColor(state: DagState, nodeId = BOX_DATA): string {
  const value = evaluate(state, nodeId).value as MeshDataValue;
  return value.material!.base.color;
}

/** A Material node holding one distinguishable colour. */
function addMaterial(state: DagState, id: string, color: string): DagState {
  return applyOps(state, [
    {
      type: 'addNode',
      nodeId: id,
      nodeType: 'Material',
      params: { material: { name: id, base: { color, metalness: 0 } } },
    },
  ]);
}

/** The binding actually persisted on the material socket, as ids. */
function boundIds(state: DagState, nodeId = BOX_DATA): string[] {
  const b = state.nodes[nodeId].inputs.material;
  const refs = Array.isArray(b) ? b : b ? [b] : [];
  return refs.map((r) => r.node);
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('#394 S3d-c — possession decides who gets the data-block row', () => {
  it('is true exactly for the nodes that take a material over an edge', () => {
    let state = buildDefaultDagState();
    state = addMaterial(state, 'mat', '#ff0000');
    state = applyOps(state, [
      { type: 'addNode', nodeId: 'sph', nodeType: 'SphereData', params: {} },
      { type: 'addNode', nodeId: 'setop', nodeType: 'SetMaterialOp', params: {} },
    ]);
    // Asked of the REGISTRY, so this list is a measurement of the schema rather than a
    // copy of it. A node gaining a material socket gets the row without editing anything.
    expect(hasMaterialSocket(state, BOX_DATA)).toBe(true);
    expect(hasMaterialSocket(state, 'sph')).toBe(true);
    expect(hasMaterialSocket(state, 'setop')).toBe(true);
    // …and the negatives, which are the interesting half: a Material node is what the
    // socket POINTS AT rather than something that has one.
    expect(hasMaterialSocket(state, 'mat')).toBe(false);
    expect(hasMaterialSocket(state, 'n_box')).toBe(false);
    expect(hasMaterialSocket(state, 'no_such_node')).toBe(false);
    // `BakedData` is the negative worth naming, because it DECLARES the material section
    // and still must not get the row — its material arrives inside the baked payload.
    // Asked of the registry rather than of an instance: its params require a real OPFS
    // geometry handle and a full baked material face, and building one here would be a
    // large fixture asserting nothing this claim is about.
    expect(getNodeType('BakedData')!.inputs.material).toBeUndefined();
    expect(getNodeType('BoxData')!.inputs.material!.type).toBe('Material');
  });
});

describe('#394 S3d-c — picking a material REPLACES, it does not append', () => {
  it('draws the SECOND material after a second pick', () => {
    let state = buildDefaultDagState();
    state = addMaterial(state, 'matA', '#ff0000');
    state = addMaterial(state, 'matB', '#0000ff');

    state = applyOps(state, buildLinkMaterialOps(state, BOX_DATA, 'matA')!);
    expect(drawnColor(state), 'first pick must be drawn').toBe('#ff0000');

    state = applyOps(state, buildLinkMaterialOps(state, BOX_DATA, 'matB')!);
    // THE ASSERTION. A builder that only connected would leave `[matA, matB]`, and
    // `resolveNodeMaterial` reads entry 0 — so this would still be '#ff0000' while the
    // binding, the op log and the undo stack all looked correct.
    expect(drawnColor(state), 'the newly picked material must be the one drawn').toBe('#0000ff');
    // And the persisted shape, asserted directly so the reason is visible in the failure
    // rather than only the symptom.
    expect(boundIds(state)).toEqual(['matB']);
    expect(resolveMaterialLink(state, BOX_DATA)).toBe('matB');
  });

  it('CONTROL: appending really would have hidden the second material', () => {
    // The positive control for the case above — without it, "the second pick is drawn"
    // could be true because the socket happened to hold one entry all along. This builds
    // the BROKEN shape by hand (connect with no disconnect) and shows it draws the first.
    let state = buildDefaultDagState();
    state = addMaterial(state, 'matA', '#ff0000');
    state = addMaterial(state, 'matB', '#0000ff');
    state = applyOps(state, [
      {
        type: 'connect',
        from: { node: 'matA', socket: 'out' },
        to: { node: BOX_DATA, socket: 'material' },
      },
      {
        type: 'connect',
        from: { node: 'matB', socket: 'out' },
        to: { node: BOX_DATA, socket: 'material' },
      },
    ]);
    expect(boundIds(state)).toEqual(['matA', 'matB']);
    expect(drawnColor(state)).toBe('#ff0000');
  });

  it('re-picking the material already linked builds nothing', () => {
    // A no-op that burns an undo step is a small lie about what happened.
    let state = buildDefaultDagState();
    state = addMaterial(state, 'matA', '#ff0000');
    state = applyOps(state, buildLinkMaterialOps(state, BOX_DATA, 'matA')!);
    expect(buildLinkMaterialOps(state, BOX_DATA, 'matA')).toBeNull();
  });

  it('refuses a producer that is not a material, and a consumer with no socket', () => {
    let state = buildDefaultDagState();
    state = addMaterial(state, 'matA', '#ff0000');
    // `n_box` is an Object: it emits SceneObject, so `connect` would refuse this edge.
    // Refusing in the builder means the failure is reported where the user acted.
    expect(buildLinkMaterialOps(state, BOX_DATA, 'n_box')).toBeNull();
    expect(buildLinkMaterialOps(state, 'n_box', 'matA')).toBeNull();
    expect(buildLinkMaterialOps(state, BOX_DATA, 'no_such_node')).toBeNull();
  });
});

describe('#394 S3d-c — unlink uncovers the authored base', () => {
  it('draws the node’s own material again, and never wrote to it', () => {
    let state = buildDefaultDagState();
    const authored = drawnColor(state);
    state = addMaterial(state, 'matA', '#ff0000');
    state = applyOps(state, buildLinkMaterialOps(state, BOX_DATA, 'matA')!);
    expect(drawnColor(state)).toBe('#ff0000');

    state = applyOps(state, buildUnlinkMaterialOps(state, BOX_DATA)!);
    // THE DISCRIMINATOR that makes the base a FALLBACK rather than dead state — which is
    // why the base rows stay editable under a link instead of being locked.
    expect(drawnColor(state)).toBe(authored);
    expect(boundIds(state)).toEqual([]);
    expect(resolveMaterialLink(state, BOX_DATA)).toBeNull();
  });

  it('offers nothing to unlink when nothing is linked', () => {
    const state = buildDefaultDagState();
    expect(buildUnlinkMaterialOps(state, BOX_DATA)).toBeNull();
    expect(buildUnlinkMaterialOps(state, 'n_box')).toBeNull();
  });
});

describe('#394 S3d-c — New Material is value-preserving', () => {
  it('changes the graph and not the picture', () => {
    let state = buildDefaultDagState();
    const before = drawnColor(state);
    const res = buildNewMaterialOps(state, BOX_DATA, 'mat_new')!;
    state = applyOps(state, res.ops);
    // Blender mints a default grey here; Basher must not, because the data node already
    // HAS an authored material and a default would discard it at the exact moment the
    // user asked to make it shareable.
    expect(drawnColor(state)).toBe(before);
    expect(resolveMaterialLink(state, BOX_DATA)).toBe('mat_new');
  });

  it('seeds from the CURRENTLY LINKED material, not from the node’s stale param', () => {
    // The second half of value-preserving, and the one a naive implementation misses:
    // with a material already linked, the param underneath is NOT what is on screen.
    let state = buildDefaultDagState();
    state = addMaterial(state, 'matA', '#ff0000');
    state = applyOps(state, buildLinkMaterialOps(state, BOX_DATA, 'matA')!);
    const res = buildNewMaterialOps(state, BOX_DATA, 'mat_new')!;
    state = applyOps(state, res.ops);
    expect(drawnColor(state)).toBe('#ff0000');
    expect(boundIds(state)).toEqual(['mat_new']);
  });

  it('refuses on a node with no material socket', () => {
    const state = buildDefaultDagState();
    expect(buildNewMaterialOps(state, 'n_box')).toBeNull();
  });
});

describe('#394 S3d-c — the user count is what makes sharing a stated fact', () => {
  it('counts every node bound to the material, and rises as they link', () => {
    let state = buildDefaultDagState();
    state = addMaterial(state, 'matA', '#ff0000');
    expect(materialUserCount(state, 'matA')).toBe(0);

    state = applyOps(state, [
      { type: 'addNode', nodeId: 'sph', nodeType: 'SphereData', params: {} },
      { type: 'addNode', nodeId: 'sph2', nodeType: 'SphereData', params: {} },
    ]);
    state = applyOps(state, buildLinkMaterialOps(state, BOX_DATA, 'matA')!);
    expect(materialUserCount(state, 'matA')).toBe(1);
    state = applyOps(state, buildLinkMaterialOps(state, 'sph', 'matA')!);
    state = applyOps(state, buildLinkMaterialOps(state, 'sph2', 'matA')!);
    expect(materialUserCount(state, 'matA')).toBe(3);

    // …and falls again on unlink, which is what makes the number a live fact rather
    // than a high-water mark.
    state = applyOps(state, buildUnlinkMaterialOps(state, 'sph2')!);
    expect(materialUserCount(state, 'matA')).toBe(2);
  });

  it('THE PAYOFF, on the evaluated value: three nodes share one material', () => {
    // The claim #394 exists to make, asserted where it is observable. Editing the
    // Material node moves all three, and it moves them because they resolve THROUGH it,
    // not because three params happen to agree.
    let state = buildDefaultDagState();
    state = addMaterial(state, 'shared', '#ff0000');
    state = applyOps(state, [
      { type: 'addNode', nodeId: 'sph', nodeType: 'SphereData', params: {} },
      { type: 'addNode', nodeId: 'sph2', nodeType: 'SphereData', params: {} },
    ]);
    for (const id of [BOX_DATA, 'sph', 'sph2']) {
      state = applyOps(state, buildLinkMaterialOps(state, id, 'shared')!);
    }
    expect([drawnColor(state), drawnColor(state, 'sph'), drawnColor(state, 'sph2')]).toEqual([
      '#ff0000',
      '#ff0000',
      '#ff0000',
    ]);
    state = applyOps(state, [
      { type: 'setParam', nodeId: 'shared', paramPath: 'material.base.color', value: '#00ff00' },
    ]);
    expect([drawnColor(state), drawnColor(state, 'sph'), drawnColor(state, 'sph2')]).toEqual([
      '#00ff00',
      '#00ff00',
      '#00ff00',
    ]);
  });
});

describe('#394 S3d-c — the picker lists material PRODUCERS, derived not enumerated', () => {
  it('lists every node that emits a Material and nothing else', () => {
    let state = buildDefaultDagState();
    const before = materialCandidates(state);
    state = addMaterial(state, 'matA', '#ff0000');
    state = addMaterial(state, 'matB', '#0000ff');
    const after = materialCandidates(state);
    // Guard the guard: the default project has no Material node, so an empty `before`
    // and a filter that matched nothing would look identical without this.
    expect(before).toEqual([]);
    expect(after.map((c) => c.id).sort()).toEqual(['matA', 'matB']);
    // Sorted by label for a stable picker.
    expect(after.map((c) => c.label)).toEqual([...after.map((c) => c.label)].sort());
    // …and it does not sweep in every node: the default project is much bigger than 2.
    expect(Object.keys(state.nodes).length).toBeGreaterThan(after.length + 5);
  });
});
