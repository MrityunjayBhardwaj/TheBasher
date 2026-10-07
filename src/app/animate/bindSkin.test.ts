// #1353 — a mesh made here is bound to an armature made here, and bends by it: the plan, the
// Capture node it adds, and what the Armature modifier above it then does. Nothing is imported.
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../../core/dag/ops';
import { evaluate } from '../../core/dag';
import { __resetRegistryForTests } from '../../core/dag/registry';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import { quatFromEulerXYZ, restBonePose } from '../../nodes/bonePose';
import { Matrix4 } from 'three';
import { captureBonesOf, planCapture } from '../../nodes/CaptureModifier';
import { skinLanes } from '../../nodes/skinInfluences';
import type {
  MeshGeometryData,
  ModifiedDataValue,
  ObjectData,
  ObjectValue,
  PosedSkeletonValue,
} from '../../nodes/types';
import { meshDataProblem } from '../polygonLayout';
import { sceneOnlyState } from '../../test-utils/sceneOnlyState';
import { BIND, ringPoint, skinBindSceneOps } from '../../test-utils/skinBindScene';
import {
  armatureObjectsIn,
  armatureOf,
  captureStatusOf,
  captureStatusText,
  planBindSkin,
  setArmatureOps,
} from './bindSkin';

const CTX = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } } as never;
const run = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

let scene: DagState;
beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  scene = run(sceneOnlyState(), skinBindSceneOps());
});

/** Bind the cylinder and return the graph with what its stack now evaluates to. */
function bound(state = scene, req: { maxInfluences?: number; dropoff?: number } = {}) {
  const plan = planBindSkin(state, { mesh: BIND.mesh, armature: BIND.armature, ...req });
  if (!plan.ok) throw new Error(plan.reason);
  const next = run(state, plan.ops);
  const value = evaluate(next, plan.deformId, CTX).value as ModifiedDataValue;
  const descriptor = value.geometry.descriptor;
  if (descriptor.kind !== 'mesh') throw new Error(`a ${descriptor.kind}`);
  return { plan, state: next, value, mesh: descriptor.data };
}

/** Point `p`'s weight per group name. */
function weights(mesh: MeshGeometryData, p: number): Record<string, number> {
  const lanes = skinLanes(mesh)!;
  const out: Record<string, number> = {};
  for (let lane = 0; lane < lanes.width; lane++) {
    const w = lanes.weights[p * lanes.width + lane];
    if (w > 0) out[mesh.vertexGroups[lanes.joints[p * lanes.width + lane]]] = w;
  }
  return out;
}

/** The rest pose with `bone` turned by `euler` (radians) from its rest. */
function posed(value: ModifiedDataValue, bone: string, euler: [number, number, number]) {
  const skeleton = { kind: 'Skeleton' as const, bones: value.skin!.bones };
  const pose: PosedSkeletonValue = {
    kind: 'PosedSkeleton',
    skeleton,
    sample: () =>
      skeleton.bones.map((b) =>
        b.name === bone
          ? { ...restBonePose(b), quaternion: quatFromEulerXYZ(euler) }
          : restBonePose(b),
      ),
  };
  return { ...value.skin!, pose };
}

describe('#1353 — binding writes the weights the Armature modifier reads', () => {
  it('the stack is Capture then Armature, both pointed at the armature, in one step', () => {
    const { plan, state } = bound();
    expect(state.nodes[plan.captureId].type).toBe('CaptureModifier');
    expect(state.nodes[plan.deformId].type).toBe('ArmatureModifier');
    // Bottom to top: the stored mesh → Capture → Armature → the mesh's Object.
    expect((state.nodes[plan.captureId].inputs.target as { node: string }).node).toBe(
      BIND.meshData,
    );
    expect((state.nodes[plan.deformId].inputs.target as { node: string }).node).toBe(
      plan.captureId,
    );
    expect((state.nodes[BIND.mesh].inputs.data as { node: string }).node).toBe(plan.deformId);
    expect(armatureOf(state, plan.captureId)).toBe(BIND.armature);
    expect(armatureOf(state, plan.deformId)).toBe(BIND.armature);
  });

  it('one group per bone, by name, each joined to its bone', () => {
    const { value, mesh } = bound();
    expect(mesh.vertexGroups).toEqual([...BIND.bones]);
    expect(value.skin!.boneOfGroup).toEqual([0, 1, 2]);
    expect(meshDataProblem(mesh)).toBeNull();
    // The source mesh had no weights at all: every one of these was captured.
    const source = evaluate(scene, BIND.meshData, CTX).value as ModifiedDataValue;
    expect(skinLanes((source.geometry.descriptor as { data: MeshGeometryData }).data)).toBeNull();
  });

  it('weights along the tube, by hand: beside a bone, and across a joint', () => {
    const { mesh } = bound();
    // y = 0.5, beside the first bone: 0.25 from it, √0.3125 from the second (ratio² = 0.2 → 0.04),
    // √2.3125 from the third (ratio² = 0.0625/2.3125).
    const third = (0.0625 / 2.3125) ** 2;
    const total = 1 + 0.04 + third;
    const low = weights(mesh, ringPoint(0.5));
    expect(low.Bone).toBeCloseTo(1 / total, 5);
    expect(low['Bone.001']).toBeCloseTo(0.04 / total, 5);
    expect(low['Bone.002']).toBeCloseTo(third / total, 5);
    // Across the joint at y = 1 the second bone takes over, ring by ring, with no step.
    const across = [0.75, 1, 1.25].map((y) => weights(mesh, ringPoint(y))['Bone.001']);
    expect(across[0]).toBeCloseTo(0.25 / (1 + 0.25 + (0.0625 / 1.625) ** 2), 4);
    expect(across[1]).toBeCloseTo(1 / (2 + (0.0625 / 1.0625) ** 2), 4);
    expect(across[2]).toBeCloseTo(1 / (1 + 0.25 + (0.0625 / 0.625) ** 2), 4);
    // Every point of a ring is the same distance from the axis: same weights all the way round.
    const ring = ringPoint(1.25);
    for (let side = 1; side < BIND.radial; side++) {
      expect(weights(mesh, ring + side)['Bone.001']).toBeCloseTo(across[2], 5);
    }
    // And every point adds up to one.
    for (let p = 0; p < BIND.radial * BIND.rings; p++) {
      expect(Object.values(weights(mesh, p)).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 5);
    }
  });

  it('turning the middle bone bends the tube: the foot stays, the top follows, the joint blends', () => {
    const { value, mesh } = bound();
    const at = (p: number, out: Float32Array) => [out[p * 3], out[p * 3 + 1], out[p * 3 + 2]];
    const out = sampleSkinDeform(posed(value, 'Bone.001', [0, 0, Math.PI / 2]), mesh, 0);
    // Beside the middle bone (y = 1.5): 1/1.08 on it and 0.04/1.08 on each neighbour. The middle
    // and top bones carry it the same way (a quarter turn about the joint at y = 1), so it goes
    // 26/27 of the way from (0.25, 1.5) to (-0.5, 1.25).
    const mid = at(ringPoint(1.5), out);
    expect(mid[0]).toBeCloseTo(0.25 - (0.75 * 26) / 27, 4);
    expect(mid[1]).toBeCloseTo(1.5 - (0.25 * 26) / 27, 4);
    expect(mid[2]).toBeCloseTo(0, 6);
    // The foot barely moves, and the ring at the joint goes about half way.
    const foot = at(ringPoint(0), out);
    expect(Math.hypot(foot[0] - 0.25, foot[1])).toBeLessThan(0.01);
    const joint = at(ringPoint(1), out);
    // At rest (0.25, 1, 0); carried rigidly it would be at (0, 1.25, 0).
    expect(joint[0]).toBeCloseTo(0.25 * 0.5, 2);
    expect(joint[1]).toBeCloseTo(1.125, 2);
    // At rest, nothing moves at all.
    const rest = sampleSkinDeform({ ...value.skin!, pose: null }, mesh, 0);
    expect([...rest]).toEqual([...mesh.points]);
  });

  it('weights are measured where the armature stands relative to the mesh', () => {
    // The armature moved one unit along +X: the +X side of each ring is now nearer the bones.
    const moved = run(scene, [
      { type: 'setParam', nodeId: BIND.armature, paramPath: 'position', value: [1, 0, 0] } as Op,
    ]);
    const { mesh } = bound(moved);
    // Ring y = 0.5: the point at (0.25, 0.5, 0) is 0.75 from the first bone's axis at x = 1.
    const dNear = 0.75;
    const dSecond = Math.hypot(0.75, 0.5);
    const dThird = Math.hypot(0.75, 1.5);
    const raw = [1, (dNear / dSecond) ** 4, (dNear / dThird) ** 4];
    const w = weights(mesh, ringPoint(0.5));
    expect(w['Bone.001']).toBeCloseTo(raw[1] / (raw[0] + raw[1] + raw[2]), 5);
    // Not the answer of the armature standing at the origin.
    expect(w['Bone.001']).toBeGreaterThan(0.1);
  });

  it('the settings change the weights: fewer influences, and a gentler dropoff', () => {
    const one = bound(scene, { maxInfluences: 1 });
    expect(weights(one.mesh, ringPoint(0.5))).toEqual({ Bone: 1 });
    const gentle = bound(scene, { dropoff: 1 });
    // Linear: 1 : √0.2 : √(0.0625/2.3125).
    const second = Math.sqrt(0.2);
    const third = Math.sqrt(0.0625 / 2.3125);
    expect(weights(gentle.mesh, ringPoint(0.5))['Bone.001']).toBeCloseTo(
      second / (1 + second + third),
      5,
    );
    // Different weights are a different geometry; the same capture is the same one.
    expect(gentle.value.geometry.key).not.toBe(bound().value.geometry.key);
    expect(bound().value.geometry.key).toBe(bound().value.geometry.key);
    expect(bound().mesh).toBe(bound().mesh);
  });
});

describe('#1353 — only deforming bones are captured', () => {
  const withControl = () =>
    run(scene, [
      {
        type: 'setParam',
        nodeId: BIND.skeleton,
        paramPath: 'bones',
        value: [
          { name: 'Bone', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
          { name: 'Bone.001', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { name: 'Bone.002', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
          // A control right on the surface at the top of the tube, where it would take weights.
          { name: 'goal', parent: -1, position: [0.25, 3, 0], rotation: [0, 0, 0], deform: false },
        ],
      } as Op,
    ]);

  it('a bone marked as not deforming gets no group and no weight', () => {
    const { mesh, plan } = bound(withControl());
    expect(mesh.vertexGroups).toEqual([...BIND.bones]);
    expect(plan.capture.bones).toBe(3);
    expect(Object.keys(weights(mesh, ringPoint(3))).sort()).toEqual([...BIND.bones].sort());
  });

  it('and the same bone, deforming, holds the point it sits on', () => {
    const state = run(scene, [
      {
        type: 'setParam',
        nodeId: BIND.skeleton,
        paramPath: 'bones',
        value: [
          { name: 'Bone', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
          { name: 'Bone.001', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { name: 'Bone.002', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
          { name: 'goal', parent: -1, position: [0.25, 3, 0], rotation: [0, 0, 0] },
        ],
      } as Op,
    ]);
    const { mesh } = bound(state);
    expect(mesh.vertexGroups).toEqual([...BIND.bones, 'goal']);
    expect(weights(mesh, ringPoint(3))).toEqual({ goal: 1 });
  });
});

describe('#1353 — two bones of one name', () => {
  it('only the first is measured against: a group joins the first bone of its name', () => {
    const bones = captureBonesOf(
      [
        { name: 'Arm', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
        { name: 'Arm', parent: -1, position: [5, 0, 0], rotation: [0, 0, 0] },
        { name: 'Leg', parent: -1, position: [0, 5, 0], rotation: [0, 0, 0] },
      ],
      new Matrix4(),
    );
    expect(bones.map((b) => [b.name, b.head])).toEqual([
      ['Arm', [0, 0, 0]],
      ['Leg', [0, 5, 0]],
    ]);
  });
});

describe('#1353 — a bind that cannot be made says why', () => {
  const refusal = (state: DagState, mesh: string = BIND.mesh, armature: string = BIND.armature) => {
    const plan = planBindSkin(state, { mesh, armature });
    return plan.ok ? null : plan.reason;
  };

  it('something that is not an armature, or not in the scene', () => {
    expect(refusal(scene, BIND.mesh, BIND.mesh)).toMatch(/is not an armature/);
    expect(refusal(scene, BIND.mesh, 'nope')).toMatch(/"nope" is not in the scene/);
    expect(refusal(scene, 'nope')).toMatch(/"nope" is not in the scene/);
    expect(refusal(scene, BIND.armature)).toMatch(/has no mesh to bind/);
  });

  it('a mesh that is already bound', () => {
    const { state } = bound();
    expect(refusal(state)).toMatch(/already bound/);
  });

  it('a box: it has no stored points to hold weights', () => {
    const state = run(scene, [
      { type: 'addNode', nodeId: 'box_data', nodeType: 'BoxData', params: { size: [1, 1, 1] } },
      { type: 'addNode', nodeId: 'box', nodeType: 'Object', params: {} },
      {
        type: 'connect',
        from: { node: 'box_data', socket: 'out' },
        to: { node: 'box', socket: 'data' },
      },
    ] as Op[]);
    expect(refusal(state, 'box')).toMatch(/is a "box", and only a stored mesh/);
  });

  it('an armature with no deforming bone, or no bone', () => {
    const none = run(scene, [
      {
        type: 'setParam',
        nodeId: BIND.skeleton,
        paramPath: 'bones',
        value: [
          { name: 'ctl', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0], deform: false },
        ],
      } as Op,
    ]);
    expect(refusal(none)).toMatch(/none of the armature's 1 bones deforms/);
    const empty = run(scene, [
      { type: 'setParam', nodeId: BIND.skeleton, paramPath: 'bones', value: [] } as Op,
    ]);
    expect(refusal(empty)).toMatch(/the armature has no bones/);
  });
});

describe('#1353 — a Capture in a stack says what it did', () => {
  it('bound: the count of points and bones, and none unheld', () => {
    const { state, plan } = bound();
    const status = captureStatusOf(state, plan.captureId)!;
    expect(status.kind).toBe('captured');
    expect(captureStatusText(status)).toBe('104 points bound to 3 bones.');
    expect(captureStatusOf(state, plan.deformId)).toBeNull();
  });

  it('with its armature taken away it captures nothing, says so, and hands the mesh on as it came', () => {
    const { state, plan } = bound();
    const loose = run(state, setArmatureOps(state, plan.captureId, null));
    expect(armatureOf(loose, plan.captureId)).toBeNull();
    expect(captureStatusText(captureStatusOf(loose, plan.captureId)!)).toBe(
      'Nothing is captured: no armature is connected: pick the armature whose bones bind this mesh.',
    );
    const through = evaluate(loose, plan.captureId, CTX).value as ModifiedDataValue;
    const source = evaluate(loose, BIND.meshData, CTX).value as ModifiedDataValue;
    expect(through.kind).toBe('MeshData');
    expect(through.geometry.key).toBe(source.geometry.key);
    // Pointed back, it captures again.
    const again = run(loose, setArmatureOps(loose, plan.captureId, BIND.armature));
    expect(captureStatusOf(again, plan.captureId)!.kind).toBe('captured');
    expect(setArmatureOps(again, plan.captureId, BIND.armature)).toEqual([]);
  });

  it('a Capture above the Armature modifier is refused by name, and the deform is kept', () => {
    const { state, plan } = bound();
    const below = evaluate(state, plan.deformId, CTX).value as ObjectData;
    const armature = evaluate(state, BIND.armature, CTX).value as ObjectValue;
    const above = planCapture(below, armature, { maxInfluences: 4, dropoff: 4 });
    expect(above).toEqual({
      kind: 'refused',
      reason: expect.stringContaining('move Capture below the Armature modifier'),
    });
  });

  it('a point that is not a number is counted in the sentence', () => {
    expect(
      captureStatusText({
        kind: 'captured',
        data: {} as MeshGeometryData,
        key: 'k',
        bones: 1,
        points: 10,
        unbound: 2,
      }),
    ).toBe('10 points bound to 1 bone. 2 of them are held by no bone and stay at rest.');
  });

  it('a mesh that came with weights has them replaced, not added to', () => {
    const { mesh, state, plan } = bound();
    // Re-capture the captured mesh with one influence: the four-lane bind is gone.
    const armature = evaluate(state, BIND.armature, CTX).value as ObjectValue;
    const captured = evaluate(state, plan.captureId, CTX).value as ObjectData;
    const again = planCapture(captured, armature, { maxInfluences: 1, dropoff: 4 });
    if (again.kind !== 'captured') throw new Error(again.reason);
    expect(again.data.pointLayers.map((l) => l.name)).toEqual(['skin_joints', 'skin_weights']);
    expect(weights(again.data, ringPoint(1.25))).toEqual({ 'Bone.001': 1 });
    expect(Object.keys(weights(mesh, ringPoint(1.25))).length).toBe(3);
  });

  it('the armatures a bind can point at are the Objects holding a skeleton', () => {
    expect(armatureObjectsIn(scene)).toEqual([BIND.armature]);
  });
});
