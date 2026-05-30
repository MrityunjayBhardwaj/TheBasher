// bakeGltfChannel Mutator — D1 unit tests (Phase 7.12 Wave D, issue #108).
//
// The load-bearing assertions (PLAN D1 verify):
//   1. 3 KeyframeChannelVec3 addNode ops with hashId-deterministic ids.
//   2. ZERO connect ops (R4 — the edge-less consumption bridge).
//   3. BOTH params.target (= the GltfChild dagId) AND params.childName present
//      (BLOCK-2 dual key).
//   4. Bake twice → SAME ids, idempotent no-op (V22 determinism).
//   5. The edge-less channel nodes SURVIVE applyOp (closure gate / dispatch
//      does NOT reject or GC an inputless addNode) (FLAG-3).
//   6. H40 no-jump: the baked channel's sample(bakeTime) equals the clip track
//      value at bakeTime per component.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../../core/dag';
import { __reseedAllNodesForTests } from '../../../nodes/registerAll';
import { validatePlan } from '../validate';
import { bakeGltfChannelMutator } from './bakeGltfChannel';
import { gltfChildDagId, gltfChannelDagId } from '../../../core/import/gltfImportChain';
import { buildVec3Sampler } from '../../../nodes/KeyframeChannelVec3';

const ASSET_REF = 'asset-bake';
const CHILD = 'bone_1';

// A 2-key TRS clip for `bone_1` (+ a second bone that must NOT leak), mirroring
// gltfImportChain.buildClipKeyframes (targetNodeId = the NAME key, R5).
const CLIP_KEYFRAMES = [
  {
    targetNodeId: 'bone_1',
    time: 0,
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  },
  {
    targetNodeId: 'bone_1',
    time: 1.5,
    position: [0, 2, 0] as [number, number, number],
    rotation: [0, 90, 0] as [number, number, number],
    scale: [2, 2, 2] as [number, number, number],
  },
  {
    targetNodeId: 'bone_2',
    time: 0.5,
    position: [9, 9, 9] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  },
];

/** A real DagState: GltfAsset → ClipSelect → TransformClip + GltfChild(bone_1).
 *  Built via applyOp so applyAddNode zod-parses every node's params (the same
 *  path the live DAG uses — proves the baked params survive parsing). */
function buildState(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_clip_0',
    nodeType: 'TransformClip',
    params: { name: 'walk', duration: 1.5, keyframes: CLIP_KEYFRAMES },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_sel_0',
    nodeType: 'ClipSelect',
    params: { selectedClipName: 'walk' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_clip_0', socket: 'out' },
    to: { node: 'n_sel_0', socket: 'clips' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_gltf_0',
    nodeType: 'GltfAsset',
    params: { assetRef: ASSET_REF },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_sel_0', socket: 'out' },
    to: { node: 'n_gltf_0', socket: 'transformClip' },
  }).next;
  // The GltfChild for bone_1 — its dagId IS gltfChildDagId(ASSET_REF, CHILD).
  s = applyOp(s, {
    type: 'addNode',
    nodeId: gltfChildDagId(ASSET_REF, CHILD),
    nodeType: 'GltfChild',
    params: {
      assetRef: ASSET_REF,
      childName: CHILD,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      overridden: { position: false, rotation: false, scale: false },
    },
  }).next;
  return s;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('mutator.timeline.bakeGltfChannel (D1)', () => {
  it('emits 3 KeyframeChannelVec3 addNode ops with deterministic ids + ZERO connects', () => {
    const state = buildState();
    const r = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      state,
      'bake bone_1',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 3 addNode ops, one per TRS component.
    const addNodes = r.ops.filter((o) => o.type === 'addNode');
    expect(addNodes).toHaveLength(3);
    for (const op of addNodes) {
      if (op.type === 'addNode') expect(op.nodeType).toBe('KeyframeChannelVec3');
    }

    // Deterministic ids: hashId('gltfChannel', assetRef, childName, component).
    const ids = addNodes.map((o) => (o.type === 'addNode' ? o.nodeId : ''));
    expect(ids).toEqual([
      gltfChannelDagId(ASSET_REF, CHILD, 'position'),
      gltfChannelDagId(ASSET_REF, CHILD, 'rotation'),
      gltfChannelDagId(ASSET_REF, CHILD, 'scale'),
    ]);

    // R4: ZERO connect ops — the bone is edge-less.
    const connects = r.ops.filter((o) => o.type === 'connect');
    expect(connects).toHaveLength(0);
  });

  it('BLOCK-2: every channel carries BOTH params.target (dagId) AND params.childName + assetRef', () => {
    const state = buildState();
    const r = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      state,
      'bake',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dagId = gltfChildDagId(ASSET_REF, CHILD);
    for (const op of r.ops) {
      if (op.type !== 'addNode') continue;
      const p = op.params as { target?: unknown; childName?: unknown; assetRef?: unknown };
      expect(p.target).toBe(dagId); // = GltfChild dagId (paramAnimationState/D2)
      expect(p.childName).toBe(CHILD); // = resolver enumeration key
      expect(p.assetRef).toBe(ASSET_REF);
    }
  });

  it('seeds each channel only from THIS bone (R5 NAME filter) with the clip per-component values', () => {
    const state = buildState();
    const r = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      state,
      'bake',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byPath: Record<string, { time: number; value: number[] }[]> = {};
    for (const op of r.ops) {
      if (op.type !== 'addNode') continue;
      const p = op.params as { paramPath: string; keyframes: { time: number; value: number[] }[] };
      byPath[p.paramPath] = p.keyframes;
    }
    // bone_2 keys (9,9,9 @ 0.5) must NOT appear; bone_1 has 2 keys @ 0 and 1.5.
    expect(byPath.position.map((k) => k.time)).toEqual([0, 1.5]);
    expect(byPath.position.map((k) => k.value)).toEqual([
      [0, 0, 0],
      [0, 2, 0],
    ]);
    expect(byPath.rotation.map((k) => k.value)).toEqual([
      [0, 0, 0],
      [0, 90, 0],
    ]);
    expect(byPath.scale.map((k) => k.value)).toEqual([
      [1, 1, 1],
      [2, 2, 2],
    ]);
  });

  it('V22: baking twice yields the SAME ids; the second bake is an idempotent no-op', () => {
    let state = buildState();
    const first = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      state,
      'bake 1',
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Apply the first bake.
    for (const op of first.ops) state = applyOp(state, op).next;

    // Second bake against the post-bake state → the guard skips existing ids.
    const second = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      state,
      'bake 2',
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Idempotent: all 3 channels already exist → no new addNode ops.
    expect(second.ops.filter((o) => o.type === 'addNode')).toHaveLength(0);
  });

  it('FLAG-3: the edge-less channel nodes SURVIVE applyOp (closure gate does not reject/GC them)', () => {
    let state = buildState();
    const r = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      state,
      'bake',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const op of r.ops) state = applyOp(state, op).next;

    // All 3 inputless channel nodes persist in the DAG (no edge required).
    for (const component of ['position', 'rotation', 'scale']) {
      const id = gltfChannelDagId(ASSET_REF, CHILD, component);
      const node = state.nodes[id];
      expect(node).toBeDefined();
      expect(node.type).toBe('KeyframeChannelVec3');
      // childName + assetRef survived the zod parse (schema-declared, BLOCK-2).
      const p = node.params as { childName?: unknown; assetRef?: unknown; target?: unknown };
      expect(p.childName).toBe(CHILD);
      expect(p.assetRef).toBe(ASSET_REF);
      expect(p.target).toBe(gltfChildDagId(ASSET_REF, CHILD));
    }
  });

  it('H40 no-jump: the baked channel sample(bakeTime) equals the clip value per component', () => {
    const state = buildState();
    const r = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      state,
      'bake',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const op of r.ops) {
      if (op.type !== 'addNode') continue;
      const p = op.params as {
        paramPath: 'position' | 'rotation' | 'scale';
        keyframes: { time: number; value: [number, number, number]; easing: 'linear' | 'cubic' }[];
      };
      const sampler = buildVec3Sampler({
        name: '',
        target: '',
        paramPath: '',
        keyframes: p.keyframes,
      });
      // At each clip key time, the baked sampler returns the clip's value for
      // that component (no easing-induced pop at the keys themselves).
      const clipForChild = CLIP_KEYFRAMES.filter((k) => k.targetNodeId === CHILD);
      for (const k of clipForChild) {
        expect(sampler(k.time)).toEqual(k[p.paramPath]);
      }
    }
  });

  it('rejects when no clip track exists for the bone (nothing to bake)', () => {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChildDagId(ASSET_REF, CHILD),
      nodeType: 'GltfChild',
      params: {
        assetRef: ASSET_REF,
        childName: CHILD,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overridden: { position: false, rotation: false, scale: false },
      },
    }).next;
    const r = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      s,
      'bake no-clip',
    );
    expect(r.ok).toBe(false);
  });
});
