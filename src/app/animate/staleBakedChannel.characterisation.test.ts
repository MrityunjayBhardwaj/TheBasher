// CHARACTERISATION TEST — this file asserts a DEFECT, on purpose (#887).
//
// ─────────────────────────────────────────────────────────────────────────
// 🔴 IF THIS FILE GOES RED, READ THIS BEFORE "FIXING" IT
// ─────────────────────────────────────────────────────────────────────────
// It pins what the code does TODAY, not what it should do. A baked channel
// outranks the clip it was copied from, and nothing revisits the copy when the
// clip changes — so the surface renders a stale value and nothing reports it.
//
// The expected inversion point is #889 (the band becomes copy-on-write: an
// unedited bone has no channel, so it follows the clip and there is no copy to
// go stale). When that lands, the assertions below must be EDITED to the new
// behaviour, deliberately. That they cannot be satisfied by both behaviours is
// the point — the change cannot land silently.
//
// #888 lands BEFORE that and must NOT red this file: it gives the band a way to
// reach a retargeted clip for a bone with no channel, and every bone in an
// existing project still has one, so the new arm is unreachable here.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY A CHARACTERISATION TEST AND NOT A RED GATE
// ─────────────────────────────────────────────────────────────────────────
// A knowingly-red gate needs a skip-with-reason, and a skipped gate is silent
// through every edit-test loop — the failure mode this sector already
// catalogued with `discardPatchRot`. Green today blocks nothing and still reds
// at exactly the moment someone must confirm the behaviour changed on purpose.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THE THREE ROADS ARE FOR
// ─────────────────────────────────────────────────────────────────────────
// #877's original evidence was a grep: no staleness/invalidation machinery
// exists. That establishes the ABSENCE OF A GUARD, never that anything gets
// past one. Two of the three roads that could change a clip under a live bake
// turn out to be closed already, by machinery with nothing to do with
// staleness; the third is open. Keeping all three is what distinguishes "no
// machinery exists" from "the failure is reachable" — delete the closed rows
// and the file stops recording why the open one matters.
//
// REF: issues #877, #887, #888, #889; src/app/resolveGltfChildTransform.ts
//      (the band ladder — presence wins, never value-equality);
//      src/agent/tools/dagExec.ts (the universal mutation surface, an agent
//      tool, which is what makes ROAD B reachable in this product).

import { describe, it, expect } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { gltfChildDagId } from '../../core/import/gltfImportChain';
import { bakeChannelOpsForBone } from '../../agent/mutators/builders/bakeChannelOps';
import { resolveGltfChildTrs } from '../resolveGltfChildTransform';
import { buildVec3Sampler, KeyframeChannelVec3Params } from '../../nodes/KeyframeChannelVec3';
import { TransformClipNode, TransformClipParams } from '../../nodes/TransformClip';
import type { TransformClipValue } from '../../nodes/types';

const ASSET = 'asset-characterisation';
const CHILD = 'bone_1';

/** One TransformClip keyframe for CHILD at height `y`. */
function kf(t: number, y: number) {
  return {
    targetNodeId: CHILD,
    time: t,
    position: [0, y, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

/** A clip node plus the addressable GltfChild the bake would target. */
function build(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_clip_0',
    nodeType: 'TransformClip',
    params: { name: 'walk', duration: 2, keyframes: [kf(0, 0), kf(2, 10)] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: gltfChildDagId(ASSET, CHILD),
    nodeType: 'GltfChild',
    params: {
      assetRef: ASSET,
      childName: CHILD,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      overridden: { position: false, rotation: false, scale: false },
    },
  }).next;
  return s;
}

function fresh(): DagState {
  __resetRegistryForTests();
  registerAllNodes();
  return build();
}

describe('#887 — the three roads that could change a clip under a live bake', () => {
  it('ROAD A is CLOSED — re-adding the clip id throws, so a re-retarget cannot overwrite in place', () => {
    const s = fresh();
    // Deterministic ids mean a re-retarget reuses this id rather than minting a
    // new one. `ops.ts` refuses, which closes the road for reasons that have
    // nothing to do with staleness.
    expect(() =>
      applyOp(s, {
        type: 'addNode',
        nodeId: 'n_clip_0',
        nodeType: 'TransformClip',
        params: { name: 'walk', duration: 2, keyframes: [kf(0, 0), kf(2, 999)] },
      }),
    ).toThrow();
  });

  it('ROAD B is OPEN — setParam on the clip keyframes is silently accepted, with no guard at the op layer', () => {
    const s = fresh();
    const r = applyOp(s, {
      type: 'setParam',
      nodeId: 'n_clip_0',
      paramPath: 'keyframes',
      value: [kf(0, 0), kf(2, 999)],
    } as never);
    const after = (r.next.nodes['n_clip_0'].params as { keyframes: { position: number[] }[] })
      .keyframes[1].position[1];
    // Accepted, and the new value is really there. No mutator reaches this —
    // every keyframe mutator gates on a `KeyframeChannel*` node type — but
    // `dag.exec` takes raw setParam on any node and is an agent tool.
    expect(after).toBe(999);
  });

  it('ROAD C is OPEN — the clip can be removed while its baked copies survive', () => {
    const s = fresh();
    const r = applyOp(s, { type: 'removeNode', nodeId: 'n_clip_0' } as never);
    expect('n_clip_0' in r.next.nodes).toBe(false);
  });
});

describe('#887 — what the ONE resolver both surfaces consume returns after the clip moves', () => {
  it('renders the STALE baked copy, and nothing reports it', () => {
    __resetRegistryForTests();
    registerAllNodes();

    // 1. the clip as imported: the bone RISES 0 → +10 over 2s.
    const clipV1 = [kf(0, 0), kf(2, 10)];

    // 2. bake it — this is the band the renderer actually reads.
    const ops = bakeChannelOpsForBone({
      assetRef: ASSET,
      childName: CHILD,
      byComponent: { position: clipV1.map((k) => ({ time: k.time, value: k.position })) },
      state: emptyDagState(),
    });
    const samplers = new Map<string, (t: number) => readonly number[]>();
    for (const op of ops) {
      if (op.type !== 'addNode') continue;
      const p = op.params as { paramPath: string };
      samplers.set(p.paramPath, buildVec3Sampler(KeyframeChannelVec3Params.parse(op.params)));
    }

    // 3. the agent edits the clip through ROAD B, proven accepted above: the
    //    SAME bone now FALLS 0 → −10 instead of rising.
    const clip = TransformClipNode.evaluate(
      TransformClipParams.parse({ name: 'walk', duration: 2, keyframes: [kf(0, 0), kf(2, -10)] }),
      {} as never,
      {} as never,
    ) as TransformClipValue;

    const T = 2;
    const clipNow = clip.sample(T)[CHILD];
    const bakedStill = samplers.get('position')!(T);

    // 4. the layering primitive both the renderer (C2) and the read-side
    //    gizmo/NPanel (C3) consume — one precedence rule, so this IS what the
    //    surface shows.
    const resolved = resolveGltfChildTrs({
      base: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      clipTrack: clipNow,
      childNode: undefined,
      bakedChannel: { position: bakedStill as [number, number, number] },
    });

    // The clip and the copy now disagree by the full swing…
    expect(clipNow.position[1]).toBe(-10);
    expect(bakedStill[1]).toBe(10);
    // …and THE COPY WINS. This is the assertion #889 inverts: under
    // copy-on-write an unedited bone has no channel, so `bakedChannel` is
    // undefined here and the resolver returns the clip's −10.
    expect(resolved.position[1]).toBe(10);
    expect(resolved.position[1]).not.toBe(clipNow.position[1]);
  });
});
