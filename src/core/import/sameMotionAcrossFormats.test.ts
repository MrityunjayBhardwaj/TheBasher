// #1211 — the same motion, dropped as a .glb or as a .bvh, becomes the same thing: a Skeleton whose
// rest pose feeds one base override PoseLayer holding the file's keys. No importer writes a clip.
//
// THE FILES. `public/assets/motion/walk.bvh`, and Blender 5.1.1's default glTF export of that BVH
// imported with defaults (`__fixtures__/walk-blender-default.glb`, probe `q1211_bvh_to_glb.py`: one
// skin of 78 joints, no mesh, 234 channels, LINEAR and 2-key STEP). Blender's own round trip keeps the
// motion: its re-import of this glb matches its BVH import to 0.0015 in heads at every whole frame
// (probe `q1211_glb_roundtrip.py`), so a difference here is ours.
//
// THE CLOCK. Blender imports the BVH at frame 1 and writes scene frame f at glTF time f/24
// (`frame_start` 1, no fps scaling), so BVH frame k (from 0) is glTF time (k + 1)/24.
//
// BETWEEN KEYS THE FORMATS DIFFER, AS IN BLENDER. A BVH lands as euler members in the file's order
// (ZYX here), a glTF as quaternion members, and each interpolates in its own mode. Blender's BVH import
// and its glb re-import differ between keys by 0.1371° and 0.139 in heads at half frames, and by 0.0°
// at whole frames (probe `q1211_glb_vs_bvh_midframes.py`). The rows below hold ours to the same shape.
//
// The .fbx arm joins when the FBX reader reads curves as Blender does (#1279).

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { __resetRegistryForTests, applyOp, evaluate } from '../dag';
import type { DagState } from '../dag/state';
import { buildDefaultDagState } from '../project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildNativeGltfImportOps } from './nativeGltfImport';
import { buildBvhImportOps } from './bvhImportChain';
import type { PosedSkeletonValue } from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';

const BVH = readFileSync('public/assets/motion/walk.bvh', 'utf8');
const FRAME_TIME = Number(/Frame Time:\s*([0-9.eE+-]+)/.exec(BVH)![1]);
const FRAMES = 120;
const glbSeconds = (k: number) => (k + 1) / 24;
const bvhSeconds = (k: number) => k * FRAME_TIME;

/** Blender 5.1.1, its BVH import against its glb re-import, at half frames (probe above). */
const BLENDER_MIDFRAME = { degrees: 0.1371, head: 0.13875 };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** The import's own nodes (the default project's are left out). */
function added(before: DagState, after: DagState) {
  return Object.values(after.nodes).filter((n) => !(n.id in before.nodes));
}

async function glbRoad() {
  const before = buildDefaultDagState();
  const bytes = readFileSync('src/core/import/__fixtures__/walk-blender-default.glb');
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/walk/walk.glb',
    sceneNodeId: before.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  let state = before;
  for (const op of result.ops) state = applyOp(state, op).next;
  return { before, state };
}

function bvhRoad() {
  const before = buildDefaultDagState();
  let state = before;
  for (const op of buildBvhImportOps({ text: BVH, name: 'walk' }).ops) {
    state = applyOp(state, op).next;
  }
  return { before, state };
}

/** The motion chain: the one Skeleton, the one layer its `pose` feeds, and that layer's output. */
function motionOf({ before, state }: { before: DagState; state: DagState }) {
  const nodes = added(before, state);
  const skeletons = nodes.filter((n) => n.type === 'Skeleton');
  const layers = nodes.filter((n) => n.type === 'PoseLayer');
  expect(skeletons).toHaveLength(1);
  expect(layers).toHaveLength(1);
  const layer = layers[0];
  expect(layer.inputs.pose).toEqual({ node: skeletons[0].id, socket: 'pose' });
  const wire = evaluate(state, layer.id, {
    ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    socket: 'out',
  }).value as PosedSkeletonValue;
  return { nodes, params: layer.params as PoseLayerParams, wire };
}

/** Every bone's world matrix at `seconds`, by name. */
function world(wire: PosedSkeletonValue, seconds: number): Map<string, Matrix4> {
  const local = wire.sample(seconds);
  const out: Matrix4[] = [];
  wire.skeleton.bones.forEach((b, i) => {
    const m = new Matrix4().compose(
      new Vector3(...local[i].position),
      new Quaternion(...local[i].quaternion),
      new Vector3(...local[i].scale),
    );
    out[i] = b.parent < 0 ? m : out[b.parent].clone().multiply(m);
  });
  return new Map(wire.skeleton.bones.map((b, i) => [b.name, out[i]]));
}
const headOf = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const rotOf = (m: Matrix4) => {
  const q = new Quaternion();
  m.decompose(new Vector3(), q, new Vector3());
  return q.normalize();
};
/** Normalised first: float32 keys sit ~1e-7 off unit length, which `acos` near 1 magnifies. */
const degrees = (a: Quaternion, b: Quaternion) =>
  (2 * Math.acos(Math.min(1, Math.abs(a.clone().normalize().dot(b.clone().normalize())))) * 180) /
  Math.PI;

/**
 * The worst difference between the two roads over every bone, at every key (`half` 0) or halfway
 * between keys (`half` 0.5): world heads, and world rotation since the first frame. Relative
 * rotations, because each road's bones rest in their own orientation (Blender gives its bones a roll
 * on export); a head does not depend on it.
 */
function worst(glb: PosedSkeletonValue, bvh: PosedSkeletonValue, half: 0 | 0.5) {
  const g0 = world(glb, glbSeconds(0));
  const b0 = world(bvh, bvhSeconds(0));
  let head = 0;
  let deg = 0;
  let compared = 0;
  for (let k = 0; k < FRAMES - (half ? 1 : 0); k++) {
    const g = world(glb, glbSeconds(k + half));
    const b = world(bvh, bvhSeconds(k + half));
    for (const [name, gm] of g) {
      const bm = b.get(name);
      if (!bm) continue;
      compared += 1;
      head = Math.max(head, headOf(gm).distanceTo(headOf(bm)));
      deg = Math.max(
        deg,
        degrees(
          rotOf(gm).multiply(rotOf(g0.get(name)!).invert()),
          rotOf(bm).multiply(rotOf(b0.get(name)!).invert()),
        ),
      );
    }
  }
  return { head, deg, compared };
}

describe('#1211 — walk as .glb and as .bvh', () => {
  it('both land as a Skeleton feeding one base layer, over the same 78 bones, and neither writes a clip', async () => {
    const glb = motionOf(await glbRoad());
    const bvh = motionOf(bvhRoad());
    for (const road of [glb, bvh]) {
      expect(road.params.mode).toBe('override');
      expect(road.nodes.some((n) => n.type === 'AnimationClip' || n.type === 'TransformClip')).toBe(
        false,
      );
    }
    const names = (w: PosedSkeletonValue) => w.skeleton.bones.map((b) => b.name).sort();
    expect(names(glb.wire)).toHaveLength(78);
    expect(names(glb.wire)).toEqual(names(bvh.wire));
    const members = (p: PoseLayerParams) => p.members.map((m) => m.bone).sort();
    expect(members(glb.params)).toEqual(members(bvh.params));
    // Each format's own rotation mode, as Blender's importers give it: quaternion from glTF, the
    // file's channel order from BVH.
    expect(new Set(glb.params.members.map((m) => m.rotationMode))).toEqual(new Set(['quaternion']));
    expect(new Set(bvh.params.members.map((m) => m.rotationMode))).toEqual(new Set(['ZYX']));
  });

  it('the glb starts at Blender’s frame 1, so its first key is at 1/24 s', async () => {
    const { params } = motionOf(await glbRoad());
    const first = Math.min(...params.channels.flatMap((c) => c.keyframes.map((k) => k.time)));
    expect(first).toBeCloseTo(1 / 24, 6);
  });

  // THE BOUND IS THE EXPORT'S float32. Measured: 1.4e-3 in heads on a rig ~160 units tall (Blender's
  // own round trip reads 1.5e-3), 0.0016° in rotation. A frame off reads ~10 units; a wrong axis
  // order tens of degrees.
  it('at every key, every bone stands and turns the same on both roads', async () => {
    const { head, deg, compared } = worst(
      motionOf(await glbRoad()).wire,
      motionOf(bvhRoad()).wire,
      0,
    );
    expect(compared).toBe(78 * FRAMES);
    expect(head).toBeLessThan(2e-3);
    expect(deg).toBeLessThan(0.005);
  });

  it('halfway between keys they differ as Blender’s two imports differ: each format’s rotation mode', async () => {
    const { head, deg, compared } = worst(
      motionOf(await glbRoad()).wire,
      motionOf(bvhRoad()).wire,
      0.5,
    );
    expect(compared).toBe(78 * (FRAMES - 1));
    // Measured: 0.1335° and 0.153. Not zero (the modes really differ), and no further apart than
    // Blender's own gap plus the key-time float32 bound.
    expect(deg).toBeGreaterThan(0.05);
    expect(Math.abs(deg - BLENDER_MIDFRAME.degrees)).toBeLessThan(0.02);
    expect(head).toBeLessThan(BLENDER_MIDFRAME.head * 1.25);
  });
});
