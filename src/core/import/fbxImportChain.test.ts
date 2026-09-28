// FBX import chain (#1211): a Skeleton and the file's motion as keys on a base pose layer.
//
// The claim is not "a layer appears". It is that the layer plays the FILE's motion, in the shape
// Blender's FBX importer writes it: quaternion members, position + quaternion + scale keyed at the
// file's key times, linear, and nothing dropped uncounted. Checked three ways: against the clip
// this road wrote before (the same pose at every key), against Blender 5.1.1's own import of the
// same file, and on a file whose bone scale is keyed (the scale the clip dropped).
//
// The FBX fixtures are Blender's own DEFAULT exports (probes `q1211_fbx_walk_oracle.py` and
// `q1211_fbx_from_gltf_oracle.py`): `walk.bvh`, and the keyed-scale bar `.glb`, each imported into
// Blender and exported with every FBX exporter option at its default, then re-imported with every
// importer option at its default for the oracle JSON beside it.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../dag';
import type { DagState } from '../dag/state';
import type { Op } from '../dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildFbxImportOps } from './fbxImportChain';
import { parseFbx } from './fbx';
import type { PosedSkeletonValue } from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';

const FIXTURES = 'src/core/import/__fixtures__';
function bytes(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
const WALK = () => bytes(`${FIXTURES}/walk-blender-default.fbx`);
const KEYED_SCALE = () => bytes(`${FIXTURES}/skinned-bar-keyed-scale-blender-default.fbx`);
const RIG = () => bytes('public/fixtures/anim/rig.fbx');

type Oracle = {
  blender: string;
  fps: number;
  fcurvesByProperty: Record<string, number>;
  modes: string[];
  interpolations: string[];
  frames: Record<string, Record<string, { head: number[]; quat: number[] }>>;
};
const oracle = (name: string): Oracle =>
  JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8')) as Oracle;

function apply(ops: readonly Op[], s: DagState = emptyDagState()): DagState {
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}
const wire = (s: DagState, id: string, socket: string) =>
  evaluate(s, id, {
    ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    socket,
  }).value as PosedSkeletonValue;

function imported(data: ArrayBuffer) {
  const result = buildFbxImportOps({ data, name: 'walk', ids: { skeleton: 'sk', layer: 'layer' } });
  const state = apply(result.ops);
  return {
    result,
    params: state.nodes.layer.params as PoseLayerParams,
    layer: wire(state, 'layer', 'out'),
  };
}

/** World matrices by bone name at `seconds`: forward kinematics over the wire, scale included. */
function worldAt(pose: PosedSkeletonValue, seconds: number): Map<string, Matrix4> {
  const bones = pose.skeleton.bones;
  const local = pose.sample(seconds);
  const world: Matrix4[] = [];
  bones.forEach((b, i) => {
    const m = new Matrix4().compose(
      new Vector3(...local[i].position),
      new Quaternion(...local[i].quaternion),
      new Vector3(...local[i].scale),
    );
    world[i] = b.parent < 0 ? m : world[b.parent].clone().multiply(m);
  });
  return new Map(bones.map((b, i) => [b.name, world[i]]));
}
const headOf = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const rotOf = (m: Matrix4) => {
  const p = new Vector3();
  const q = new Quaternion();
  m.decompose(p, q, new Vector3());
  return q;
};
/** Blender's world is Z-up and ours is Y-up. The rig reaches ours folded and in metres (#1190,
 *  #1086), so Blender's pose-bone numbers are carried into it here: a head (x, y, z) is (x, z, −y),
 *  a rotation is turned −90° about X. Before the fold this road kept the file's raw frame, which
 *  happened to read as Blender's armature space. */
const ZUP_TO_YUP = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const theirQ = (q: number[]) => ZUP_TO_YUP.clone().multiply(new Quaternion(q[1], q[2], q[3], q[0]));
const theirHead = (h: number[]) => new Vector3(h[0], h[2], -h[1]);
/** The angle between two rotations. Normalised first: the file's quaternions are float32, off unit
 *  length by ~1e-7, and `acos` near 1 reads that as ~0.04° of rotation that is not there. */
const degrees = (a: Quaternion, b: Quaternion) =>
  (2 * Math.acos(Math.min(1, Math.abs(a.clone().normalize().dot(b.clone().normalize())))) * 180) /
  Math.PI;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('the layer’s shape is the one Blender’s FBX importer writes (walk, Blender default export)', () => {
  const o = oracle('blender-oracle-walk-fbx.json');

  it('every keyed bone is a quaternion member, keyed position + quaternion + scale, all linear', () => {
    const { params, result } = imported(WALK());
    const count = (c: string) => params.channels.filter((ch) => ch.component === c).length;
    expect(o.blender).toMatch(/^5\.1/);
    expect(o.modes).toEqual(['QUATERNION']);
    expect(o.interpolations).toEqual(['LINEAR']);
    expect(params.members).toHaveLength(78);
    expect(new Set(params.members.map((m) => m.rotationMode))).toEqual(new Set(['quaternion']));
    expect(params.channels.every((c) => c.keyframes.every((k) => k.easing === 'linear'))).toBe(
      true,
    );
    // Blender's quaternion curves are the bones' alone (the armature Object rotates in euler).
    expect(count('quaternion') * 4).toBe(o.fcurvesByProperty.rotation_quaternion);
    // Its location and scale curves are the bones' plus the armature Object's own three each; those
    // three tracks key no bone here, and are counted as dropped, not lost.
    expect(count('position') * 3 + 3).toBe(o.fcurvesByProperty.location);
    expect(count('scale') * 3 + 3).toBe(o.fcurvesByProperty.scale);
    expect(result.scaleChannels).toBe(count('scale'));
    expect(result.dropped).toEqual({
      unknownBoneTracks: 3,
      otherPropertyTracks: 0,
      unparsedTracks: 0,
    });
  });

  it('keys sit at the file’s own times, not one per frame: the exporter simplified them', () => {
    const { params } = imported(WALK());
    const lengths = new Set(params.channels.map((c) => c.keyframes.length));
    expect(lengths.size).toBeGreaterThan(5);
    expect(Math.max(...lengths)).toBe(120);
    expect(Math.min(...lengths)).toBe(2);
  });
});

// The clip this road wrote before read the same three tracks. At every key time of every track the
// layer poses each bone as that clip did: this change moves the motion, it does not re-read it.
describe('the layer poses every bone as the old clip did, at every key', () => {
  for (const [label, data] of [
    ['walk (Blender default export)', WALK],
    ['rig.fbx', RIG],
  ] as const) {
    it(label, () => {
      const { layer, params } = imported(data());
      const parsed = parseFbx(data(), 'walk');
      const clipState = apply([
        { type: 'addNode', nodeId: 'csk', nodeType: 'Skeleton', params: parsed.skeletonParams },
        { type: 'addNode', nodeId: 'clip', nodeType: 'AnimationClip', params: parsed.clipParams },
        {
          type: 'connect',
          from: { node: 'csk', socket: 'out' },
          to: { node: 'clip', socket: 'skeleton' },
        },
      ]);
      const clip = wire(clipState, 'clip', 'pose');
      const index = new Map(layer.skeleton.bones.map((b, i) => [b.name, i]));
      // Each track at its OWN key times. At a time only another track of the bone keys, the clip
      // wrote the bone's rest position (`clipToKeyframes` falls back to the bind pose), which was
      // never the file's value there, so those instants are not a "today" worth matching.
      let worstPos = 0;
      let worstDeg = 0;
      let times = 0;
      for (const c of params.channels) {
        const i = index.get(c.bone)!;
        for (const k of c.keyframes) {
          const ours = layer.sample(k.time)[i];
          const theirs = clip.sample(k.time)[i];
          times += 1;
          if (c.component === 'position') {
            worstPos = Math.max(
              worstPos,
              new Vector3(...ours.position).distanceTo(new Vector3(...theirs.position)),
            );
          } else if (c.component === 'quaternion') {
            worstDeg = Math.max(
              worstDeg,
              degrees(new Quaternion(...ours.quaternion), new Quaternion(...theirs.quaternion)),
            );
          }
        }
      }
      expect(times).toBeGreaterThan(1);
      expect(worstPos).toBeLessThan(1e-9);
      expect(worstDeg).toBeLessThan(1e-4);
    });
  }
});

describe('scale the clip dropped is kept (keyed-scale bar, Blender default export)', () => {
  const o = oracle('blender-oracle-keyed-scale-fbx.json') as Oracle & {
    frames: Record<string, Record<string, { scale: number[] }>>;
  };
  const worstScale = (pose: PosedSkeletonValue) => {
    const i = pose.skeleton.bones.findIndex((b) => b.name === 'Bone1');
    let worst = 0;
    for (const [frame, bones] of Object.entries(o.frames)) {
      const ours = pose.sample((Number(frame) - 1) / o.fps)[i].scale;
      worst = Math.max(worst, ...ours.map((v, a) => Math.abs(v - bones.Bone1.scale[a])));
    }
    return worst;
  };

  // three builds bones from the skin's clusters here, so the leaf Blender adds on export
  // (`Bone1_end`) is not one of ours; Bone0 and Bone1 are compared, and Bone1's scale directly
  // against Blender's pose bone, whose axes are the file's (the importer's bone reorientation is off
  // by default).
  it('Bone1’s keyed scale plays as Blender plays it at five frames, and the heads match', () => {
    const { layer, result } = imported(KEYED_SCALE());
    expect(result.scaleChannels).toBe(2);
    expect(result.dropped.unknownBoneTracks).toBe(3); // the armature node's own tracks
    expect(o.frames['25'].Bone1.scale).toEqual([0.6, 1.8, 1.2]);
    expect(worstScale(layer)).toBeLessThan(1e-6);

    let compared = 0;
    let worstHead = 0;
    for (const [frame, bones] of Object.entries(o.frames)) {
      const ours = worldAt(layer, (Number(frame) - 1) / o.fps);
      for (const name of ['Bone0', 'Bone1']) {
        const head = (bones[name] as unknown as { head: number[] }).head;
        worstHead = Math.max(worstHead, headOf(ours.get(name)!).distanceTo(theirHead(head)));
        compared += 1;
      }
    }
    expect(compared).toBe(5 * 2);
    expect(worstHead).toBeLessThan(1e-6);
  });

  it('with the scale channels removed, Bone1 no longer scales as Blender’s does — the row can fail', () => {
    const { params } = imported(KEYED_SCALE());
    const state = apply(
      [
        {
          type: 'setParam',
          nodeId: 'layer',
          paramPath: 'channels',
          value: params.channels.filter((c) => c.component !== 'scale'),
        },
      ],
      apply(
        buildFbxImportOps({
          data: KEYED_SCALE(),
          name: 'walk',
          ids: { skeleton: 'sk', layer: 'layer' },
        }).ops,
      ),
    );
    expect(worstScale(wire(state, 'layer', 'out'))).toBeGreaterThan(0.5);
  });
});

describe('walk against Blender 5.1.1’s import of the same FBX', () => {
  const o = oracle('blender-oracle-walk-fbx.json');

  it('at the first frame, where every curve has a key: every bone’s head and rotation', () => {
    const { layer } = imported(WALK());
    const ours = worldAt(layer, 0);
    const heights = Object.values(o.frames['1']).map((b) => b.head[2]);
    const HEIGHT = Math.max(...heights) - Math.min(...heights);
    expect(HEIGHT).toBeGreaterThan(100);
    let worstHead = 0;
    let worstDeg = 0;
    for (const [name, b] of Object.entries(o.frames['1'])) {
      const mine = ours.get(name)!;
      const theirs = theirHead(b.head);
      worstHead = Math.max(worstHead, headOf(mine).distanceTo(theirs) / HEIGHT);
      worstDeg = Math.max(worstDeg, degrees(rotOf(mine), theirQ(b.quat)));
    }
    expect(Object.keys(o.frames['1'])).toHaveLength(94);
    // Against the rig's height (~160 units), not each bone's distance out: measured 4.9e-7, the
    // worst at the feet, growing down the leg chain. That is Blender's float32 evaluation (ulp at
    // 100 is 7.6e-6, compounded per bone), the gap the BVH oracle measured too; a wrong axis or
    // unit reads tens of units. #1296: a hundredth of Blender's size read 0.99 here.
    expect(worstHead, 'of the rig height').toBeLessThan(1e-6);
    expect(worstDeg, 'degrees').toBeLessThan(0.01);
  });

  // #1279 — KNOWN WRONG, pinned so it cannot be forgotten. three r169's FBXLoader pairs each bone's
  // X, Y and Z euler keys by index on X's times, and Blender's exporter simplifies each axis on its
  // own, so between frame 1 and the end most bones turn the wrong way (22.5° worst, measured over
  // every frame against Blender and against the source BVH). THIS ROW FAILS WHEN #1279 IS FIXED:
  // replace it then with the same comparison at every oracle frame, under Blender's precision.
  it('#1279 — at the middle and last frames, most bones still disagree with Blender', () => {
    const { layer } = imported(WALK());
    const first = worldAt(layer, 0);
    let worstDeg = 0;
    for (const f of ['60', '120']) {
      const ours = worldAt(layer, (Number(f) - 1) / o.fps);
      for (const [name, b] of Object.entries(o.frames[f])) {
        const relTheirs = theirQ(b.quat).multiply(theirQ(o.frames['1'][name].quat).invert());
        const relOurs = rotOf(ours.get(name)!).multiply(rotOf(first.get(name)!).invert());
        worstDeg = Math.max(worstDeg, degrees(relTheirs, relOurs));
      }
    }
    expect(worstDeg).toBeGreaterThan(10);
  });
});
