// #1434 step 4 — what an FBX lands as, through the assembly every door uses (`motionImportOps`).
//
// A file with no bone is a MODEL: Blender 5.1.1's FBX import of `rigless-hierarchy-blender-default.fbx`
// (probe q20; oracle q21) makes an Empty `Holder` over a keyed `Cube` over a `Cone`, and a loose
// `Plane`, with no armature. Ours writes the same Objects and Group, in an import Group (user decision
// on #1434: an FBX lands in one, as a glTF does), and no Skeleton, no pose layer and nothing to bind.
// The oracle compares WORLD placement, so the import Group's pivot must move nothing.
//
// A node ABOVE the armature (`above-armature-one-take.fbx`, probe q26; oracle q21): Blender hangs
// the armature under the Empty `Stand`, keyed upward. Ours folds `Stand`'s place into the bones and
// stands the skeleton at the top, so the rig is right at load and does not follow `Stand`'s keys —
// which the import says in its notices.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { __resetRegistryForTests } from '../dag/registry';
import { applyOp } from '../dag';
import type { DagState } from '../dag/state';
import { buildDefaultDagState } from '../project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { motionImportOps, type MotionImportOps } from '../../app/asset/importBvhFbx';
import { resolveWorldTransform } from '../../app/resolveWorldTransform';
import { buildFbxImportOps } from './fbxImportChain';
import { computeGltfBoundsCenter } from './gltfImportChain';
import { skeletonObjectId } from './skeletonObject';

const DIR = 'src/core/import/__fixtures__';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const bytes = (file: string): ArrayBuffer => {
  const b = readFileSync(`${DIR}/${file}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

interface OracleFrame {
  world_translation: [number, number, number];
  world_quat_wxyz: [number, number, number, number];
  world_scale: [number, number, number];
}
interface Oracle {
  objects: Record<
    string,
    {
      type: string;
      parent: string | null;
      parent_type: string;
      frames: Record<string, OracleFrame>;
    }
  >;
}
const oracleOf = (file: string) => JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8')) as Oracle;

/** Blender's Z-up world, in Y-up: (x, y, z) → (x, z, −y), the scale's Y and Z swapped. */
function yUp(frame: OracleFrame) {
  const [x, y, z] = frame.world_translation;
  const [w, qx, qy, qz] = frame.world_quat_wxyz;
  const [sx, sy, sz] = frame.world_scale;
  return {
    t: new Vector3(x, z, -y),
    q: new Quaternion(qx, qz, -qy, w).normalize(),
    s: new Vector3(sx, sz, sy),
  };
}

/** Blender's frame f is the file's time (f − 1) / fps, at its default 24. */
const at = (frame: number) =>
  ({ time: { frame, seconds: (frame - 1) / 24, normalized: 0 } }) as never;

async function imported(file: string): Promise<{ state: DagState; landed: MotionImportOps }> {
  let state = buildDefaultDagState();
  const landed = motionImportOps(
    await buildFbxImportOps({
      data: bytes(file),
      name: 'file',
      ids: { skeleton: 'sk', layer: 'motion', group: 'grp' },
      storeImage: () => Promise.resolve('img'),
    }),
    'file',
    state,
  );
  for (const op of landed.ops) state = applyOp(state, op).next;
  return { state, landed };
}

const named = (state: DagState, name: string) => {
  const found = Object.values(state.nodes).filter(
    (n) =>
      (n.type === 'Object' || n.type === 'Group') &&
      (n.meta as { name?: string } | undefined)?.name === name,
  );
  expect(found, `nodes named ${name}`).toHaveLength(1);
  return found[0];
};

/** The node whose `children` holds `id`. */
function parentOf(state: DagState, id: string): string | null {
  for (const node of Object.values(state.nodes)) {
    const children = node.inputs?.children;
    const list = Array.isArray(children) ? children : children ? [children] : [];
    if (list.some((ref) => ref.node === id)) return node.id;
  }
  return null;
}

function worldOf(state: DagState, id: string, frame: number) {
  const world = resolveWorldTransform(state, id, at(frame))!;
  const t = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  new Matrix4().fromArray(world.matrix).decompose(t, q, s);
  return { t, q, s };
}

const RIGLESS = 'rigless-hierarchy-blender-default.fbx';
const RIGLESS_ORACLE = oracleOf('blender-oracle-fbx-rigless-hierarchy.json');
const RIGLESS_OBJECTS = Object.keys(RIGLESS_ORACLE.objects).sort();

describe('#1434 — a file with no bone lands as a model', () => {
  it('says it is a model, and writes no Skeleton, no pose layer and nothing to bind', async () => {
    const { state, landed } = await imported(RIGLESS);
    expect(landed.kind).toBe('model');
    expect(landed).not.toHaveProperty('skeletonId');
    expect(landed).not.toHaveProperty('motionId');
    const types = new Set(Object.values(state.nodes).map((n) => n.type));
    expect(types.has('Skeleton')).toBe(false);
    expect(types.has('PoseLayer')).toBe(false);
    expect(landed.notices).toEqual([]);
  });

  it('the fixture holds no armature and a keyed Cube: what the rows below are about', () => {
    expect(RIGLESS_OBJECTS).toEqual(['Cone', 'Cube', 'Holder', 'Plane']);
    expect(Object.values(RIGLESS_ORACLE.objects).some((o) => o.type === 'ARMATURE')).toBe(false);
    const cube = RIGLESS_ORACLE.objects.Cube.frames;
    expect(cube['25'].world_translation[2] - cube['1'].world_translation[2]).toBeCloseTo(1, 4);
  });

  it('stands in an import Group under the scene, which holds every top-level Object', async () => {
    const { state, landed } = await imported(RIGLESS);
    expect(landed.kind === 'model' && landed.groupId).toBe('grp');
    expect(state.nodes.grp.type).toBe('Group');
    expect(parentOf(state, 'grp')).toBe(state.outputs.scene!.node);
    for (const name of RIGLESS_OBJECTS) {
      const blender = RIGLESS_ORACLE.objects[name];
      const want = blender.parent === null ? 'grp' : named(state, blender.parent).id;
      expect(parentOf(state, named(state, name).id), name).toBe(want);
    }
  });

  it('the Group turns about the centre of the meshes as drawn, and moves nothing', async () => {
    const { state } = await imported(RIGLESS);
    const { position, pivot } = state.nodes.grp.params as { position: number[]; pivot: number[] };
    // Not the origin: a pivot left at zero would pass the placement rows trivially.
    expect(Math.hypot(...pivot)).toBeGreaterThan(0.5);
    expect(position).toEqual(pivot);
    // The glTF road's pivot for Blender's glTF export of the same scene: the two formats agree on
    // where every point is (V602), so a pivot computed alike lands alike.
    const glb = readFileSync(`${DIR}/rigless-hierarchy-blender-default.glb`);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    const want = computeGltfBoundsCenter(json);
    for (let i = 0; i < 3; i++) expect(pivot[i]).toBeCloseTo(want[i], 4);
  });

  it.each(RIGLESS_OBJECTS.flatMap((name) => [1, 25].map((frame) => [name, frame] as const)))(
    '%s: world position, orientation and scale at frame %i, as Blender stands it',
    async (name, frame) => {
      const { state } = await imported(RIGLESS);
      const want = yUp(RIGLESS_ORACLE.objects[name].frames[String(frame)]);
      const got = worldOf(state, named(state, name).id, frame);
      expect(got.t.distanceTo(want.t)).toBeLessThan(1e-4);
      expect(Math.abs(Math.abs(got.q.dot(want.q)) - 1)).toBeLessThan(1e-6);
      expect(got.s.distanceTo(want.s)).toBeLessThan(1e-4);
    },
  );

  it('every Object and Group is in euler mode, as Blender’s FBX import makes each one', async () => {
    const { state } = await imported(RIGLESS);
    for (const name of RIGLESS_OBJECTS) {
      expect((named(state, name).params as { rotationMode?: string }).rotationMode, name).toBe(
        undefined,
      );
    }
  });
});

const ABOVE = 'above-armature-one-take.fbx';
const ABOVE_ORACLE = oracleOf('blender-oracle-fbx-above-armature.json');

describe('#1434 — a node above the armature', () => {
  it('Blender hangs the armature under the keyed Empty, and the rig follows it', () => {
    expect(ABOVE_ORACLE.objects.Rig.parent).toBe('Stand');
    const held = ABOVE_ORACLE.objects.Held.frames;
    expect(held['25'].world_translation[2] - held['1'].world_translation[2]).toBeGreaterThan(1.9);
  });

  it('lands as a character in the import Group, the skeleton’s Object at its top', async () => {
    const { state, landed } = await imported(ABOVE);
    expect(landed.kind).toBe('character');
    expect(parentOf(state, skeletonObjectId('sk'))).toBe('grp');
    expect(parentOf(state, named(state, 'Stand').id)).toBe('grp');
  });

  it('says the skeleton does not follow the node above it', async () => {
    const { landed } = await imported(ABOVE);
    expect(landed.notices).toEqual([
      'the armature "Rig" hangs under "Stand" in the file; its skeleton stands at the top of the import, where it is drawn at load, so moving or keying "Stand" does not carry it',
    ]);
  });

  it.each(['Stand', 'Held'])('%s stands where Blender stands it at load', async (name) => {
    const { state } = await imported(ABOVE);
    const want = yUp(ABOVE_ORACLE.objects[name].frames['1']);
    const got = worldOf(state, named(state, name).id, 1);
    expect(got.t.distanceTo(want.t)).toBeLessThan(1e-4);
    expect(Math.abs(Math.abs(got.q.dot(want.q)) - 1)).toBeLessThan(1e-6);
  });

  it('what the notice names: Stand plays its keys, and the rig under it does not follow', async () => {
    const { state } = await imported(ABOVE);
    const stand = worldOf(state, named(state, 'Stand').id, 25);
    expect(stand.t.distanceTo(yUp(ABOVE_ORACLE.objects.Stand.frames['25']).t)).toBeLessThan(1e-4);
    const held = worldOf(state, named(state, 'Held').id, 25);
    expect(held.t.distanceTo(yUp(ABOVE_ORACLE.objects.Held.frames['1']).t)).toBeLessThan(1e-4);
    expect(held.t.distanceTo(yUp(ABOVE_ORACLE.objects.Held.frames['25']).t)).toBeGreaterThan(1.9);
  });
});
