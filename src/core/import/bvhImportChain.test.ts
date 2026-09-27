// BVH import chain (#1211): a Skeleton and the file's motion as keys on a base pose layer.
//
// The claim is not "a layer appears". It is that the layer plays the FILE's motion: at every key,
// every bone's pose equals what the file says (read by three's BVH parser, the same numbers the old
// clip carried, built here through the clip fixture). The shape Blender's importer writes is the
// rest of the claim: members in the file's rotation order, keys linear and one per frame, location
// only on joints the file positions, and nothing dropped uncounted.
//
// NO TIME WIRING (#920): the chain connects no TimeSource, and an empty DAG is a valid input.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../dag';
import type { DagState } from '../dag/state';
import type { Op } from '../dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildBvhImportOps, __resetBvhImportCounterForTests } from './bvhImportChain';
import { buildBvhClipOps } from '../../test-utils/bvhClip';
import type { PosedSkeletonValue, Quat, Vec3 } from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';

const SYNTHETIC_BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 1.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  JOINT Spine
  {
    OFFSET 0.0 0.5 0.0
    CHANNELS 3 Xrotation Yrotation Zrotation
    End Site
    {
      OFFSET 0.0 0.5 0.0
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.0333333
0.0 1.0 0.0 0.0 0.0 0.0 0.0 45.0 0.0
0.0 1.0 0.0 0.0 0.0 0.0 0.0 -45.0 0.0
`;

/** ZXY order — neither of the tracked files' orders (ZYX, XYZ) — with Y crossing ±180°: the file
 *  writes 170 then -170, which is +20° on, not a 340° swing back. */
const ZXY_CROSSING_BVH = `HIERARCHY
ROOT Root
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Arm
  {
    OFFSET 0 1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 1 0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.5
0 0 0 0 0 0 10 20 150
0 0 0 0 0 0 10 20 170
0 0 0 0 0 0 10 20 -170
`;

const WALK_BVH = readFileSync('public/assets/motion/walk.bvh', 'utf8');

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetBvhImportCounterForTests();
});

const apply = (ops: readonly Op[], s: DagState = emptyDagState()) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);
const AT0 = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } };

/** The layer's pose wire and the file's own reading (the clip), for one text. */
function bothRoads(text: string) {
  const layer = buildBvhImportOps({ text, name: 'm', ids: { skeleton: 'sk', layer: 'motion' } });
  const clip = buildBvhClipOps({ text, name: 'm', ids: { skeleton: 'csk', clip: 'clip' } });
  const s = apply([...layer.ops, ...clip.ops]);
  const wire = evaluate(s, 'motion', { ...AT0, socket: 'out' }).value as PosedSkeletonValue;
  const file = evaluate(s, 'clip', { ...AT0, socket: 'pose' }).value as PosedSkeletonValue;
  const params = s.nodes.motion.params as PoseLayerParams;
  return { layer, s, wire, file, params };
}

/** Angle between two rotations, degrees. */
const angleDeg = (a: Quat, b: Quat) =>
  (2 *
    Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) *
    180) /
  Math.PI;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Worst disagreement between the layer and the file over `times`, bone by bone (by index: the
 *  layer's rig spells duplicate names uniquely, the clip's does not). */
function worst(text: string, times: readonly number[]) {
  const { wire, file } = bothRoads(text);
  let rot = 0;
  let pos = 0;
  for (const t of times) {
    const a = wire.sample(t);
    const b = file.sample(t);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      rot = Math.max(rot, angleDeg(a[i].quaternion, b[i].quaternion));
      pos = Math.max(pos, dist(a[i].position, b[i].position));
    }
  }
  return { rot, pos };
}

function keyTimes(params: PoseLayerParams): number[] {
  return [...new Set(params.channels.flatMap((c) => c.keyframes.map((k) => k.time)))].sort(
    (a, b) => a - b,
  );
}

describe('buildBvhImportOps — the shape', () => {
  it('a Skeleton, a base override layer named after the file over its rest pose, and one edge', () => {
    const { ops, skeletonId, motionId } = buildBvhImportOps({
      text: SYNTHETIC_BVH,
      name: 'wave',
      ids: { skeleton: 'sk', layer: 'motion' },
    });
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ type: 'addNode', nodeId: 'sk', nodeType: 'Skeleton' });
    expect(ops[1]).toMatchObject({
      type: 'addNode',
      nodeId: 'motion',
      nodeType: 'PoseLayer',
      params: { name: 'wave', mode: 'override' },
    });
    expect(ops[2]).toMatchObject({
      type: 'connect',
      from: { node: 'sk', socket: 'pose' },
      to: { node: 'motion', socket: 'pose' },
    });
    expect([skeletonId, motionId]).toEqual(['sk', 'motion']);
    expect(ops.some((o) => o.type === 'addNode' && o.nodeType === 'AnimationClip')).toBe(false);
  });

  it('is deterministic, wires no TimeSource, and imports into an empty DAG (#920)', () => {
    const a = buildBvhImportOps({ text: SYNTHETIC_BVH, ids: { skeleton: 'sk', layer: 'm' } });
    const b = buildBvhImportOps({ text: SYNTHETIC_BVH, ids: { skeleton: 'sk', layer: 'm' } });
    expect(a.ops).toEqual(b.ops);
    for (const op of a.ops) {
      if (op.type === 'addNode') expect(op.nodeType).not.toBe('TimeSource');
      if (op.type === 'connect') expect(op.to.socket).not.toBe('time');
    }
    expect(() => apply(a.ops)).not.toThrow();
  });
});

describe('buildBvhImportOps — it plays the file', () => {
  it('synthetic: every bone equals the file at every key', () => {
    const { params } = bothRoads(SYNTHETIC_BVH);
    const w = worst(SYNTHETIC_BVH, keyTimes(params));
    expect(w.rot).toBeLessThan(1e-4);
    expect(w.pos).toBeLessThan(1e-9);
  });

  it('walk.bvh: all 78 joints equal the file at every one of its 120 keys', () => {
    const { params } = bothRoads(WALK_BVH);
    const times = keyTimes(params);
    expect(times).toHaveLength(120);
    const w = worst(WALK_BVH, times);
    expect(w.rot, 'degrees').toBeLessThan(1e-4);
    // A joint the file does not position rests at its skeleton offset; the clip carries three's
    // float32 copy of that offset (measured 5.9e-7 m), so the bound is float32's, not exact.
    expect(w.pos, 'metres').toBeLessThan(1e-6);
  });

  it('ZXY across ±180°: equal at the keys, and between them it turns the short way', () => {
    const { params, wire, file } = bothRoads(ZXY_CROSSING_BVH);
    expect(worst(ZXY_CROSSING_BVH, keyTimes(params)).rot).toBeLessThan(1e-4);
    // Continuous in its own order: the stored Y goes 150 → 170 → 190, not → -170.
    const arm = params.channels.find((c) => c.bone === 'Arm' && c.component === 'rotation')!;
    const ys = arm.keyframes.map((k) => (k.value as Vec3)[2]);
    for (let i = 1; i < ys.length; i++) expect(Math.abs(ys[i] - ys[i - 1])).toBeLessThan(180);
    // Between 170 and -170 the arm passes 180°: about 10° from either key (per-axis euler, Blender's
    // rule, is not exactly the geodesic midpoint: measured 9.95°), never the ~170° of the long way.
    const armIndex = wire.skeleton.bones.findIndex((b) => b.name === 'Arm');
    const mid = wire.sample(0.75)[armIndex].quaternion;
    for (const t of [0.5, 1]) {
      const off = angleDeg(mid, file.sample(t)[armIndex].quaternion);
      expect(off, `from the key at ${t}`).toBeGreaterThan(9);
      expect(off, `from the key at ${t}`).toBeLessThan(11);
    }
  });
});

describe('buildBvhImportOps — what Blender’s importer writes', () => {
  it('walk.bvh: 78 members in the file’s ZYX order; 78 rotation and 2 location curves (240 axis curves)', () => {
    const { params } = bothRoads(WALK_BVH);
    expect(params.members).toHaveLength(78);
    expect(new Set(params.members.map((m) => m.rotationMode))).toEqual(new Set(['ZYX']));
    const rot = params.channels.filter((c) => c.component === 'rotation');
    const loc = params.channels.filter((c) => c.component === 'position');
    expect(rot).toHaveLength(78);
    expect(loc.map((c) => c.bone).sort()).toEqual(['Hips', 'Root']);
    expect((rot.length + loc.length) * 3).toBe(240);
    // Linear, one key per file frame.
    for (const c of params.channels) {
      expect(c.keyframes, c.bone).toHaveLength(120);
      for (const k of c.keyframes) expect(k.easing).toBe('linear');
    }
  });

  it('the file’s own order per joint: XYZ stays XYZ, ZXY stays ZXY', () => {
    expect(bothRoads(SYNTHETIC_BVH).params.members.map((m) => m.rotationMode)).toEqual([
      'XYZ',
      'XYZ',
    ]);
    expect(bothRoads(ZXY_CROSSING_BVH).params.members.map((m) => m.rotationMode)).toEqual([
      'ZXY',
      'ZXY',
    ]);
  });

  it('bone names are unique in the rig, spelled as the glTF reader spells them', () => {
    const text = readFileSync('public/fixtures/anim/mixamo-naming.bvh', 'utf8');
    const { s } = bothRoads(text);
    const names = (s.nodes.sk.params as { bones: { name: string }[] }).bones.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    const ends = names.filter((n) => n.startsWith('ENDSITE'));
    expect(ends).toEqual(['ENDSITE', 'ENDSITE.001', 'ENDSITE.002', 'ENDSITE.003', 'ENDSITE.004']);
    // three's reserved characters sanitised, as before: `mixamorig:Hips` → `mixamorig_Hips`.
    expect(names).toContain('mixamorig_Hips');
  });

  it('counts what it leaves out, even at zero: rest-offset position tracks, and nothing else', () => {
    expect(bothRoads(SYNTHETIC_BVH).layer.dropped).toEqual({
      restPositionTracks: 1,
      restPositionMismatches: 0,
      undeclaredTracks: 0,
    });
    // walk.bvh: every animated joint but the two it positions carries a rest-offset track.
    expect(bothRoads(WALK_BVH).layer.dropped).toEqual({
      restPositionTracks: 76,
      restPositionMismatches: 0,
      undeclaredTracks: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Against Blender 5.1.1's own import of walk.bvh (probe `q1211_bvh_walk_oracle.py`, operator
// defaults, recorded in the fixture): same curves, same modes, and the same pose at the first,
// middle and last frame. Blender frame f is file frame f-1 (`frame_start` 1, no fps scaling).
// ─────────────────────────────────────────────────────────────────────────
describe('walk.bvh against Blender 5.1.1’s import', () => {
  const oracle = JSON.parse(
    readFileSync('src/core/import/__fixtures__/blender-oracle-walk-bvh.json', 'utf8'),
  ) as {
    blender: string;
    fcurves: number;
    modes: string[];
    interpolations: string[];
    keysPerCurve: number[];
    bones: number;
    frames: Record<string, Record<string, { head: number[]; quat: number[] }>>;
  };
  const FRAME_TIME = Number(/Frame Time:\s*([0-9.eE+-]+)/.exec(WALK_BVH)![1]);

  /** Our world transforms at `seconds`: forward kinematics over the layer's pose, as drawn. */
  function ourWorld(seconds: number) {
    const { wire } = bothRoads(WALK_BVH);
    const bones = wire.skeleton.bones;
    const pose = wire.sample(seconds);
    const world: { p: Vector3; q: Quaternion }[] = [];
    bones.forEach((b, i) => {
      const lp = new Vector3(...pose[i].position);
      const lq = new Quaternion(...pose[i].quaternion);
      if (b.parent < 0) world[i] = { p: lp, q: lq };
      else {
        const par = world[b.parent];
        world[i] = { p: lp.applyQuaternion(par.q).add(par.p), q: par.q.clone().multiply(lq) };
      }
    });
    return new Map(bones.map((b, i) => [b.name, world[i]]));
  }

  /** Blender's axes to ours: the importer's `axis_up='Y'` is +90° about X (read, not fitted). */
  const UP = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  const toOurs = (head: number[]) =>
    new Vector3(head[0], head[1], head[2]).applyQuaternion(UP.clone().invert());
  const theirQ = (q: number[]) =>
    UP.clone()
      .invert()
      .multiply(new Quaternion(q[1], q[2], q[3], q[0]));

  it('the same curves: 240, all LINEAR, 120 keys each, every bone in ZYX — as the layer has', () => {
    const { params } = bothRoads(WALK_BVH);
    expect(oracle.blender).toMatch(/^5\.1/);
    expect(params.channels.length * 3).toBe(oracle.fcurves);
    expect(oracle.interpolations).toEqual(['LINEAR']);
    expect(oracle.keysPerCurve).toEqual([params.channels[0].keyframes.length]);
    expect([...new Set(params.members.map((m) => m.rotationMode))]).toEqual(oracle.modes);
    expect(params.members).toHaveLength(oracle.bones);
  });

  // THE BOUNDS ARE BLENDER'S PRECISION, MEASURED. Its keys equal the file's rotations exactly (probe:
  // stored pose keys un-conjugated by the importer's rest matrices, `import_bvh.py:621-625`, 0.0° on
  // all 234 rotation keys at these frames; a wrong-order control reads up to 28°). What it EVALUATES
  // is float32: its world rotations differ from an exact float64 composition of the file's own
  // rotations by up to 0.061° (`LeftHandMiddle4`, frame 120), and its heads by ~1.5e-6 of their
  // distance from the origin. Ours match the exact composition, so the gap below is that, and the
  // bars sit just above it, far below any real error (a wrong order reads tens of degrees).
  it('every bone’s head at the first, middle and last frame, to 1e-5 of its distance out', () => {
    let worstHead = 0;
    let compared = 0;
    for (const [frame, bones] of Object.entries(oracle.frames)) {
      const ours = ourWorld((Number(frame) - 1) * FRAME_TIME);
      for (const [name, b] of Object.entries(bones)) {
        const mine = ours.get(name);
        expect(mine, name).toBeDefined();
        const theirs = toOurs(b.head);
        worstHead = Math.max(worstHead, mine!.p.distanceTo(theirs) / Math.max(1, theirs.length()));
        compared += 1;
      }
    }
    expect(compared).toBe(3 * oracle.bones);
    expect(worstHead, 'relative').toBeLessThan(1e-5);
  });

  it('every bone’s rotation since the first frame agrees, and the rig really moves', () => {
    const frames = Object.keys(oracle.frames).sort((a, b) => Number(a) - Number(b));
    const f0 = frames[0];
    const ours0 = ourWorld(0);
    let worstDeg = 0;
    let moved = 0;
    for (const f of frames.slice(1)) {
      const ours = ourWorld((Number(f) - 1) * FRAME_TIME);
      for (const [name, b] of Object.entries(oracle.frames[f])) {
        const relTheirs = theirQ(b.quat).multiply(theirQ(oracle.frames[f0][name].quat).invert());
        const relOurs = ours.get(name)!.q.clone().multiply(ours0.get(name)!.q.clone().invert());
        const d = (2 * Math.acos(Math.min(1, Math.abs(relTheirs.dot(relOurs)))) * 180) / Math.PI;
        worstDeg = Math.max(worstDeg, d);
        if (2 * Math.acos(Math.min(1, Math.abs(relTheirs.w))) > (5 * Math.PI) / 180) moved += 1;
      }
    }
    expect(worstDeg, 'degrees').toBeLessThan(0.1);
    // Not a comparison of two still rigs: a good share of bones turn more than 5°.
    expect(moved).toBeGreaterThan(20);
  });
});
