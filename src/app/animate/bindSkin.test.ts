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
import {
  captureBonesOf,
  captureSettingsOf,
  planCapture,
  type CaptureSettings,
} from '../../nodes/CaptureModifier';
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
import { cylinderMesh } from '../../test-utils/cylinderMesh';
import { packMeshData } from '../meshGeometryData';
import {
  armatureObjectsIn,
  armatureOf,
  captureIsWhole,
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
function bound(state = scene, req: Partial<CaptureSettings> = {}) {
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
    const above = planCapture(below, armature, captureSettingsOf({}));
    expect(above).toEqual({
      kind: 'refused',
      reason: expect.stringContaining('move Capture below the Armature modifier'),
    });
  });

  it('a point that is not a number is counted in the sentence', () => {
    expect(
      captureStatusText({
        kind: 'captured',
        method: 'proximity',
        data: {} as MeshGeometryData,
        key: 'k',
        bones: 1,
        points: 10,
        unbound: 2,
        unreached: 0,
        outside: [],
      }),
    ).toBe('10 points bound to 1 bone. 2 of them are held by no bone and stay at rest.');
  });

  it('a mesh that came with weights has them replaced, not added to', () => {
    const { mesh, state, plan } = bound();
    // Re-capture the captured mesh with one influence: the four-lane bind is gone.
    const armature = evaluate(state, BIND.armature, CTX).value as ObjectValue;
    const captured = evaluate(state, plan.captureId, CTX).value as ObjectData;
    const again = planCapture(captured, armature, captureSettingsOf({ maxInfluences: 1 }));
    if (again.kind !== 'captured') throw new Error(again.reason);
    expect(again.data.pointLayers.map((l) => l.name)).toEqual(['skin_joints', 'skin_weights']);
    expect(weights(again.data, ringPoint(1.25))).toEqual({ 'Bone.001': 1 });
    expect(Object.keys(weights(mesh, ringPoint(1.25))).length).toBe(3);
  });

  it('the armatures a bind can point at are the Objects holding a skeleton', () => {
    expect(armatureObjectsIn(scene)).toEqual([BIND.armature]);
  });
});

describe('#1539 — the voxel method: the same bind, distance measured through the mesh', () => {
  it('a setting left out takes the Capture node’s own default, in one place', () => {
    expect(captureSettingsOf({})).toEqual({
      method: 'proximity',
      maxInfluences: 4,
      dropoff: 4,
      resolution: 128,
      falloff: 0.2,
    });
    expect(captureSettingsOf({ method: 'voxel', resolution: undefined, falloff: 1 })).toEqual({
      method: 'voxel',
      maxInfluences: 4,
      dropoff: 4,
      resolution: 128,
      falloff: 1,
    });
  });

  it('a bind by voxel stores the method on the Capture, and weights the open tube whole', () => {
    const { plan, state, mesh, value } = bound(scene, { method: 'voxel', resolution: 64 });
    expect(state.nodes[plan.captureId].params).toMatchObject({ method: 'voxel', resolution: 64 });
    expect(plan.capture).toMatchObject({ method: 'voxel', unbound: 0, unreached: 0, outside: [] });
    // The same layers and the same groups the proximity bind writes: the reader cannot tell.
    expect(mesh.pointLayers.map((l) => l.name)).toEqual(['skin_joints', 'skin_weights']);
    expect(mesh.vertexGroups).toEqual([...BIND.bones]);
    expect(value.skin!.boneOfGroup).toEqual([0, 1, 2]);
    expect(meshDataProblem(mesh)).toBeNull();
    for (let p = 0; p < BIND.radial * BIND.rings; p++) {
      expect(Object.values(weights(mesh, p)).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 5);
    }
    // Beside the middle of the middle bone, near the inverse square of distance: 1 : 0.2 : 0.2.
    expect(weights(mesh, ringPoint(1.5))['Bone.001']).toBeCloseTo(1 / 1.4, 1);
    const status = captureStatusOf(state, plan.captureId)!;
    expect(captureStatusText(status)).toBe('104 points bound to 3 bones.');
    expect(captureIsWhole(status)).toBe(true);
  });

  it('turning the middle bone bends the voxel-bound tube: the foot stays and the top follows', () => {
    const { value, mesh } = bound(scene, { method: 'voxel', resolution: 64 });
    const out = sampleSkinDeform(posed(value, 'Bone.001', [0, 0, Math.PI / 2]), mesh, 0);
    const at = (p: number) => [out[p * 3], out[p * 3 + 1], out[p * 3 + 2]];
    // The foot ring is held by the first bone, which did not turn — but not by it alone. At
    // falloff 0.2 weight goes near the inverse square of distance, 1 : 0.059 : 0.015 here, so the
    // two turned bones hold 7% of the foot and carry it 7% of the 1.46 they would carry it rigidly.
    const foot = at(ringPoint(0));
    const moved = Math.hypot(foot[0] - 0.25, foot[1]);
    expect(moved).toBeGreaterThan(0.05);
    expect(moved).toBeLessThan(0.13);
    // A falloff of 1 is the inverse fourth power, and the foot stays.
    const rigid = bound(scene, { method: 'voxel', resolution: 64, falloff: 1 });
    const held = sampleSkinDeform(
      posed(rigid.value, 'Bone.001', [0, 0, Math.PI / 2]),
      rigid.mesh,
      0,
    );
    expect(Math.hypot(held[ringPoint(0) * 3] - 0.25, held[ringPoint(0) * 3 + 1])).toBeLessThan(
      0.02,
    );
    // The top ring (rest (0.25, 3, 0)) is carried a quarter turn about the joint at y = 1, to
    // (-2, 1.25, 0), less the little the first bone still holds of it.
    const top = at(ringPoint(3));
    expect(top[0]).toBeLessThan(-1.8);
    expect(top[1]).toBeCloseTo(1.25, 0);
    // The ring at the joint goes part of the way: a blend, not a step.
    const joint = at(ringPoint(1));
    expect(joint[0]).toBeGreaterThan(0.02);
    expect(joint[0]).toBeLessThan(0.23);
  });

  it('only the settings the method reads make a new capture', () => {
    const key = (req: Partial<CaptureSettings>) => bound(scene, req).value.geometry.key;
    const voxel = key({ method: 'voxel', resolution: 32 });
    expect(voxel).not.toBe(key({ method: 'proximity' }));
    expect(key({ method: 'voxel', resolution: 48 })).not.toBe(voxel);
    expect(key({ method: 'voxel', resolution: 32, falloff: 0.9 })).not.toBe(voxel);
    expect(key({ method: 'voxel', resolution: 32, maxInfluences: 2 })).not.toBe(voxel);
    // `dropoff` is the proximity method's; `resolution` and `falloff` are this one's.
    expect(key({ method: 'voxel', resolution: 32, dropoff: 9 })).toBe(voxel);
    expect(key({ method: 'proximity', resolution: 32, falloff: 0.9 })).toBe(key({}));
    // And a capture already made is handed back, not made again.
    expect(bound(scene, { method: 'voxel', resolution: 32 }).mesh).toBe(
      bound(scene, { method: 'voxel', resolution: 32, dropoff: 9 }).mesh,
    );
  });

  it('a bone standing outside the mesh is named in the sentence, and the capture is not whole', () => {
    // The armature moved a unit aside: no bone is in the tube, so every point falls back.
    const moved = run(scene, [
      { type: 'setParam', nodeId: BIND.armature, paramPath: 'position', value: [1, 0, 0] } as Op,
    ]);
    const { state, plan } = bound(moved, { method: 'voxel', resolution: 32 });
    const status = captureStatusOf(state, plan.captureId)!;
    expect(captureStatusText(status)).toBe(
      '104 points bound to 3 bones. 104 could not be reached through the mesh’s inside and are bound by straight-line distance instead. 3 bones lie outside the mesh’s volume, so nothing is measured from them: Bone, Bone.001, Bone.002.'.replace(
        /’/g,
        "'",
      ),
    );
    expect(captureIsWhole(status)).toBe(false);
    // The same armature by proximity has nothing to report.
    const near = bound(moved);
    expect(captureIsWhole(captureStatusOf(near.state, near.plan.captureId)!)).toBe(true);
  });

  it('the sentence names three outside bones and counts the rest; one bone reads as one', () => {
    const base = {
      kind: 'captured' as const,
      method: 'voxel' as const,
      data: {} as MeshGeometryData,
      key: 'k',
      bones: 9,
      points: 10,
      unbound: 0,
      unreached: 0,
    };
    expect(captureStatusText({ ...base, outside: ['a', 'b', 'c', 'd', 'e'] })).toBe(
      "10 points bound to 9 bones. 5 bones lie outside the mesh's volume, so nothing is measured from them: a, b, c and 2 more.",
    );
    expect(captureStatusText({ ...base, outside: ['a'] })).toBe(
      "10 points bound to 9 bones. 1 bone lies outside the mesh's volume, so nothing is measured from it: a.",
    );
    expect(captureIsWhole({ ...base, outside: [] })).toBe(true);
    expect(captureIsWhole({ ...base, outside: ['a'] })).toBe(false);
    expect(captureIsWhole({ ...base, outside: [], unreached: 1 })).toBe(false);
    expect(captureIsWhole({ ...base, outside: [], unbound: 1 })).toBe(false);
    expect(captureIsWhole({ kind: 'refused', reason: 'x' })).toBe(false);
  });

  it('a mesh with points and no faces has no inside: voxel refuses it by name, proximity binds it', () => {
    const tube = cylinderMesh(BIND);
    const points = packMeshData({
      ...tube,
      faceSizes: new Uint32Array(0),
      cornerPoints: new Uint32Array(0),
    });
    const faceless = run(scene, [
      { type: 'setParam', nodeId: BIND.meshData, paramPath: 'mesh', value: points } as Op,
    ]);
    const refused = planBindSkin(faceless, {
      mesh: BIND.mesh,
      armature: BIND.armature,
      method: 'voxel',
    });
    expect(refused).toEqual({
      ok: false,
      reason:
        'the mesh has no faces, or no size, so it has no inside to measure through: use the proximity method.',
    });
    expect(planBindSkin(faceless, { mesh: BIND.mesh, armature: BIND.armature }).ok).toBe(true);
  });
});

describe('#1356 — the heat method: the same bind, distance measured along the skin', () => {
  it('a bind by heat stores the method on the Capture, and weights the open tube whole', () => {
    const { plan, state, mesh, value } = bound(scene, { method: 'heat' });
    expect(state.nodes[plan.captureId].params).toMatchObject({ method: 'heat', maxInfluences: 4 });
    expect(plan.capture).toMatchObject({ method: 'heat', unbound: 0, unreached: 0, outside: [] });
    // The same layers and the same groups the other two methods write: the reader cannot tell.
    expect(mesh.pointLayers.map((l) => l.name)).toEqual(['skin_joints', 'skin_weights']);
    expect(mesh.vertexGroups).toEqual([...BIND.bones]);
    expect(value.skin!.boneOfGroup).toEqual([0, 1, 2]);
    expect(meshDataProblem(mesh)).toBeNull();
    for (let p = 0; p < BIND.radial * BIND.rings; p++) {
      expect(Object.values(weights(mesh, p)).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 5);
    }
    expect(weights(mesh, ringPoint(0.5))['Bone']).toBeGreaterThan(0.85);
    expect(weights(mesh, ringPoint(1.5))['Bone.001']).toBeGreaterThan(0.75);
    const status = captureStatusOf(state, plan.captureId)!;
    expect(captureStatusText(status)).toBe('104 points bound to 3 bones.');
    expect(captureIsWhole(status)).toBe(true);
  });

  it('turning the middle bone bends the heat-bound tube: the foot stays and the top follows', () => {
    const { value, mesh } = bound(scene, { method: 'heat' });
    const out = sampleSkinDeform(posed(value, 'Bone.001', [0, 0, Math.PI / 2]), mesh, 0);
    const at = (p: number) => [out[p * 3], out[p * 3 + 1], out[p * 3 + 2]];
    // The foot ring is the first bone's but for a little: it stays within a few hundredths.
    const foot = at(ringPoint(0));
    expect(Math.hypot(foot[0] - 0.25, foot[1])).toBeLessThan(0.05);
    // The top ring (rest (0.25, 3, 0)) is carried a quarter turn about the joint at y = 1, to
    // (-2, 1.25, 0).
    const top = at(ringPoint(3));
    expect(top[0]).toBeLessThan(-1.9);
    expect(top[1]).toBeCloseTo(1.25, 1);
    // The ring at the joint goes part of the way: a blend, not a step.
    const joint = at(ringPoint(1));
    expect(joint[0]).toBeGreaterThan(0.02);
    expect(joint[0]).toBeLessThan(0.23);
  });

  it('only the one setting the method reads makes a new capture', () => {
    const key = (req: Partial<CaptureSettings>) => bound(scene, req).value.geometry.key;
    const heat = key({ method: 'heat' });
    expect(heat).not.toBe(key({ method: 'proximity' }));
    expect(heat).not.toBe(key({ method: 'voxel', resolution: 32 }));
    expect(key({ method: 'heat', maxInfluences: 2 })).not.toBe(heat);
    // `dropoff` is the proximity method's; `resolution` and `falloff` the voxel method's.
    expect(key({ method: 'heat', dropoff: 9 })).toBe(heat);
    expect(key({ method: 'heat', resolution: 48, falloff: 0.9 })).toBe(heat);
    // And a capture already made is handed back, not made again.
    expect(bound(scene, { method: 'heat' }).mesh).toBe(
      bound(scene, { method: 'heat', resolution: 48, dropoff: 9 }).mesh,
    );
  });

  it('a tube with its bones beside it has none in sight: it is bound by nearness, and the sentence says so', () => {
    // The armature moved a unit aside: from the wall facing it the bones are in front, and from
    // the far wall the near one is in the way.
    const moved = run(scene, [
      { type: 'setParam', nodeId: BIND.armature, paramPath: 'position', value: [1, 0, 0] } as Op,
    ]);
    const { state, plan } = bound(moved, { method: 'heat' });
    const status = captureStatusOf(state, plan.captureId)!;
    expect(captureStatusText(status)).toBe(
      '104 points bound to 3 bones. 104 are on parts with no bone in sight from inside, and are bound by nearness instead.',
    );
    expect(captureIsWhole(status)).toBe(false);
  });

  it('the sentence names three bones that hold nothing and counts the rest; one bone reads as one', () => {
    const base = {
      kind: 'captured' as const,
      method: 'heat' as const,
      data: {} as MeshGeometryData,
      key: 'k',
      bones: 9,
      points: 10,
      unbound: 0,
      unreached: 0,
    };
    expect(captureStatusText({ ...base, outside: ['a', 'b', 'c', 'd', 'e'] })).toBe(
      '10 points bound to 9 bones. 5 bones hold no point: a, b, c and 2 more.',
    );
    expect(captureStatusText({ ...base, outside: ['a'] })).toBe(
      '10 points bound to 9 bones. 1 bone holds no point: a.',
    );
    expect(captureIsWhole({ ...base, outside: ['a'] })).toBe(false);
  });

  it('a mesh with points and no faces has no surface: heat refuses it by name', () => {
    const tube = cylinderMesh(BIND);
    const points = packMeshData({
      ...tube,
      faceSizes: new Uint32Array(0),
      cornerPoints: new Uint32Array(0),
    });
    const faceless = run(scene, [
      { type: 'setParam', nodeId: BIND.meshData, paramPath: 'mesh', value: points } as Op,
    ]);
    expect(
      planBindSkin(faceless, { mesh: BIND.mesh, armature: BIND.armature, method: 'heat' }),
    ).toEqual({
      ok: false,
      reason:
        'the mesh has no faces, or no size, so it has no surface for heat to spread over: use the proximity method.',
    });
  });

  it('one skin too big to work heat out across without freezing is refused by name, and the refusal is kept', () => {
    // 266,240 points in one piece: with three bones, just past the limit.
    const big = packMeshData(
      cylinderMesh({ radius: BIND.radius, height: BIND.height, radial: 512, rings: 520 }),
    );
    const dense = run(scene, [
      { type: 'setParam', nodeId: BIND.meshData, paramPath: 'mesh', value: big } as Op,
    ]);
    const refused = planBindSkin(dense, {
      mesh: BIND.mesh,
      armature: BIND.armature,
      method: 'heat',
    });
    expect(refused).toEqual({
      ok: false,
      reason:
        "the mesh's largest piece has 266240 points, and heat is worked out across a whole piece for each of the 3 bones: on a piece that size the app would stand frozen. Use the voxel method, which does not grow that way.",
    });
    // A Capture already on such a mesh says the same, and does not ask the mesh again to say it.
    const near = bound(dense);
    const heat = run(near.state, [
      { type: 'setParam', nodeId: near.plan.captureId, paramPath: 'method', value: 'heat' } as Op,
    ]);
    const status = captureStatusOf(heat, near.plan.captureId)!;
    expect(captureStatusText(status)).toMatch(/^Nothing is captured: the mesh's largest piece has/);
    expect(captureStatusOf(heat, near.plan.captureId)).toBe(status);
  });
});
