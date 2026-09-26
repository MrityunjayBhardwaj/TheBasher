// #1240 — a pose layer between the motion and the armature Object edits what the character does.
//
// The native skinned bar (Blender 5.1.1's own export, `skinned-bar.glb`), with a `PoseLayer` wired
// between its motion (since #1211, the base layer holding the file's keys) and its armature Object's
// pose — the place step 3 of "Bones as Channels" puts it. Every oracle here is arithmetic on the rig, not our own sampler: Bone1's head is (0, 1, 0)
// and its top vertices are wholly Bone1's (#1213's rotation oracle), so a rotation R on Bone1 puts a
// top vertex at head + R·(rest − head). The deform itself already equals Blender's on this file
// (`skinnedDraw.test.ts`, `q13_skinned_bar_oracle.py`).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DetachedBindMode,
  Float32BufferAttribute,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { __resetRegistryForTests, applyOp, evaluate } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { registerAllNodes } from '../nodes/registerAll';
import { sampleSkinDeform } from '../nodes/armatureDeform';
import { quatFromEuler } from '../nodes/bonePose';
import { qmul, qpow } from '../nodes/quatMath';
import type { PoseLayerParams } from '../nodes/PoseLayer';
import {
  PoseLayerNode,
  PoseLayerParams as PoseLayerParamsSchema,
  poseLayerUnmatchedMembers,
} from '../nodes/PoseLayer';
import type {
  BonePose,
  MeshGeometryData,
  ObjectValue,
  PosedSkeletonValue,
  Quat,
  SkinDeformValue,
} from '../nodes/types';
import { buildMeshGeometry } from './meshGeometryData';
import { meshSplitLayout } from './polygonLayout';
import { buildSkinnedDraw } from './skinnedDraw';

const at = (seconds: number) => ({
  ctx: { time: { frame: seconds * 24, seconds, normalized: 0 } },
});
const DEG = Math.PI / 180;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

interface Rig {
  readonly state: DagState;
  readonly armatureId: string;
  /** What feeds the armature Object's pose on import: the base layer holding the file's keys. */
  readonly feed: { readonly node: string; readonly socket: string };
  readonly modifierId: string;
}

async function bar(): Promise<Rig> {
  let state = buildDefaultDagState();
  const bytes = readFileSync('public/assets/skinned-bar.glb');
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar.glb',
    sceneNodeId: state.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  for (const op of result.ops) state = applyOp(state, op).next;
  const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
  const armatureId = (state.nodes[modifierId].inputs.armature as { node: string }).node;
  const feed = state.nodes[armatureId].inputs.pose as { node: string; socket: string };
  return { state, armatureId, feed, modifierId };
}

/** Wire a layer between the motion and the armature Object's pose, as step 3 places it. */
function withLayer(rig: Rig, params: Partial<PoseLayerParams>, id = 'layer'): DagState {
  let s = applyOp(rig.state, {
    type: 'addNode',
    nodeId: id,
    nodeType: 'PoseLayer',
    params,
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: rig.feed,
    to: { node: id, socket: 'pose' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: id, socket: 'out' },
    to: { node: rig.armatureId, socket: 'pose' },
    replace: true,
  }).next;
  return s;
}

/** The armature Object's pose, as the deform, the bone draw and bone parenting read it. */
function objectPose(state: DagState, armatureId: string, seconds: number): readonly BonePose[] {
  const value = evaluate(state, armatureId, at(seconds)).value as ObjectValue;
  return (value as { pose: PosedSkeletonValue }).pose.sample(seconds);
}

function modifier(state: DagState, modifierId: string) {
  const value = evaluate(state, modifierId, at(0)).value as {
    geometry: { descriptor: { data: MeshGeometryData } };
    skin: SkinDeformValue;
  };
  return { mesh: value.geometry.descriptor.data, skin: value.skin };
}

/** The top vertices (rest y = 2), wholly Bone1's. */
function topVertices(mesh: MeshGeometryData): number[] {
  const top: number[] = [];
  for (let i = 0; i < mesh.points.length / 3; i++)
    if (mesh.points[i * 3 + 1] > 2 - 1e-6) top.push(i);
  return top;
}

/** head + R·(rest − head), Bone1's head at (0, 1, 0). */
function turned(mesh: MeshGeometryData, i: number, q: Quat): [number, number, number] {
  const v = new Vector3(mesh.points[i * 3], mesh.points[i * 3 + 1] - 1, mesh.points[i * 3 + 2]);
  v.applyQuaternion({ x: q[0], y: q[1], z: q[2], w: q[3] } as never);
  return [v.x, v.y + 1, v.z];
}

/** The angle between two rotations, by the metric that does not floor (V548). */
function angleDeg(a: Quat, b: Quat): number {
  const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
  const s = Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]);
  return (2 * Math.atan2(Math.min(d, s), Math.max(d, s)) * 2) / DEG;
}

const RZ90: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

describe('#1240 — a pose layer edits the character', () => {
  it('an override member poses its bone at 0.5 s: the chain and the deformed vertices move', async () => {
    const rig = await bar();
    const state = withLayer(rig, {
      members: [{ bone: 'Bone1', rotationMode: 'quaternion', quaternion: [...RZ90] }],
    });
    const pose = objectPose(state, rig.armatureId, 0.5);
    const own = objectPose(rig.state, rig.armatureId, 0.5);
    // The member bone takes the layer's rotation; the other bone keeps the clip's, by reference.
    expect(pose[1].quaternion).toEqual(RZ90);
    expect(pose[0]).toEqual(own[0]);
    expect(angleDeg(own[1].quaternion, RZ90), 'the clip had it elsewhere').toBeGreaterThan(1);

    const { mesh, skin } = modifier(state, rig.modifierId);
    const deformed = sampleSkinDeform(skin, mesh, 0.5);
    for (const i of topVertices(mesh)) {
      turned(mesh, i, RZ90).forEach((c, k) =>
        expect(deformed[i * 3 + k], `vertex ${i} axis ${k}`).toBeCloseTo(c, 5),
      );
    }
  });

  it('what is drawn is what the modifier evaluates, on every vertex, with the layer in', async () => {
    const rig = await bar();
    const state = withLayer(rig, {
      mode: 'additive',
      weight: 0.7,
      members: [{ bone: 'Bone1', rotationMode: 'XYZ', rotation: [10, -20, 35] }],
    });
    const { mesh, skin } = modifier(state, rig.modifierId);
    const draw = buildSkinnedDraw(skin, mesh);
    const geometry = buildMeshGeometry(mesh).geometry;
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(draw.skinIndex, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(draw.skinWeight, 4));
    const skinned = new SkinnedMesh(geometry);
    skinned.bindMode = DetachedBindMode;
    skinned.bind(draw.skeleton, draw.bindMatrix);
    const { vertexCorner } = meshSplitLayout(mesh);
    const v3 = new Vector3();
    for (const t of [0, 0.5, 1]) {
      draw.pose(t, skin.pose);
      const expected = sampleSkinDeform(skin, mesh, t);
      let worst = 0;
      for (let v = 0; v < vertexCorner.length; v++) {
        const got = skinned.getVertexPosition(v, v3);
        const p = mesh.cornerPoints[vertexCorner[v]];
        worst = Math.max(
          worst,
          Math.hypot(
            got.x - expected[p * 3],
            got.y - expected[p * 3 + 1],
            got.z - expected[p * 3 + 2],
          ),
        );
      }
      expect(worst, `worst vertex at ${t}s`).toBeLessThan(1e-5);
    }
  });

  it('an additive layer at weight 0.5 moves the bone halfway', async () => {
    const rig = await bar();
    const delta = quatFromEuler([0, 0, 40 * DEG], 'XYZ');
    const state = withLayer(rig, {
      mode: 'additive',
      weight: 0.5,
      members: [{ bone: 'Bone1', rotationMode: 'XYZ', rotation: [0, 0, 40] }],
    });
    for (const t of [0, 0.5, 1]) {
      const own = objectPose(rig.state, rig.armatureId, t)[1].quaternion;
      const got = objectPose(state, rig.armatureId, t)[1].quaternion;
      // Combine is lower ⊗ value^w: 20° on top of the clip, in the bone's local frame.
      const want = qmul(own, qpow(delta, 0.5));
      want.forEach((c, k) => expect(got[k], `t ${t} component ${k}`).toBeCloseTo(c, 9));
      expect(angleDeg(own, got), `halfway at ${t}s`).toBeCloseTo(20, 6);
    }
  });

  it('a keyed layer on a looping motion cycles with it', async () => {
    const rig = await bar();
    // The motion loops (every base channel cycles, as a Blender F-curve with a Cycles modifier), and
    // the layer's key curve cycles over the same one-second period.
    const base = rig.state.nodes[rig.feed.node].params as PoseLayerParams;
    const looping: Rig = {
      ...rig,
      state: applyOp(rig.state, {
        type: 'setParam',
        nodeId: rig.feed.node,
        paramPath: 'channels',
        value: base.channels.map((c) => ({ ...c, extendBefore: 'cycle', extendAfter: 'cycle' })),
      }).next,
    };
    const state = withLayer(looping, {
      mode: 'additive',
      members: [{ bone: 'Bone0', rotationMode: 'XYZ' }],
      channels: [
        {
          bone: 'Bone0',
          component: 'rotation',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 1, value: [0, 0, 30], easing: 'linear' },
          ],
          modifiers: [
            {
              type: 'cycles',
              beforeMode: 'repeat',
              afterMode: 'repeat',
              beforeCycles: 0,
              afterCycles: 0,
            },
          ],
        },
      ] as PoseLayerParams['channels'],
    });
    for (const t of [0.25, 0.5, 0.75]) {
      const first = objectPose(state, rig.armatureId, t);
      const later = objectPose(state, rig.armatureId, t + 2);
      first.forEach((b, i) =>
        b.quaternion.forEach((c, k) =>
          expect(later[i].quaternion[k], `bone ${i} q${k} at ${t}+2s`).toBeCloseTo(c, 9),
        ),
      );
    }
    // And the key curve really is in: Bone0 carries 15° of Z at 0.5 s on top of the clip's rest.
    const own = objectPose(looping.state, rig.armatureId, 2.5)[0].quaternion;
    expect(angleDeg(own, objectPose(state, rig.armatureId, 2.5)[0].quaternion)).toBeCloseTo(15, 6);
  });

  it('a quaternion key curve cycles by its own extend rule', async () => {
    const rig = await bar();
    const state = withLayer(rig, {
      members: [{ bone: 'Bone1', rotationMode: 'quaternion' }],
      channels: [
        {
          bone: 'Bone1',
          component: 'quaternion',
          extendAfter: 'cycle',
          keyframes: [
            { time: 0, value: [0, 0, 0, 1], easing: 'linear' },
            { time: 1, value: [...RZ90], easing: 'linear' },
          ],
        },
      ] as PoseLayerParams['channels'],
    });
    const q = (t: number) => objectPose(state, rig.armatureId, t)[1].quaternion;
    expect(angleDeg(q(0.5), [0, 0, 0, 1])).toBeCloseTo(45, 6);
    q(0.25).forEach((c, k) => expect(q(3.25)[k]).toBeCloseTo(c, 9));
  });

  it('a keyed weight ramps the layer in', async () => {
    const rig = await bar();
    const state = withLayer(rig, {
      members: [{ bone: 'Bone1', rotationMode: 'quaternion', quaternion: [...RZ90] }],
      channels: [
        {
          component: 'weight',
          keyframes: [
            { time: 0, value: 0, easing: 'linear' },
            { time: 1, value: 1, easing: 'linear' },
          ],
        },
      ] as PoseLayerParams['channels'],
    });
    const own = (t: number) => objectPose(rig.state, rig.armatureId, t)[1].quaternion;
    const got = (t: number) => objectPose(state, rig.armatureId, t)[1].quaternion;
    expect(got(0)).toEqual(own(0));
    got(1).forEach((c, k) => expect(c).toBeCloseTo(RZ90[k], 9));
  });

  it('a muted layer, or one with no members, hands the incoming pose back unchanged', async () => {
    const rig = await bar();
    const upstream = evaluate(rig.state, rig.feed.node, { socket: rig.feed.socket, ...at(0) })
      .value as PosedSkeletonValue;
    // The node's own claim, asked of the node with one input value in hand: the very same object.
    for (const params of [
      {
        mute: true,
        members: [{ bone: 'Bone1', rotationMode: 'quaternion' as const, quaternion: RZ90 }],
      },
      { members: [] },
    ]) {
      const value = PoseLayerNode.evaluate(
        PoseLayerParamsSchema.parse(params),
        { pose: upstream },
        at(0).ctx,
      );
      expect(value).toBe(upstream);
    }
    // And a live layer is not a pass-through, so the row above can fail.
    const live = PoseLayerNode.evaluate(
      PoseLayerParamsSchema.parse({
        members: [{ bone: 'Bone1', rotationMode: 'quaternion', quaternion: RZ90 }],
      }),
      { pose: upstream },
      at(0).ctx,
    );
    expect(live).not.toBe(upstream);
  });

  it('a rotation curve for another mode is ignored, as Blender ignores it', async () => {
    const rig = await bar();
    const state = withLayer(rig, {
      members: [{ bone: 'Bone1', rotationMode: 'quaternion' }],
      channels: [
        {
          bone: 'Bone1',
          component: 'rotation',
          keyframes: [{ time: 0, value: [0, 0, 90], easing: 'linear' }],
        },
      ] as PoseLayerParams['channels'],
    });
    const own = objectPose(rig.state, rig.armatureId, 0.5)[1];
    expect(objectPose(state, rig.armatureId, 0.5)[1]).toEqual(own);
  });

  it('an euler member rotates in its own order, named as Blender names it', async () => {
    const rig = await bar();
    const e: [number, number, number] = [30, -50, 70];
    for (const order of ['XYZ', 'ZYX', 'YZX'] as const) {
      const state = withLayer(rig, {
        members: [{ bone: 'Bone1', rotationMode: order, rotation: e }],
      });
      const want = quatFromEuler([e[0] * DEG, e[1] * DEG, e[2] * DEG], order);
      objectPose(state, rig.armatureId, 0.5)[1].quaternion.forEach((c, k) =>
        expect(c, `${order} q${k}`).toBeCloseTo(want[k], 9),
      );
    }
  });

  it('a member naming no bone does nothing, and is counted, zero included', async () => {
    const rig = await bar();
    const skeleton = (
      evaluate(rig.state, rig.feed.node, { socket: rig.feed.socket, ...at(0) })
        .value as PosedSkeletonValue
    ).skeleton;
    expect(
      poseLayerUnmatchedMembers({ members: [{ bone: 'Bone1', rotationMode: 'XYZ' }] }, skeleton),
    ).toEqual([]);
    const members = [
      {
        bone: 'Bone1',
        rotationMode: 'XYZ' as const,
        rotation: [0, 0, 10] as [number, number, number],
      },
      {
        bone: 'Tail',
        rotationMode: 'XYZ' as const,
        rotation: [0, 0, 10] as [number, number, number],
      },
    ];
    expect(poseLayerUnmatchedMembers({ members }, skeleton)).toEqual(['Tail']);
    const state = withLayer(rig, { members });
    expect(objectPose(state, rig.armatureId, 0.5)).toHaveLength(2);
  });
});

/** Two layers stacked between the clip and the Object: `lower` reads the clip, `upper` feeds the Object. */
function withTwoLayers(rig: Rig, lower: Partial<PoseLayerParams>, upper: Partial<PoseLayerParams>) {
  let s = withLayer(rig, lower, 'lower');
  s = applyOp(s, { type: 'addNode', nodeId: 'upper', nodeType: 'PoseLayer', params: upper }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'lower', socket: 'out' },
    to: { node: 'upper', socket: 'pose' },
  }).next;
  return applyOp(s, {
    type: 'connect',
    from: { node: 'upper', socket: 'out' },
    to: { node: rig.armatureId, socket: 'pose' },
    replace: true,
  }).next;
}

describe('#1241 — a soloed layer plays alone over the source', () => {
  const add = (degrees: number, solo = false): Partial<PoseLayerParams> => ({
    mode: 'additive',
    solo,
    members: [{ bone: 'Bone1', rotationMode: 'XYZ', rotation: [0, 0, degrees] }],
  });
  const turned = async (lower: Partial<PoseLayerParams>, upper: Partial<PoseLayerParams>) => {
    const rig = await bar();
    const state = withTwoLayers(rig, lower, upper);
    const own = objectPose(rig.state, rig.armatureId, 0.5)[1].quaternion;
    return angleDeg(own, objectPose(state, rig.armatureId, 0.5)[1].quaternion);
  };

  it('with no solo, both layers fold', async () => {
    expect(await turned(add(30), add(20))).toBeCloseTo(50, 6);
  });
  it('the lower one soloed: the upper is silent', async () => {
    expect(await turned(add(30, true), add(20))).toBeCloseTo(30, 6);
  });
  it('the upper one soloed: the lower is skipped', async () => {
    expect(await turned(add(30), add(20, true))).toBeCloseTo(20, 6);
  });
  it('both soloed: both play', async () => {
    expect(await turned(add(30, true), add(20, true))).toBeCloseTo(50, 6);
  });
  it('an empty soloed layer silences the rest: the source plays alone', async () => {
    expect(await turned(add(30), { solo: true, members: [] })).toBeCloseTo(0, 6);
  });
});
