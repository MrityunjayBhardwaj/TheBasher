// #1153 — the rotation mode is honoured by every reader entry, measured rather than asserted.
//
// Every row builds a quaternion-mode node whose euler `rotation` param is a DECOY — a real,
// different orientation. A reader that skipped `withResolvedRotation` would read the decoy and
// land somewhere measurably wrong, so each row is red for exactly that bypass. The draw side
// (MeshChild and the two light roads) is a React tree and is observed in the browser
// (tests/e2e/p1153-quaternion-rotation.spec.ts); this file is the read side and the model.
//
// Expected values come from three's own composition of the quaternion, not from the code
// under test.

import { beforeEach, describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { applyOp, evaluate, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import type { Quat, Vec3 } from '../nodes/types';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { resolveWorldTransform } from './resolveWorldTransform';
import {
  quaternionFromEulerDeg,
  resolvedQuaternionOf,
  rotationWriteOf,
  withResolvedRotation,
} from './resolvedRotation';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { rotateMutator } from '../agent/mutators/builders/rotate';
import { randomizeMutator } from '../agent/mutators/builders/randomize';

const D2R = Math.PI / 180;
const DECOY: Vec3 = [10, 20, 30];

/** A unit quaternion about a normalised axis, [x, y, z, w]. */
function axisAngle(axis: Vec3, deg: number): Quat {
  const l = Math.hypot(...axis);
  const h = (deg * D2R) / 2;
  const s = Math.sin(h);
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos(h)];
}
const Q = axisAngle([1, 1, 0], 170);

/** Angle in degrees between two orientations, sign-agnostic. */
function angleBetween(a: Quaternion, b: Quaternion): number {
  return (2 * Math.acos(Math.min(1, Math.abs(a.dot(b))))) / D2R;
}
const fromDeg = (r: readonly number[]) =>
  new Quaternion().setFromEuler(new Euler(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'XYZ'));
const tq = (q: readonly number[]) => new Quaternion(q[0], q[1], q[2], q[3]);
const at = (seconds: number) =>
  ({ time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } }) as const;

function run(state: DagState, ops: Op[]): DagState {
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}
const setParams = (nodeId: string, params: Record<string, unknown>): Op[] =>
  Object.entries(params).map(([paramPath, value]) => ({
    type: 'setParam',
    nodeId,
    paramPath,
    value,
  }));

/** The default scene, with `id` put in quaternion mode holding `q` over the decoy euler. */
function quaternionMode(id: string, q: Quat, state = buildDefaultDagState()): DagState {
  return run(state, setParams(id, { rotation: DECOY, rotationMode: 'quaternion', quaternion: q }));
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#1153 — the resolution itself', () => {
  it('normalises, and never scales, a non-unit quaternion (Blender object.cc:2807)', () => {
    const q = resolvedQuaternionOf({ rotationMode: 'quaternion', quaternion: [0, 0, 0, 3] });
    expect(q).toEqual([0, 0, 0, 1]);
  });

  it('draws a zero quaternion as Blender does — (w=0, x=1), measured in 4.5.9 and 5.1.1', () => {
    expect(resolvedQuaternionOf({ rotationMode: 'quaternion', quaternion: [0, 0, 0, 0] })).toEqual([
      1, 0, 0, 0,
    ]);
  });

  it('hands an euler value back as ITSELF, so nothing that never opts in re-renders', () => {
    const value = { kind: 'Object', rotation: DECOY, quaternion: Q };
    expect(withResolvedRotation(value)).toBe(value);
  });
});

describe('#1153 — the model', () => {
  it('an euler Object evaluates to exactly the shape it had: no mode fields at all', () => {
    const v = evaluate(buildDefaultDagState(), 'n_box', at(0) as never).value as object;
    expect('rotationMode' in v).toBe(false);
    expect('quaternion' in v).toBe(false);
  });

  it('a quaternion left behind in euler mode composes nothing (Blender keeps both, uses one)', () => {
    const state = run(
      buildDefaultDagState(),
      setParams('n_box', { rotation: DECOY, quaternion: Q }),
    );
    const r = resolveEvaluatedTransform(state, 'n_box', at(0) as never);
    // Exact: in euler mode the authored triple reaches the reader untouched.
    expect(r!.rotation).toEqual(DECOY);
  });

  it('quaternion mode with no quaternion is the identity, as Blender defaults it', () => {
    const state = run(
      buildDefaultDagState(),
      setParams('n_box', { rotation: DECOY, rotationMode: 'quaternion' }),
    );
    const r = resolveEvaluatedTransform(state, 'n_box', at(0) as never);
    expect(angleBetween(fromDeg(r!.rotation!), new Quaternion())).toBeLessThan(1e-6);
  });
});

describe('#1153 — every read-side entry honours the mode', () => {
  it('resolveEvaluatedTransform (the gizmo + inspector read) reads the quaternion', () => {
    const r = resolveEvaluatedTransform(quaternionMode('n_box', Q), 'n_box', at(0) as never);
    expect(angleBetween(fromDeg(r!.rotation!), tq(Q))).toBeLessThan(1e-5);
  });

  it('resolveWorldTransform (localMatrix) composes the quaternion', () => {
    const w = resolveWorldTransform(quaternionMode('n_box', Q), 'n_box', at(0) as never);
    expect(angleBetween(tq(w!.quaternion), tq(Q))).toBeLessThan(1e-5);
  });

  it('a Group in quaternion mode turns the child it holds', () => {
    let state = buildDefaultDagState();
    state = run(state, [
      { type: 'addNode', nodeId: 'g', nodeType: 'Group', params: {} },
      { type: 'addNode', nodeId: 'kid', nodeType: 'Object', params: { position: [1, 0, 0] } },
      {
        type: 'connect',
        from: { node: 'n_box_data', socket: 'out' },
        to: { node: 'kid', socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: 'kid', socket: 'out' },
        to: { node: 'g', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'g', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    const q = axisAngle([0, 0, 1], 90);
    state = quaternionMode('g', q, state);
    const w = resolveWorldTransform(state, 'kid', at(0) as never);
    const want = new Vector3(1, 0, 0).applyQuaternion(tq(q));
    expect(w!.position[0]).toBeCloseTo(want.x, 6);
    expect(w!.position[1]).toBeCloseTo(want.y, 6);
    expect(w!.position[2]).toBeCloseTo(want.z, 6);
  });

  it('a light Object carries its mode through the recompose and resolves in the world', () => {
    const w = resolveWorldTransform(quaternionMode('n_light', Q), 'n_light', at(0) as never);
    expect(angleBetween(tq(w!.quaternion), tq(Q))).toBeLessThan(1e-5);
  });
});

describe('#1153 — a quaternion channel drives it, slerping', () => {
  // The fixture track the issue measured: 0° → 170° about (1,1,0) → 90° about Z, LINEAR.
  const KEYS: Quat[] = [[0, 0, 0, 1], Q, axisAngle([0, 0, 1], 90)];
  const truth = (t: number) => {
    const i = Math.min(Math.floor(t), 1);
    return tq(KEYS[i]).slerp(tq(KEYS[i + 1]), t - i);
  };
  function animated(): DagState {
    return run(quaternionMode('n_box', [0, 0, 0, 1]), [
      {
        type: 'addNode',
        nodeId: 'n_box_quaternion_channel',
        nodeType: 'KeyframeChannelQuat',
        params: {
          name: 'quaternion',
          target: 'n_box',
          paramPath: 'quaternion',
          keyframes: KEYS.map((value, i) => ({ time: i, value, easing: 'linear' })),
        },
      },
    ]);
  }

  it('the read side follows the slerp — was `rotation: null` before #1153 (41.49° as euler keys)', () => {
    const state = animated();
    let worst = 0;
    let samples = 0;
    for (let t = 0; t <= 2 + 1e-9; t += 1 / 24) {
      const r = resolveEvaluatedTransform(state, 'n_box', at(t) as never);
      worst = Math.max(worst, angleBetween(fromDeg(r!.rotation!), truth(t)));
      samples++;
    }
    expect(samples).toBe(49);
    expect(worst).toBeLessThan(1e-4);
  });

  it('the world read follows it too', () => {
    const w = resolveWorldTransform(animated(), 'n_box', at(0.5) as never);
    expect(angleBetween(tq(w!.quaternion), truth(0.5))).toBeLessThan(1e-4);
  });

  it("a 'constant' (glTF STEP) track holds each key until the next, then snaps", () => {
    const state = run(animated(), [
      {
        type: 'setParam',
        nodeId: 'n_box_quaternion_channel',
        paramPath: 'keyframes',
        value: KEYS.map((value, i) => ({ time: i, value, easing: 'constant' })),
      },
    ]);
    let worst = 0;
    let samples = 0;
    for (let n = 0; n <= 48; n++) {
      const t = n / 24;
      const held = tq(KEYS[Math.min(Math.floor(t), 2)]);
      const r = resolveEvaluatedTransform(state, 'n_box', at(t) as never);
      worst = Math.max(worst, angleBetween(fromDeg(r!.rotation!), held));
      samples++;
    }
    expect(samples).toBe(49);
    expect(worst).toBeLessThan(1e-4);
    // Positive control: half-way through the first segment the linear track has
    // left the key by 85°, so a held pose is not what the linear road also gives.
    const mid = resolveEvaluatedTransform(animated(), 'n_box', at(0.5) as never);
    expect(angleBetween(fromDeg(mid!.rotation!), tq(KEYS[0]))).toBeGreaterThan(80);
  });
});

describe('#1153 — a Track-To aim wins in either mode (Blender evaluates constraints after)', () => {
  function aimed(state: DagState): DagState {
    return run(state, [
      {
        type: 'addNode',
        nodeId: 'n_aim',
        nodeType: 'TrackTo',
        params: { target: 'n_box', aimPoint: [3, -2, -5] },
      },
    ]);
  }

  it('a quaternion-mode Object aims exactly where the euler one does', () => {
    const euler = resolveEvaluatedTransform(aimed(buildDefaultDagState()), 'n_box', at(0) as never);
    const quat = resolveEvaluatedTransform(
      aimed(quaternionMode('n_box', Q)),
      'n_box',
      at(0) as never,
    );
    // Positive control: the aim actually turned the euler box away from identity.
    expect(angleBetween(fromDeg(euler!.rotation!), new Quaternion())).toBeGreaterThan(1);
    expect(angleBetween(fromDeg(quat!.rotation!), fromDeg(euler!.rotation!))).toBeLessThan(1e-5);
  });
});

describe('#1153 — writers go through the mode (Blender object.cc:2826-2837)', () => {
  it('an euler node is written `rotation`, exactly the triple handed in', () => {
    expect(rotationWriteOf({}, DECOY)).toEqual({ paramPath: 'rotation', value: DECOY });
  });

  it('a quaternion node is written `quaternion`, the same orientation, on the side it replaces', () => {
    const e: Vec3 = [40, -70, 15];
    const prev = quaternionFromEulerDeg(e).map((v) => -v) as unknown as Quat; // the far side
    const w = rotationWriteOf({ rotationMode: 'quaternion', quaternion: prev }, e);
    expect(w.paramPath).toBe('quaternion');
    const q = w.value as Quat;
    expect(angleBetween(tq(q), fromDeg(e))).toBeLessThan(1e-5);
    // Blender's hemisphere match (object_transform.cc:236-240): no sign jump against `prev`.
    expect(q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3]).toBeGreaterThan(0);
  });

  it('the evaluated transform carries the quaternion only in quaternion mode', () => {
    const quat = resolveEvaluatedTransform(quaternionMode('n_box', Q), 'n_box', at(0) as never);
    // Component-wise: the evaluated quaternion IS the (already unit) quaternion authored.
    quat!.quaternion!.forEach((v, i) => expect(v).toBeCloseTo(Q[i], 9));
    const euler = resolveEvaluatedTransform(buildDefaultDagState(), 'n_box', at(0) as never);
    expect(euler && 'quaternion' in euler).toBe(false);
  });

  it("under a Track-To the evaluated quaternion is the AIM's, so a key records what is shown", () => {
    const state = run(quaternionMode('n_box', Q), [
      {
        type: 'addNode',
        nodeId: 'n_aim',
        nodeType: 'TrackTo',
        params: { target: 'n_box', aimPoint: [3, -2, -5] },
      },
    ]);
    const r = resolveEvaluatedTransform(state, 'n_box', at(0) as never);
    expect(angleBetween(tq(r!.quaternion!), fromDeg(r!.rotation!))).toBeLessThan(1e-5);
    expect(angleBetween(tq(r!.quaternion!), tq(Q))).toBeGreaterThan(1);
  });

  /** Apply `ops` and read the orientation the node shows. */
  function shown(state: DagState, ops: Op[], id = 'n_box'): Quaternion {
    const r = resolveEvaluatedTransform(run(state, ops), id, at(0) as never);
    return fromDeg(r!.rotation!);
  }
  /** An euler node holding the SAME orientation as `Q`: the twin a quaternion node must match. */
  const twin = () =>
    run(
      buildDefaultDagState(),
      setParams('n_box', {
        rotation: withResolvedRotation({
          rotationMode: 'quaternion',
          quaternion: Q,
          rotation: DECOY,
        }).rotation,
      }),
    );

  it('the agent rotate lands a quaternion node exactly where its euler twin lands', () => {
    const spec = { targetSelectors: ['n_box'], axis: 'y' as const, deltaDeg: 35 };
    const qState = quaternionMode('n_box', Q);
    const qOps = rotateMutator.build(spec, {} as never, qState);
    expect(qOps.map((o) => (o.type === 'setParam' ? o.paramPath : o.type))).toEqual(['quaternion']);
    const eState = twin();
    const eOps = rotateMutator.build(spec, {} as never, eState);
    expect(angleBetween(shown(qState, qOps), shown(eState, eOps))).toBeLessThan(1e-4);
    // Positive control: the rotate moved it.
    expect(angleBetween(shown(qState, qOps), tq(Q))).toBeGreaterThan(30);
  });

  it('the agent randomize (same seed) lands a quaternion node where its euler twin lands', () => {
    const spec = {
      targetSelectors: ['n_box'],
      properties: ['rotation' as const],
      ranges: { rotation: { axis: 'x' as const, degRange: [20, 60] as [number, number] } },
      seed: 7,
    };
    const qState = quaternionMode('n_box', Q);
    const qOps = randomizeMutator.build(spec as never, {} as never, qState);
    expect(qOps.map((o) => (o.type === 'setParam' ? o.paramPath : o.type))).toEqual(['quaternion']);
    const eState = twin();
    const eOps = randomizeMutator.build(spec as never, {} as never, eState);
    expect(angleBetween(shown(qState, qOps), shown(eState, eOps))).toBeLessThan(1e-4);
    expect(angleBetween(shown(qState, qOps), tq(Q))).toBeGreaterThan(15);
  });

  /** An Object under a Group, the Group in the scene or (`inScene: false`) hanging off nothing. */
  function nestedKid(inScene: boolean): DagState {
    let state = buildDefaultDagState();
    state = run(state, [
      { type: 'addNode', nodeId: 'g', nodeType: 'Group', params: {} },
      { type: 'addNode', nodeId: 'kid', nodeType: 'Object', params: {} },
      {
        type: 'connect',
        from: { node: 'n_box_data', socket: 'out' },
        to: { node: 'kid', socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: 'kid', socket: 'out' },
        to: { node: 'g', socket: 'children' },
      },
      ...((inScene
        ? [
            {
              type: 'connect',
              from: { node: 'g', socket: 'out' },
              to: { node: 'n_scene', socket: 'children' },
            },
          ]
        : []) as Op[]),
    ]);
    return quaternionMode('kid', Q, state);
  }

  it("Apply's fallback for an Object the scene walk misses reads the quaternion", () => {
    const state = nestedKid(false);
    // The precondition that makes this the FALLBACK: nothing in the scene holds the Group.
    expect(resolveEvaluatedTransform(state, 'kid', at(0) as never)).toBeNull();
    const mesh = resolveEvaluatedMesh(state, 'kid', at(0) as never) as unknown as {
      transform: { rotation: Vec3 };
    } | null;
    expect(angleBetween(fromDeg(mesh!.transform.rotation), tq(Q))).toBeLessThan(1e-5);
  });

  it('a nested Object in the scene is read by the walk (#268), and the walk reads the quaternion', () => {
    const state = nestedKid(true);
    const walked = resolveEvaluatedTransform(state, 'kid', at(0) as never);
    expect(angleBetween(fromDeg(walked!.rotation!), tq(Q))).toBeLessThan(1e-5);
    const mesh = resolveEvaluatedMesh(state, 'kid', at(0) as never) as unknown as {
      transform: { rotation: Vec3 };
    } | null;
    expect(angleBetween(fromDeg(mesh!.transform.rotation), tq(Q))).toBeLessThan(1e-5);
  });
});
