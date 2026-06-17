// resolveEvaluatedTransform — the anti-trap unit suite (D-W9-4 tested-pure
// discipline). The headline assertion (group 1) is the proof that the resolver
// OVERLAYS the free-floating direct channel (v0.7 #199 / V57) rather than
// re-evaluating the selected node in isolation — the exact #68 trap.
//
// REF: issue #68, CONTEXT D-01/D-04/D-05, PLAN W1 task 2; vyapti V57.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, evaluate } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { BoxMeshValue } from '../nodes/types';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';

const BOX_ID = 'n_box';
const CHAN_ID = 'n_pos_channel';
const ROT_CHAN_ID = 'n_rot_channel';

// The box's authored static position. Channel samples are DELIBERATELY
// different so "resolver value ≠ raw value" is a real gap, not trivially true.
const STATIC_POS: [number, number, number] = [0, 0, 0];
const STATIC_ROT: [number, number, number] = [0, 0, 0];
const KF0_POS: [number, number, number] = [1, 2, 3];
const KF1_POS: [number, number, number] = [7, 8, 9];

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

/**
 * Build: default project + a FREE-FLOATING direct channel targeting n_box
 * (v0.7 #199 / V57). The box stays its own scene child — NO AnimationLayer
 * wrapper, no scene rewire. The resolver overlays the channel via
 * overlayChannels at ctx.time.seconds, exactly as the renderer (DirectChannelsR)
 * does — the one band, two callers (H40).
 */
function buildAnimatedState(opts: { rotChannel?: boolean } = {}): DagState {
  let state = buildDefaultDagState();
  // Pin the box's authored params so STATIC_POS is meaningful.
  state = applyOp(state, {
    type: 'setParam',
    nodeId: BOX_ID,
    paramPath: 'position',
    value: STATIC_POS,
  }).next;
  state = applyOp(state, {
    type: 'setParam',
    nodeId: BOX_ID,
    paramPath: 'rotation',
    value: STATIC_ROT,
  }).next;

  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: CHAN_ID,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: BOX_ID,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: KF0_POS, easing: 'linear' },
          { time: 1, value: KF1_POS, easing: 'linear' },
        ],
      },
    },
  ];
  if (opts.rotChannel) {
    ops.push({
      type: 'addNode',
      nodeId: ROT_CHAN_ID,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'rot',
        target: BOX_ID,
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [0, 90, 0], easing: 'linear' },
          { time: 1, value: [0, 180, 0], easing: 'linear' },
        ],
      },
    });
  }
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('resolveEvaluatedTransform', () => {
  // 1. ANIMATED PATCH (anti-trap, issue #68): resolver returns the patched
  //    clone value, DISTINCT from evaluate(box) raw + the static params.
  it('returns the patched (animated) value, NOT the raw node value', () => {
    const state = buildAnimatedState();
    const ctx = ctxAt(0); // channel value at t=0 = KF0_POS
    const r = resolveEvaluatedTransform(state, BOX_ID, ctx);
    expect(r).not.toBeNull();
    expect(r!.position).toEqual(KF0_POS);

    // The trap: evaluate(state, boxId) returns the box's RAW value.
    const raw = evaluate(state, BOX_ID, ctx).value as BoxMeshValue;
    expect(raw.position).toEqual(STATIC_POS);
    // The gap IS the test: resolver ≠ raw ≠ static authored param.
    expect(r!.position).not.toEqual(raw.position);
    expect(r!.position).not.toEqual(STATIC_POS);
  });

  // 3. PER-PARAM FALLBACK (D-04): position animated, rotation NOT — rotation
  //    is read off the patched clone, which preserves un-channelled fields,
  //    so it equals the static authored rotation.
  it('position follows eval while un-channelled rotation stays the static authored value (D-04)', () => {
    const state = buildAnimatedState(); // only a position channel
    const ctx = ctxAt(0.5);
    const r = resolveEvaluatedTransform(state, BOX_ID, ctx);
    expect(r).not.toBeNull();
    // position interpolates between KF0 and KF1 at t=0.5 (linear midpoint).
    expect(r!.position).toEqual([4, 5, 6]);
    // rotation un-channelled → patched clone preserves static authored value.
    expect(r!.rotation).toEqual(STATIC_ROT);
  });

  // 4. PLAYHEAD TRACKING: two distinct times → two distinct positions
  //    matching the channel samples (≥2 — mirrors D-06 at the unit layer).
  it('tracks the playhead: distinct times yield distinct evaluated positions', () => {
    const state = buildAnimatedState();
    const at0 = resolveEvaluatedTransform(state, BOX_ID, ctxAt(0));
    const at1 = resolveEvaluatedTransform(state, BOX_ID, ctxAt(1));
    expect(at0!.position).toEqual(KF0_POS);
    expect(at1!.position).toEqual(KF1_POS);
    expect(at0!.position).not.toEqual(at1!.position);
  });

  // 5. IDENTITY-NULL: unknown id, and a node that is neither a scene child
  //    nor a wrapped target → null (no throw).
  it('returns null for an unknown id and for a non-rendered node (no crash)', () => {
    const state = buildAnimatedState();
    expect(resolveEvaluatedTransform(state, 'not_a_node', ctxAt(0))).toBeNull();
    // n_camera is a real node but not a scene child / wrapped target.
    expect(resolveEvaluatedTransform(state, 'n_camera', ctxAt(0))).toBeNull();
  });

  // 6. SCALE/SIZE: BoxMesh has `size`, no `scale` → resolver returns scale
  //    from the size fallback (mirrors getManipulable Gizmo.tsx:69-76).
  it('reads scale from the BoxMesh size fallback when no explicit scale', () => {
    const state = buildAnimatedState();
    const r = resolveEvaluatedTransform(state, BOX_ID, ctxAt(0));
    expect(r).not.toBeNull();
    // The default box size is [1,1,1]; BoxMesh has no `scale` field, so the
    // resolver falls back to `.size` per the documented contract.
    expect(r!.scale).toEqual([1, 1, 1]);
  });
});

// P7.7 (#91) — the TRAILING glTF-child branch. A GltfChild id is neither a
// top-level scene-child ref nor a single-hop AnimationLayer target, so the
// existing match always misses; the new branch fires only on that miss AND
// only for a GltfChild, layering manual override → clip track → base via the
// SAME B1 primitive the renderer uses. The box-select regression assertion (3)
// is the H40 guard at the unit layer.
describe('resolveEvaluatedTransform — GltfChild branch (P7.7 / #91)', () => {
  const ASSET_REF = 'assets/skinned-bar.glb';
  const ASSET_ID = 'n_gltf_asset';
  const CHILD_ID = 'n_gltf_child';
  const CHILD_NAME = 'Bone';
  // Captured base TRS (seeded at import). Clip + override are deliberately
  // distinct so each layer is observable, not trivially equal.
  const BASE_POS: [number, number, number] = [1, 0, 0];
  const BASE_ROT: [number, number, number] = [0, 0, 0];
  const BASE_SCALE: [number, number, number] = [1, 1, 1];
  const OVERRIDE_POS: [number, number, number] = [5, 6, 7];
  const CLIP_POS: [number, number, number] = [9, 9, 9];
  const CLIP_ROT: [number, number, number] = [0, 45, 0];
  // P7.12 (#108, C3) — the baked-channel layer (a per-bone KeyframeChannelVec3).
  const BAKED_POS: [number, number, number] = [3, 3, 3];

  /** Build a state with a GltfAsset (optionally carrying a transformClip
   *  track for the child) + a GltfChild node. The GltfChild has NO render
   *  edge (R-1 inputless), so it never matches the scene-child correspondence
   *  loop — the trailing branch is the only path that resolves it. */
  function buildGltfState(opts: {
    overridden?: { position: boolean; rotation: boolean; scale: boolean };
    overridePos?: [number, number, number];
    withClip?: boolean;
    bakedPos?: [number, number, number];
  }): DagState {
    let state = buildDefaultDagState();
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: ASSET_ID,
        nodeType: 'GltfAsset',
        params: {
          assetRef: ASSET_REF,
          nodeNameMap: { [CHILD_NAME]: CHILD_ID },
        },
      },
      {
        type: 'addNode',
        nodeId: CHILD_ID,
        nodeType: 'GltfChild',
        params: {
          assetRef: ASSET_REF,
          childName: CHILD_NAME,
          position: opts.overridePos ?? BASE_POS,
          rotation: BASE_ROT,
          scale: BASE_SCALE,
          overridden: opts.overridden ?? { position: false, rotation: false, scale: false },
        },
      },
    ];
    for (const op of ops) state = applyOp(state, op).next;

    if (opts.withClip) {
      // Wire a real TransformClip producer into the GltfAsset's transformClip
      // input. The track is keyed by `targetNodeId` = the childName key
      // (gltfImportChain.ts:233 sets targetNodeId = the sanitised name key,
      // and the renderer/resolver look it up by that key). A single keyframe
      // clamps to its value at any time. The clip samples the project clock
      // (n_time) so it evaluates without a separate Time mock.
      state = applyOp(state, {
        type: 'addNode',
        nodeId: 'n_clip',
        nodeType: 'TransformClip',
        params: {
          name: 'anim',
          duration: 1,
          keyframes: [
            { targetNodeId: CHILD_NAME, time: 0, position: CLIP_POS, rotation: CLIP_ROT },
          ],
        },
      }).next;
      // P7.10 (#114): TransformClip no longer declares a `time` input
      // socket. The Time→Clip wire is gone; time enters via the value's
      // `.sample(seconds)` method (V3 amended), invoked by the consumer.
      state = applyOp(state, {
        type: 'connect',
        from: { node: 'n_clip', socket: 'out' },
        to: { node: ASSET_ID, socket: 'transformClip' },
      }).next;
    }

    if (opts.bakedPos) {
      // P7.12 (#108) — a baked per-bone KeyframeChannelVec3, keyed by BOTH
      // params.target (= the GltfChild dagId) AND params.childName (BLOCK-2),
      // edge-less (no AnimationLayer connect — the resolver enumerates it, R4).
      state = applyOp(state, {
        type: 'addNode',
        nodeId: 'n_baked_pos',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'baked',
          target: CHILD_ID,
          childName: CHILD_NAME,
          assetRef: ASSET_REF,
          paramPath: 'position',
          keyframes: [{ time: 0, value: opts.bakedPos, easing: 'linear' }],
        },
      }).next;
    }
    return state;
  }

  // 1. OVERRIDDEN → the manual value wins over base (and over a clip if present).
  it('returns the overridden value for an overridden GltfChild field', () => {
    const state = buildGltfState({
      overridden: { position: true, rotation: false, scale: false },
      overridePos: OVERRIDE_POS,
    });
    const r = resolveEvaluatedTransform(state, CHILD_ID, ctxAt(0));
    expect(r).not.toBeNull();
    expect(r!.position).toEqual(OVERRIDE_POS); // manual layer wins
    expect(r!.rotation).toEqual(BASE_ROT); // not overridden, no clip → base
    expect(r!.scale).toEqual(BASE_SCALE);
  });

  // 2. NON-OVERRIDDEN + active clip → the clip track wins (clip over base);
  //    an overridden field still wins over the clip (manual over clip).
  it('a non-overridden child with an active clip resolves to the clip track', () => {
    const state = buildGltfState({
      overridden: { position: false, rotation: false, scale: false },
      withClip: true,
    });
    const r = resolveEvaluatedTransform(state, CHILD_ID, ctxAt(0));
    expect(r).not.toBeNull();
    expect(r!.position).toEqual(CLIP_POS); // clip wins over base
    expect(r!.rotation).toEqual(CLIP_ROT);
    // scale has no clip track value distinct from base (clip seeded [1,1,1])
    expect(r!.scale).toEqual(BASE_SCALE);
  });

  // 2b. Manual override beats the clip: overridden position + active clip →
  //     the manual value, not the clip track (R-4 precedence).
  it('an overridden field wins over the active clip track (R-4)', () => {
    const state = buildGltfState({
      overridden: { position: true, rotation: false, scale: false },
      overridePos: OVERRIDE_POS,
      withClip: true,
    });
    const r = resolveEvaluatedTransform(state, CHILD_ID, ctxAt(0));
    expect(r).not.toBeNull();
    expect(r!.position).toEqual(OVERRIDE_POS); // manual beats clip
    expect(r!.rotation).toEqual(CLIP_ROT); // rotation not overridden → clip wins
  });

  // P7.12 (#108, C3, BLOCK-1) — the read-side baked-channel band. These mirror
  // the renderer (C2): the read-side gizmo/NPanel evaluated TRS MUST layer the
  // baked channel identically, or a baked-then-edited bone shows displayed ≠
  // rendered (the #68/#77 second-surface class, H40).

  // 2c. baked channel present + active clip → BAKED wins over clip (presence).
  it('a baked channel wins over the clip on the read-side (presence, R-4)', () => {
    const state = buildGltfState({ withClip: true, bakedPos: BAKED_POS });
    const r = resolveEvaluatedTransform(state, CHILD_ID, ctxAt(0));
    expect(r).not.toBeNull();
    expect(r!.position).toEqual(BAKED_POS); // baked beats clip
    expect(r!.rotation).toEqual(CLIP_ROT); // rotation has no baked band → clip
  });

  // 2d. baked value == base STILL beats the clip — presence, never value. A
  //     director who keys a bone back to its base pose keeps the override.
  it('a baked channel whose value equals base still beats the clip (presence not value)', () => {
    const state = buildGltfState({ withClip: true, bakedPos: BASE_POS });
    const r = resolveEvaluatedTransform(state, CHILD_ID, ctxAt(0));
    expect(r).not.toBeNull();
    expect(r!.position).toEqual(BASE_POS); // baked(==base) wins; the clip (CLIP_POS) does NOT resurface
  });

  // 2e. manual override beats the baked channel (the full 4-band order).
  it('a manual override wins over the baked channel (manual > baked)', () => {
    const state = buildGltfState({
      overridden: { position: true, rotation: false, scale: false },
      overridePos: OVERRIDE_POS,
      withClip: true,
      bakedPos: BAKED_POS,
    });
    const r = resolveEvaluatedTransform(state, CHILD_ID, ctxAt(0));
    expect(r).not.toBeNull();
    expect(r!.position).toEqual(OVERRIDE_POS); // manual beats baked + clip
  });

  // 3 (regression, H40). A box select still resolves via the EXISTING path —
  //   the trailing branch must not shadow or reorder it.
  it('a box select still resolves via the existing scene-child path (H40)', () => {
    const state = buildAnimatedState();
    const r = resolveEvaluatedTransform(state, BOX_ID, ctxAt(0));
    expect(r).not.toBeNull();
    expect(r!.position).toEqual(KF0_POS); // the patched animated value, unchanged
  });

  // Identity-null still holds: a non-GltfChild, non-rendered node → null.
  it('returns null for a GltfAsset id (not a GltfChild, not a scene child)', () => {
    const state = buildGltfState({});
    expect(resolveEvaluatedTransform(state, ASSET_ID, ctxAt(0))).toBeNull();
  });
});
