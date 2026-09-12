// #993 — the pose lane's AUTHOR: minting and extending a `PoseOverride`.
//
// The rows are about the three things that make an authored pose REACH something:
// the bone name landing in the rig's own spelling, the override landing ON the
// rig's chain, and a repeat landing on the override already there. The node's own
// semantics (presence-not-value, copy-on-write, laziness) live in
// PoseOverride.test.ts and the band's walk in bakedGltfChannels.poseBand.test.ts;
// neither is re-asserted here.
//
// EVERY REJECTION ROW ASSERTS THE ABSENCE OF THE REJECTED THING, never the health
// of its neighbours: a refusal that still minted a node under a key nothing reads
// would leave a neighbour-checking row green, which is the one defect these rows
// exist to see.
//
// REF: src/agent/mutators/builders/poseBone.ts; src/nodes/PoseOverride.ts;
//      src/app/bakedGltfChannels.ts (poseBandForAsset); issues #993, #974, #922.

import { describe, it, expect } from 'vitest';
import { emptyDagState, type DagState } from '../../../core/dag/state';
import { applyOp } from '../../../core/dag/ops';
import { registerAllNodes } from '../../../nodes/registerAll';
import { gltfChildDagId } from '../../../core/import/gltfImportChain';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from '../../../app/bakedGltfChannels';
import { evaluate } from '../../../core/dag/evaluator';
import { validatePlan } from '../validate';
import type { MutatorValidationResult } from '../types';
import { poseBoneMutator, type PoseBoneSpec } from './poseBone';

registerAllNodes();

const ASSET = 'asset-posebone';
// THE DAG's SPELLING. Our `sanitizeBoneName` turns `mixamorig:Hips` into
// `mixamorig_Hips`; three's own sanitiser, which GLTFLoader runs, removes the
// colon instead and the LIVE scene calls the same bone `mixamorigHips`. Both
// spellings appear below on purpose — that divergence is the mutator's subject.
const BONES = ['mixamorig_Hips', 'mixamorig_Spine'] as const;
const NODE_NAME_MAP = Object.fromEntries(BONES.map((b) => [b, gltfChildDagId(ASSET, b)]));

function buildRig(
  bones: readonly string[] = BONES,
  opts: { skipSkeletonEdge?: boolean } = {},
): DagState {
  let s = emptyDagState();
  const add = (nodeId: string, nodeType: string, params: unknown) => {
    s = applyOp(s, { type: 'addNode', nodeId, nodeType, params }).next;
  };
  const wire = (from: string, socket: string, to: string, toSocket: string) => {
    s = applyOp(s, {
      type: 'connect',
      from: { node: from, socket },
      to: { node: to, socket: toSocket },
    }).next;
  };
  add('a_asset', 'GltfAsset', {
    assetRef: ASSET,
    nodeNameMap: Object.fromEntries(bones.map((b) => [b, gltfChildDagId(ASSET, b)])),
    skins: [
      {
        jointKeys: [...bones],
        bindTRS: bones.map(() => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })),
        parentJointIndex: bones.map((_, i) => (i === 0 ? -1 : 0)),
        inverseBindMatrices: [],
      },
    ],
  });
  add('a_skel', 'GltfSkeleton', { skinIndex: 0 });
  wire('a_asset', 'out', 'a_skel', 'asset');

  // The SOURCE rig + clip the retarget reads — a different skeleton, as in life.
  add('a_srcskel', 'Skeleton', {
    bones: [{ name: 'src_Hips', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] }],
  });
  add('a_srcclip', 'AnimationClip', {
    name: 'walk',
    duration: 2,
    keyframes: [
      { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { bone: 0, time: 2, position: [0, 4, 0], rotation: [0, Math.PI / 2, 0] },
    ],
  });
  wire('a_srcskel', 'out', 'a_srcclip', 'skeleton');
  add('a_map', 'BoneNameMap', { name: 'bridge', map: { src_Hips: bones[0] } });
  add('a_retarget', 'RetargetClip', { name: 'retargeted' });
  wire('a_srcclip', 'out', 'a_retarget', 'sourceClip');
  wire('a_map', 'out', 'a_retarget', 'boneMap');
  if (!opts.skipSkeletonEdge) wire('a_skel', 'out', 'a_retarget', 'skeleton');
  return s;
}

function plan(s: DagState, spec: PoseBoneSpec): MutatorValidationResult {
  return validatePlan(poseBoneMutator, spec, s, 'test');
}

/** Apply the mutator, failing loudly with the gate reason rather than silently. */
function pose(s: DagState, spec: PoseBoneSpec): DagState {
  const p = plan(s, spec);
  if (!p.ok) throw new Error(`gate ${p.gate}/${p.label}: ${p.reason}`);
  let out = s;
  for (const op of p.ops) out = applyOp(out, op).next;
  return out;
}

const overridesIn = (s: DagState) =>
  Object.entries(s.nodes).filter(([, n]) => n.type === 'PoseOverride');

const band = (s: DagState, bone: string, seconds = 0) =>
  sampleBakedChannel(bakedChannelSamplersForAsset(s.nodes, NODE_NAME_MAP, ASSET)[bone], seconds);

describe("poseBone — the bone name lands in the RIG's spelling (#993/#922)", () => {
  it('a caller using the LIVE three.js name stores the DAG name, and the band sees it', () => {
    const s = pose(buildRig(), {
      retarget: 'a_retarget',
      bone: 'mixamorigHips',
      rotation: [0, 0, 45],
    });
    const [[, node]] = overridesIn(s);
    // The stored param, directly — not merely "something rendered". A mutator that
    // stored the caller's spelling would still produce a node, and it is the NAME
    // that decides whether that node is inert.
    expect((node.params as { bone: string }).bone).toBe('mixamorig_Hips');
    expect(band(s, 'mixamorig_Hips')?.rotation).toEqual([0, 0, 45]);
  });

  it('an exact DAG-spelled name is passed through unchanged', () => {
    const s = pose(buildRig(), {
      retarget: 'a_retarget',
      bone: 'mixamorig_Spine',
      rotation: [5, 0, 0],
    });
    expect((overridesIn(s)[0][1].params as { bone: string }).bone).toBe('mixamorig_Spine');
  });

  it('a bone the rig does not carry is REFUSED, and NO override is left behind', () => {
    const before = buildRig();
    const p = plan(before, { retarget: 'a_retarget', bone: 'NotOnThisRig', rotation: [0, 0, 45] });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.label).toBe('precondition');
    // THE ABSENCE OF THE STRAY, not the health of `mixamorig_Hips`: an override
    // authored on a name no rig carries lands under a key nothing reads, so every
    // real bone stays exactly as correct as before and a neighbour-check cannot
    // see the defect.
    expect(overridesIn(before)).toHaveLength(0);
  });

  it('an ambiguous name — two bones sharing one canonical form — is refused, not guessed', () => {
    // `mixamorig_Hips` and `mixamorigHips` canonicalise identically, so
    // `resolveBoneNames` deliberately resolves NEITHER rather than picking one.
    const s = buildRig(['mixamorig_Hips', 'mixamorigHips']);
    const p = plan(s, { retarget: 'a_retarget', bone: 'MIXAMORIG-HIPS', rotation: [0, 0, 45] });
    expect(p.ok).toBe(false);
    expect(overridesIn(s)).toHaveLength(0);
  });
});

describe('poseBone — an override that authors nothing is unconstructible', () => {
  it('neither position nor rotation is REFUSED, and mints no node', () => {
    const s = buildRig();
    const p = plan(s, { retarget: 'a_retarget', bone: 'mixamorig_Hips' });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/position, rotation, or both/);
    expect(overridesIn(s)).toHaveLength(0);
  });

  it('a non-RetargetClip anchor is refused — the `posed` output is what the chain needs', () => {
    const s = buildRig();
    const p = plan(s, { retarget: 'a_srcclip', bone: 'mixamorig_Hips', rotation: [0, 0, 45] });
    expect(p.ok).toBe(false);
    expect(overridesIn(s)).toHaveLength(0);
  });

  it('a retarget whose `skeleton` input is unwired is refused', () => {
    // Built half-wired rather than disconnected after the fact: a graph
    // mid-construction is the state this refusal is actually for.
    const s = buildRig(BONES, { skipSkeletonEdge: true });
    const p = plan(s, { retarget: 'a_retarget', bone: 'mixamorig_Hips', rotation: [0, 0, 45] });
    expect(p.ok).toBe(false);
    expect(overridesIn(s)).toHaveLength(0);
  });
});

describe('poseBone — a repeat lands on the override already driving the bone', () => {
  it('a second pose on ONE bone extends it: still one node, both components authored', () => {
    let s = pose(buildRig(), {
      retarget: 'a_retarget',
      bone: 'mixamorigHips',
      rotation: [0, 0, 45],
    });
    // The other spelling on purpose — identity is the resolved bone, not the id.
    s = pose(s, { retarget: 'a_retarget', bone: 'mixamorig_Hips', position: [1, 2, 3] });
    expect(overridesIn(s)).toHaveLength(1);
    expect(band(s, 'mixamorig_Hips')).toEqual({ position: [1, 2, 3], rotation: [0, 0, 45] });
  });

  it('extending ONE component leaves the other authored component untouched', () => {
    // A STRICT NON-EMPTY SUBSET of the two flags on each call, so the interesting
    // arm is reached: with both authored every time, "does the untouched one
    // survive?" is never asked.
    let s = pose(buildRig(), {
      retarget: 'a_retarget',
      bone: 'mixamorig_Hips',
      rotation: [0, 0, 45],
    });
    s = pose(s, { retarget: 'a_retarget', bone: 'mixamorig_Hips', position: [1, 2, 3] });
    const p = overridesIn(s)[0][1].params as {
      rotation: number[];
      overridden: Record<string, boolean>;
    };
    expect(p.rotation).toEqual([0, 0, 45]);
    expect(p.overridden).toEqual({ rotation: true, position: true });
  });

  it('re-posing the same component overwrites it rather than stacking a second node', () => {
    let s = pose(buildRig(), {
      retarget: 'a_retarget',
      bone: 'mixamorig_Hips',
      rotation: [0, 0, 45],
    });
    s = pose(s, { retarget: 'a_retarget', bone: 'mixamorig_Hips', rotation: [0, 0, 90] });
    expect(overridesIn(s)).toHaveLength(1);
    expect(band(s, 'mixamorig_Hips')?.rotation).toEqual([0, 0, 90]);
  });
});

describe('poseBone — a second bone CHAINS, so the band and the value lane agree', () => {
  const twoBones = () => {
    let s = pose(buildRig(), {
      retarget: 'a_retarget',
      bone: 'mixamorigHips',
      rotation: [0, 0, 45],
    });
    s = pose(s, { retarget: 'a_retarget', bone: 'mixamorigSpine', rotation: [5, 0, 0] });
    return s;
  };

  it('the second override consumes the FIRST, not the retarget — no fan-out', () => {
    const s = twoBones();
    const chain = overridesIn(s);
    expect(chain).toHaveLength(2);
    const poseEdge = (id: string) =>
      (s.nodes[id].inputs as Record<string, { node?: string } | undefined>)?.pose?.node;
    const [first, second] = chain
      .map(([id]) => id)
      .sort((a, b) => (poseEdge(a) === 'a_retarget' ? -1 : poseEdge(b) === 'a_retarget' ? 1 : 0));
    // THE ABSENCE OF A SIBLING: exactly one override hangs off the retarget. Two
    // would each render in the band while the value lane carried only one — a
    // displayed-≠-rendered split rather than a visible failure.
    expect(poseEdge(first)).toBe('a_retarget');
    expect(poseEdge(second)).toBe(first);
    expect(chain.filter(([id]) => poseEdge(id) === 'a_retarget')).toHaveLength(1);
  });

  it('both bones reach the render band', () => {
    const s = twoBones();
    expect(band(s, 'mixamorig_Hips')?.rotation).toEqual([0, 0, 45]);
    expect(band(s, 'mixamorig_Spine')?.rotation).toEqual([5, 0, 0]);
  });

  it('the VALUE lane carries both bones too — the two roads do not disagree', () => {
    const s = twoBones();
    const poseEdge = (id: string) =>
      (s.nodes[id].inputs as Record<string, { node?: string } | undefined>)?.pose?.node;
    const consumed = new Set(overridesIn(s).map(([id]) => poseEdge(id)));
    const tip = overridesIn(s).find(([id]) => !consumed.has(id))![0];
    const value = evaluate(s, tip).value as {
      sample: (t: number) => readonly { rotation: readonly number[] }[];
    };
    const frame = value.sample(0);
    expect(frame[0].rotation).toEqual([0, 0, 45]);
    expect(frame[1].rotation).toEqual([5, 0, 0]);
  });
});
