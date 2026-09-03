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
//   6. H40 no-jump: the baked channel reproduces the clip track — at every key
//      AND between them. Sampling only at keyframes proves nothing here: both
//      carriers are bit-identical at every key whatever easing the bake stamps,
//      so that form of the assertion read 0 with #877's defect and 0 without it
//      (issue #883). The interval fractions straddle the extrema of
//      |smoothstep(u) - u| and deliberately keep 0.5, which is the one interior
//      point at which the two agree even when the bake is wrong.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../../core/dag';
import { registerAllNodes } from '../../../nodes/registerAll';
import { validatePlan } from '../validate';
import { bakeGltfChannelMutator } from './bakeGltfChannel';
import { gltfChildDagId, gltfChannelDagId } from '../../../core/import/gltfImportChain';
import { buildVec3Sampler, KeyframeChannelVec3Params } from '../../../nodes/KeyframeChannelVec3';
import { TransformClipNode, TransformClipParams } from '../../../nodes/TransformClip';
import type { TransformClipValue } from '../../../nodes/types';

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
  registerAllNodes();
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

  /** Interior sample fractions for the interval assertions below. 0.5 is kept ON
   *  PURPOSE and must never become the only probe: smoothstep(0.5) = 0.5, so the
   *  linear and cubic readings coincide there exactly. |smoothstep(u) - u| peaks
   *  at u = (3 +/- sqrt(3))/6 ~ 0.2113 / 0.7887, which is what 0.21 and 0.79
   *  straddle. A later "simplification" of this list to the midpoint alone would
   *  be a false green that looks like tidying — the row after this one records
   *  that in an executable form. REF: issue #883. */
  const INTERIOR_U = [0.21, 0.5, 0.79] as const;

  it('H40 no-jump: the baked channel reproduces the clip AT every key', () => {
    const state = buildState();
    const r = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      state,
      'bake',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let checked = 0;
    for (const op of r.ops) {
      if (op.type !== 'addNode') continue;
      const p = op.params as {
        paramPath: 'position' | 'rotation' | 'scale';
        keyframes: { time: number; value: [number, number, number]; easing: 'linear' | 'cubic' }[];
      };
      // Parsed through the node's OWN schema, which is the path applyAddNode
      // takes — so anything the builder fails to state comes back as the
      // schema's default rather than as an absence.
      const sampler = buildVec3Sampler(KeyframeChannelVec3Params.parse(op.params));
      // At each clip key time, the baked sampler returns the clip's value for
      // that component (no easing-induced pop at the keys themselves).
      const clipForChild = CLIP_KEYFRAMES.filter((k) => k.targetNodeId === CHILD);
      for (const k of clipForChild) {
        expect(sampler(k.time)).toEqual(k[p.paramPath]);
        checked++;
      }
    }
    // The denominator, asserted: a green from a loop that never ran looks
    // exactly like a green from a loop that ran and agreed.
    expect(checked).toBe(6);
  });

  it('H40 no-jump: and BETWEEN the keys, where the two carriers can actually differ', () => {
    // The assertion above is satisfied identically by a bake that eases and one
    // that does not, because the carriers coincide at every key. What separates
    // them is the interior of each interval, read against the REAL consumer —
    // TransformClip's own sample(), not a re-implementation of its arithmetic.
    const state = buildState();
    const r = validatePlan(
      bakeGltfChannelMutator,
      { assetRef: ASSET_REF, childName: CHILD },
      state,
      'bake',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // `evaluate` is declared `O | Record<string, O>`, so the single-value arm has
    // to be narrowed before `.sample` is reachable. TransformClip has no inputs
    // and reads no ctx — time enters through sample(), not the graph.
    const clip = TransformClipNode.evaluate(
      TransformClipParams.parse({ name: 'walk', duration: 1.5, keyframes: CLIP_KEYFRAMES }),
      {} as never,
      {} as never,
    ) as TransformClipValue;

    const byPath = new Map<string, (seconds: number) => readonly number[]>();
    for (const op of r.ops) {
      if (op.type !== 'addNode') continue;
      const p = op.params as {
        paramPath: 'position' | 'rotation' | 'scale';
        keyframes: { time: number; value: [number, number, number]; easing: 'linear' | 'cubic' }[];
      };
      byPath.set(p.paramPath, buildVec3Sampler(KeyframeChannelVec3Params.parse(op.params)));
    }

    const times = CLIP_KEYFRAMES.filter((k) => k.targetNodeId === CHILD).map((k) => k.time);
    let compared = 0;
    let maxDelta = 0;
    let worst = '';
    for (let seg = 0; seg < times.length - 1; seg++) {
      for (const u of INTERIOR_U) {
        const t = times[seg] + u * (times[seg + 1] - times[seg]);
        const trs = clip.sample(t)[CHILD];
        expect(trs, `clip produced no TRS for ${CHILD} at t=${t}`).toBeDefined();
        for (const component of ['position', 'rotation', 'scale'] as const) {
          const sampler = byPath.get(component);
          expect(sampler, `bake emitted no '${component}' channel`).toBeDefined();
          const got = sampler!(t);
          for (let axis = 0; axis < 3; axis++) {
            const delta = Math.abs(trs[component][axis] - got[axis]);
            compared++;
            if (delta > maxDelta) {
              maxDelta = delta;
              worst = `${component}[${axis}] u=${u} t=${t.toFixed(4)} clip=${trs[component][axis]} baked=${got[axis]}`;
            }
          }
        }
      }
    }

    // 1 segment x 3 fractions x 3 components x 3 axes.
    expect(compared).toBe(27);
    // Exact, not approximate: a linear bake of a linearly-sampled clip is the
    // SAME arithmetic, so the only admissible slack is float representation.
    expect(maxDelta, `${compared} samples compared; worst: ${worst}`).toBeLessThan(1e-12);
  });

  it('u=0.5 alone would agree even with an easing defect, so it cannot be the only probe', () => {
    // Guards the GATE, not the code. If INTERIOR_U is ever trimmed to the
    // midpoint this row reds and says why.
    const smoothstep = (u: number) => u * u * (3 - 2 * u);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(INTERIOR_U.some((u) => Math.abs(smoothstep(u) - u) > 0.09)).toBe(true);
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
