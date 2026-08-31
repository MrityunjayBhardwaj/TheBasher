// bakeClipOntoRig — the mutator that makes a retargeted clip actually move a
// rendered glTF rig (#803).
//
// 🔑 THE TEST THAT CARRIES THE POINT IS `the renderer's own enumerator finds the
// channels`. #803 existed because every assertion was on the PRODUCER's side: the
// clip evaluated to a PosedSkeleton whose rotations changed, and that was true,
// and the skin never moved. Asserting that this mutator emits channels proves
// the same kind of nothing. So the decisive test hands the emitted nodes to
// `bakedChannelSamplersForAsset` — the function the renderer's useFrame actually
// calls — and asserts it returns a sampler whose value CHANGES over time.
//
// The falsifying arm is cheap and is exercised below: with no channels applied,
// the same enumerator returns nothing for the same asset. A test that only
// showed "a sampler exists" would pass against a static one, which is precisely
// the shape being fixed.

import { describe, expect, it } from 'vitest';
import { emptyDagState } from '../../../core/dag/state';
import { applyOp } from '../../../core/dag/ops';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { registerAllNodes } from '../../../nodes/registerAll';
import { gltfChannelDagId, gltfChildDagId } from '../../../core/import/gltfImportChain';
import { bakedChannelSamplersForAsset } from '../../../app/bakedGltfChannels';
import { bakeClipOntoRigMutator } from './bakeClipOntoRig';

registerAllNodes();

const ASSET = 'asset-clipbake';
const BONES = ['mixamorig_Hips', 'mixamorig_Spine'] as const;

/** GltfAsset (2-joint skin) → GltfSkeleton → AnimationClip wired to it. */
function buildScene(opts: { keyframes?: unknown[]; skeletonType?: string } = {}): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cb_asset',
    nodeType: 'GltfAsset',
    params: {
      assetRef: ASSET,
      nodeNameMap: Object.fromEntries(BONES.map((b) => [b, gltfChildDagId(ASSET, b)])),
      skins: [
        {
          jointKeys: [...BONES],
          bindTRS: BONES.map(() => ({
            time: 0,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          })),
          parentJointIndex: [-1, 0],
          inverseBindMatrices: [],
        },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cb_skel',
    nodeType: opts.skeletonType ?? 'GltfSkeleton',
    params: opts.skeletonType === 'Skeleton' ? { bones: [] } : { skinIndex: 0 },
  }).next;
  if ((opts.skeletonType ?? 'GltfSkeleton') === 'GltfSkeleton') {
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'cb_asset', socket: 'out' },
      to: { node: 'cb_skel', socket: 'asset' },
    }).next;
  }
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cb_clip',
    nodeType: 'AnimationClip',
    params: {
      name: 'retargeted',
      duration: 2,
      keyframes: opts.keyframes ?? [
        // Bone 0 moves; bone 1 is deliberately untouched.
        //
        // 🔑 THE ROTATION IS RADIANS, AND SAYING SO IS THE POINT. This fixture
        // used to read `rotation: [0, 90, 0]` — 90 written by someone thinking
        // in degrees, into `AnimationKeyframe.rotation`, which is radians. The
        // assertion downstream then checked the channel came out `90`, so it
        // passed whether the bake converted or copied through, and it was the
        // copy-through that was live (#843). A fixture whose value is valid in
        // BOTH units cannot tell the two apart, so it confirmed the defect.
        // `Math.PI / 2` is unambiguous: radians in, 90 degrees out.
        { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { bone: 0, time: 2, position: [0, 1, 0], rotation: [0, Math.PI / 2, 0] },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cb_skel', socket: 'out' },
    to: { node: 'cb_clip', socket: 'skeleton' },
  }).next;
  for (const b of BONES) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChildDagId(ASSET, b),
      nodeType: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: b,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overridden: { position: false, rotation: false, scale: false },
      },
    }).next;
  }
  return s;
}

const EMPTY_CLOSURE = { nodeIds: new Set<string>(), edges: [] } as never;

function build(state: DagState, clipId = 'cb_clip'): Op[] {
  return bakeClipOntoRigMutator.build({ clipId }, EMPTY_CLOSURE, state);
}

function applyAll(state: DagState, ops: Op[]): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

describe('what it emits', () => {
  it('one channel per ANIMATED bone-component, and none for untouched bones', () => {
    const ops = build(buildScene());
    const ids = ops.map((o) => (o as { nodeId: string }).nodeId);
    // Bone 0 gets position + rotation. Bone 1 has no keyframes and gets nothing.
    expect(ids).toEqual([
      gltfChannelDagId(ASSET, BONES[0], 'position'),
      gltfChannelDagId(ASSET, BONES[0], 'rotation'),
    ]);
    expect(ids.some((i) => i === gltfChannelDagId(ASSET, BONES[1], 'rotation'))).toBe(false);
  });

  it('maps the keyframe bone INDEX to that bone NAME', () => {
    const ops = build(buildScene());
    for (const op of ops) {
      const params = (op as { params: { childName: string; target: string } }).params;
      // Index 0 is BONES[0] on the skeleton the clip is wired to. Getting this
      // wrong lands the motion on the wrong limb — a character that moves,
      // confidently and wrongly.
      expect(params.childName).toBe(BONES[0]);
      expect(params.target).toBe(gltfChildDagId(ASSET, BONES[0]));
    }
  });

  it('emits NO connect ops — the bone is an edge-less addressing satellite', () => {
    // Wiring a channel into an AnimationLayer would make it SHOW in the
    // dopesheet and NOT drive the bone.
    expect(build(buildScene()).every((o) => o.type === 'addNode')).toBe(true);
  });

  it('does NOT emit scale — the clip cannot express it', () => {
    // The resolver reads PRESENCE, so a scale channel would claim a component
    // the source never described and suppress the band underneath it.
    const paths = build(buildScene()).map(
      (o) => (o as { params: { paramPath: string } }).params.paramPath,
    );
    expect(paths).not.toContain('scale');
    expect(new Set(paths)).toEqual(new Set(['position', 'rotation']));
  });

  it('is idempotent — re-baking the same clip emits nothing', () => {
    const state = buildScene();
    const first = build(state);
    expect(first.length).toBeGreaterThan(0);
    expect(build(applyAll(state, first))).toEqual([]);
  });
});

describe("the renderer's own enumerator finds the channels", () => {
  it('returns a sampler whose value CHANGES over time', () => {
    const state = buildScene();
    const after = applyAll(state, build(state));
    const nodeNameMap = (after.nodes.cb_asset.params as { nodeNameMap: Record<string, string> })
      .nodeNameMap;

    // The exact call the renderer's useFrame makes.
    const samplers = bakedChannelSamplersForAsset(after.nodes, nodeNameMap);
    const rotation = samplers[BONES[0]]?.rotation;
    expect(rotation).toBeTypeOf('function');

    // 🔑 CHANGES, not merely exists. #803's render side had a sampler-shaped
    // hole: bones that existed and never moved.
    const t0 = rotation!(0);
    const t2 = rotation!(2);
    expect(t0).not.toEqual(t2);
    // π/2 radians in the clip → 90 DEGREES in the channel, because the
    // GltfChild rotation band is degrees (#843). Pass-through would read
    // 1.5708 here, which is the value that rendered as a character standing
    // still while its root position travelled.
    expect(t2[1]).toBeCloseTo(90, 5);
  });

  it("emits the rotation band in DEGREES, not the clip's radians", () => {
    // The gate the old fixture could not express. A quarter turn is the
    // cheapest value where radians and degrees are 57x apart and neither is
    // zero, so a pass-through regression cannot hide in rounding.
    const state = buildScene({
      keyframes: [
        { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { bone: 0, time: 1, position: [0, 0, 0], rotation: [Math.PI, Math.PI / 2, -Math.PI / 2] },
      ],
    });
    const after = applyAll(state, build(state));
    const nodeNameMap = (after.nodes.cb_asset.params as { nodeNameMap: Record<string, string> })
      .nodeNameMap;
    const rotation = bakedChannelSamplersForAsset(after.nodes, nodeNameMap)[BONES[0]]?.rotation;
    expect(rotation).toBeTypeOf('function');
    const v = rotation!(1);
    expect(v[0]).toBeCloseTo(180, 4);
    expect(v[1]).toBeCloseTo(90, 4);
    expect(v[2]).toBeCloseTo(-90, 4);
  });

  it('the falsifying arm: the same values read as radians would be 57x smaller', () => {
    // Not a tautology — it pins the DIRECTION of the conversion. If the bake
    // ever reverted to copying through, this arm is what tells you the band
    // went back to radians rather than merely changing by some amount.
    const state = buildScene({
      keyframes: [
        { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { bone: 0, time: 1, position: [0, 0, 0], rotation: [0, Math.PI / 2, 0] },
      ],
    });
    const after = applyAll(state, build(state));
    const nodeNameMap = (after.nodes.cb_asset.params as { nodeNameMap: Record<string, string> })
      .nodeNameMap;
    const v = bakedChannelSamplersForAsset(after.nodes, nodeNameMap)[BONES[0]]!.rotation!(1);
    expect(v[1]).not.toBeCloseTo(Math.PI / 2, 3);
    expect(v[1] / (Math.PI / 2)).toBeCloseTo(180 / Math.PI, 3);
  });

  it('the falsifying arm: with no bake applied, the enumerator finds nothing', () => {
    const state = buildScene();
    const nodeNameMap = (state.nodes.cb_asset.params as { nodeNameMap: Record<string, string> })
      .nodeNameMap;
    expect(bakedChannelSamplersForAsset(state.nodes, nodeNameMap)[BONES[0]]).toBeUndefined();
  });
});

describe('the refusals', () => {
  const pre = (state: DagState, clipId = 'cb_clip') =>
    bakeClipOntoRigMutator.preconditions!({ clipId }, EMPTY_CLOSURE, state);

  it('refuses a clip with no skeleton connected', () => {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'lone_clip',
      nodeType: 'AnimationClip',
      params: { name: 'x', duration: 1, keyframes: [{ bone: 0, time: 0 }] },
    }).next;
    const r = pre(s, 'lone_clip');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/no skeleton connected/);
  });

  it('refuses a PLAIN Skeleton — it addresses no rendered glTF bones', () => {
    const r = pre(buildScene({ skeletonType: 'Skeleton' }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/only a GltfSkeleton/);
  });

  it('refuses a clip with no keyframes rather than emitting empty channels', () => {
    const r = pre(buildScene({ keyframes: [] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/no keyframes/);
  });

  it('accepts the wired case', () => {
    expect(pre(buildScene()).ok).toBe(true);
  });
});
