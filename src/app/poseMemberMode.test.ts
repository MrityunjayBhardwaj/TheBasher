// #1242 — a pose layer member's rotation mode: the synchronized kind, and changing the mode.
//
// Every row compares the member's rotation before and after, through the layer the armature Object
// reads (the native skinned bar, Bone1), and uses the angle metric that does not floor (V548). The
// oracle for "the same rotation" is the layer's own reading of the old keys — that is what the
// director saw — so these rows pin that a change of mode keeps the pose where the method promises.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { registerAllNodes } from '../nodes/registerAll';
import { validatePlan } from '../agent/mutators/index';
import { setPoseMemberModeMutator } from '../agent/mutators/builders/setPoseMemberMode';
import { quatFromEuler } from '../nodes/bonePose';
import { slerp } from '../nodes/quatMath';
import type { PoseLayerParams, PoseLayerChannel } from '../nodes/PoseLayer';
import type { ObjectValue, PosedSkeletonValue, Quat } from '../nodes/types';

const DEG = Math.PI / 180;
const at = (seconds: number) => ({
  ctx: { time: { frame: seconds * 24, seconds, normalized: 0 } },
});

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

async function rig(
  layer: Partial<PoseLayerParams>,
): Promise<{ state: DagState; armatureId: string }> {
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
  const clip = state.nodes[armatureId].inputs.pose as { node: string; socket: string };
  const ops: Op[] = [
    { type: 'addNode', nodeId: 'layer', nodeType: 'PoseLayer', params: layer },
    { type: 'connect', from: clip, to: { node: 'layer', socket: 'pose' } },
    {
      type: 'connect',
      from: { node: 'layer', socket: 'out' },
      to: { node: armatureId, socket: 'pose' },
      replace: true,
    },
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return { state, armatureId };
}

/** A spec parsed as the tool boundary parses it, so the builder sees the defaults the product sends:
 *  `validatePlan` does not parse, and an unparsed spec would reach it without `method` or `fps`. */
const specOf = (spec: Record<string, unknown>) =>
  setPoseMemberModeMutator.spec.parse({ layer: 'layer', bone: 'Bone1', ...spec });

function change(state: DagState, spec: Record<string, unknown>): DagState {
  const plan = validatePlan(setPoseMemberModeMutator, specOf(spec), state, 'mode');
  if (!plan.ok) throw new Error(plan.reason);
  let next = state;
  for (const op of plan.ops as Op[]) next = applyOp(next, op).next;
  return next;
}

function bone1(state: DagState, armatureId: string, t: number): Quat {
  const value = evaluate(state, armatureId, at(t)).value as ObjectValue;
  return (value as { pose: PosedSkeletonValue }).pose.sample(t)[1].quaternion;
}

function angleDeg(a: Quat, b: Quat): number {
  const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
  const s = Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]);
  return (4 * Math.atan2(Math.min(d, s), Math.max(d, s))) / DEG;
}

const EULER_KEYS = [
  { time: 0, value: [10, -20, 30], easing: 'linear' },
  { time: 0.5, value: [80, 40, -60], easing: 'linear' },
  { time: 1, value: [-30, 70, 120], easing: 'linear' },
];

const eulerLayer = (
  order: string,
  extra: Partial<PoseLayerChannel> = {},
): Partial<PoseLayerParams> => ({
  members: [{ bone: 'Bone1', rotationMode: order as 'XYZ' }],
  channels: [
    { bone: 'Bone1', component: 'rotation', keyframes: EULER_KEYS, ...extra },
  ] as PoseLayerParams['channels'],
});

const KEY_TIMES = [0, 0.5, 1];
const MIDPOINTS = [0.25, 0.75];
const FRAMES = Array.from({ length: 25 }, (_, i) => i / 24);

describe('#1242 — changing a member’s rotation mode keeps its pose', () => {
  it('convert, euler XYZ → quaternion: the same rotation at every key', async () => {
    const { state, armatureId } = await rig(eulerLayer('XYZ'));
    const next = change(state, { rotationMode: 'quaternion', method: 'convert' });
    for (const t of KEY_TIMES)
      expect(angleDeg(bone1(state, armatureId, t), bone1(next, armatureId, t))).toBeLessThan(1e-6);
    // Between keys it follows the new mode, and on these keys that is a real difference.
    expect(
      Math.max(
        ...MIDPOINTS.map((t) => angleDeg(bone1(state, armatureId, t), bone1(next, armatureId, t))),
      ),
    ).toBeGreaterThan(0.1);
  });

  it('convert, quaternion → euler ZXY and back to XYZ: the same rotation at every key', async () => {
    const { state, armatureId } = await rig(eulerLayer('XYZ'));
    const q = change(state, { rotationMode: 'quaternion', method: 'convert' });
    for (const order of ['ZXY', 'YZX', 'XYZ']) {
      const e = change(q, { rotationMode: order, method: 'convert' });
      for (const t of KEY_TIMES)
        expect(
          angleDeg(bone1(q, armatureId, t), bone1(e, armatureId, t)),
          `${order} @${t}`,
        ).toBeLessThan(1e-6);
    }
  });

  it('resample, euler XYZ → quaternion: the same rotation at every frame', async () => {
    const { state, armatureId } = await rig(eulerLayer('XYZ'));
    const next = change(state, { rotationMode: 'quaternion', method: 'resample', fps: 24 });
    for (const t of FRAMES)
      expect(
        angleDeg(bone1(state, armatureId, t), bone1(next, armatureId, t)),
        `@${t}`,
      ).toBeLessThan(1e-6);
  });

  it('a static member converts too', async () => {
    const { state, armatureId } = await rig({
      members: [{ bone: 'Bone1', rotationMode: 'YXZ', rotation: [25, -35, 60] }],
    });
    for (const target of ['quaternion', 'XZY']) {
      const next = change(state, { rotationMode: target, method: 'convert' });
      expect(
        angleDeg(bone1(state, armatureId, 0.3), bone1(next, armatureId, 0.3)),
        target,
      ).toBeLessThan(1e-6);
    }
  });

  it('euler keys written from a sweep across ±180° stay continuous', async () => {
    // Bone1 turns about Z from 160° to 200° in quaternion keys — across ±180°, where the canonical
    // triple wraps. Written as XYZ euler, its Z curve must step by 10° each key, never by a whole turn.
    // (A 340° → 380° sweep lands on −20° … +20° canonically and would pass with no filter at all.)
    const keys = [160, 170, 180, 190, 200].map((deg, i) => ({
      time: i * 0.25,
      value: [...quatFromEuler([0.2, 0.1, deg * DEG], 'XYZ')],
      easing: 'linear',
    }));
    const { state } = await rig({
      members: [{ bone: 'Bone1', rotationMode: 'quaternion' }],
      channels: [
        { bone: 'Bone1', component: 'quaternion', keyframes: keys },
      ] as PoseLayerParams['channels'],
    });
    const next = change(state, { rotationMode: 'XYZ', method: 'convert' });
    const curve = (next.nodes.layer.params as PoseLayerParams).channels.find(
      (c) => c.component === 'rotation',
    )!;
    const z = curve.keyframes.map((k) => (k.value as number[])[2]);
    for (let i = 1; i < z.length; i++)
      expect(Math.abs(z[i] - z[i - 1]), `step ${i}`).toBeCloseTo(10, 6);
  });

  it('Cycles on an euler curve becomes a cycling quaternion curve', async () => {
    const cycles = [
      {
        type: 'cycles',
        beforeMode: 'repeat',
        afterMode: 'repeat',
        beforeCycles: 0,
        afterCycles: 0,
      },
    ];
    const { state, armatureId } = await rig(eulerLayer('XYZ', { modifiers: cycles } as never));
    const next = change(state, { rotationMode: 'quaternion', method: 'convert' });
    for (const t of [0, 0.5])
      expect(angleDeg(bone1(next, armatureId, t), bone1(next, armatureId, t + 3))).toBeLessThan(
        1e-6,
      );
    expect(angleDeg(bone1(state, armatureId, 3.5), bone1(next, armatureId, 3.5))).toBeLessThan(
      1e-6,
    );
  });

  it('a bone that is not a member is refused by name', async () => {
    const { state } = await rig(eulerLayer('XYZ'));
    const plan = validatePlan(
      setPoseMemberModeMutator,
      specOf({ bone: 'Bone0', rotationMode: 'quaternion' }),
      state,
      'x',
    );
    expect(plan.ok === false && plan.reason).toMatch(/not a member of this layer/);
  });
});

describe('#1242 — the synchronized kind: euler keys, quaternion interpolation', () => {
  it('equals slerp between the keys’ rotations, where per-axis interpolation does not', async () => {
    const synced = await rig({
      ...eulerLayer('XYZ'),
      members: [{ bone: 'Bone1', rotationMode: 'XYZ', eulerInterp: 'quaternion' }],
    });
    const axis = await rig(eulerLayer('XYZ'));
    const q = (v: number[]) => quatFromEuler([v[0] * DEG, v[1] * DEG, v[2] * DEG], 'XYZ');
    for (const [i, t] of [
      [0, 0.25],
      [1, 0.75],
    ] as const) {
      const want = slerp(q(EULER_KEYS[i].value), q(EULER_KEYS[i + 1].value), 0.5);
      expect(
        angleDeg(bone1(synced.state, synced.armatureId, t), want),
        `synced @${t}`,
      ).toBeLessThan(1e-6);
      expect(
        angleDeg(bone1(axis.state, axis.armatureId, t), want),
        `per axis @${t}`,
      ).toBeGreaterThan(0.1);
    }
    // At the keys the two kinds agree: the keys are the same rotations.
    for (const t of KEY_TIMES) {
      expect(
        angleDeg(bone1(synced.state, synced.armatureId, t), bone1(axis.state, axis.armatureId, t)),
      ).toBeLessThan(1e-6);
    }
  });
});
