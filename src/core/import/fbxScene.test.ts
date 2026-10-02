// #1434 step 2 — an FBX file's empties and unskinned meshes, laid out as Blender's FBX importer lays
// them out, re-expressed in Y-up (`fbxScene.ts`).
//
// The scene is made in Blender 5.1.1 and exported with its FBX defaults
// (`ref/probes/blender-armature-deform/q23_fbx_scene_fixture.py`): a rig with a cube parented to its
// bone, an empty over a cube over a cone, a ZXY empty over a non-uniformly scaled cone, and a loose
// plane. Two oracles: Blender's FBX import of the file (`q21_fbx_rigless_oracle.py`), for where each
// object IS, and Blender's glTF export of the same scene, for what each object's FIELDS read in Y-up
// (position, orientation and scale only: the two importers differ in rotation mode).

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Euler,
  Group,
  Line,
  Matrix4,
  Mesh,
  BufferGeometry,
  Quaternion,
  Vector3,
  type Object3D,
} from 'three';
import { __resetRegistryForTests } from '../dag/registry';
import { applyOp } from '../dag';
import type { DagState } from '../dag/state';
import { buildDefaultDagState } from '../project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { motionImportOps } from '../../app/asset/importBvhFbx';
import { resolveWorldTransform } from '../../app/resolveWorldTransform';
import { unpackMeshData, type PackedMeshData } from '../../app/meshGeometryData';
import { skeletonObjectId } from './skeletonObject';
import { parseGltfContainer, readAccessor, resolveBuffers } from './glb';
import { buildFbxImportOps } from './fbxImportChain';
import { parseFbx } from './fbx';
import { readFbxScene } from './fbxScene';

const DIR = 'src/core/import/__fixtures__';
const SCENE = 'rigged-scene-blender-default';

const bytes = (file: string): ArrayBuffer => {
  const b = readFileSync(`${DIR}/${file}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

interface OracleObject {
  type: string;
  parent: string | null;
  parent_type: string;
  parent_bone: string | null;
  frames: Record<
    string,
    {
      rotation_mode: string;
      world_translation: [number, number, number];
      world_quat_wxyz: [number, number, number, number];
      world_scale: [number, number, number];
    }
  >;
}
const oracleOf = (file: string) =>
  JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8')) as { objects: Record<string, OracleObject> };
const ORACLE = oracleOf('blender-oracle-fbx-rigged-scene.json');

/** The file through the assembly every FBX door uses, into a default project. */
async function imported(file: string): Promise<{ state: DagState; notices: readonly string[] }> {
  let state = buildDefaultDagState();
  const built = motionImportOps(
    await buildFbxImportOps({
      data: bytes(file),
      name: 'scene',
      ids: { skeleton: 'sk', layer: 'motion' },
      storeImage: () => Promise.resolve('img'),
    }),
    'scene',
    state,
  );
  for (const op of built.ops) state = applyOp(state, op).next;
  return { state, notices: built.notices };
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
    const children = (node.inputs as Record<string, unknown>).children;
    const list = Array.isArray(children) ? children : children ? [children] : [];
    if (list.some((edge) => (edge as { node?: string }).node === id)) return node.id;
  }
  return null;
}

const AT = { time: { frame: 0, seconds: 0, normalized: 0 } } as never;

/** Blender's Z-up world, in Y-up: (x, y, z) → (x, z, −y), the scale's Y and Z swapped. */
function yUp(frame: OracleObject['frames'][string]) {
  const [x, y, z] = frame.world_translation;
  const [w, qx, qy, qz] = frame.world_quat_wxyz;
  const [sx, sy, sz] = frame.world_scale;
  return {
    t: new Vector3(x, z, -y),
    // The oracle rounds to 5 decimals, which leaves its quaternions up to ~1e-5 off unit length.
    q: new Quaternion(qx, qz, -qy, w).normalize(),
    s: new Vector3(sx, sz, sy),
  };
}

/** Each named glTF node's own TRS, and each mesh node's POSITION values. */
async function gltfOf(file: string) {
  const { json, bin } = parseGltfContainer(bytes(file));
  const buffers = await resolveBuffers(json, bin);
  const nodes = json.nodes as {
    name?: string;
    mesh?: number;
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  const meshes = (
    json as unknown as { meshes: { primitives: { attributes: { POSITION: number } }[] }[] }
  ).meshes;
  const trs = new Map<string, { t: Vector3; q: Quaternion; s: Vector3 }>();
  const points = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (!node.name) continue;
    trs.set(node.name, {
      t: new Vector3(...((node.translation ?? [0, 0, 0]) as [number, number, number])),
      q: new Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
      s: new Vector3(...((node.scale ?? [1, 1, 1]) as [number, number, number])),
    });
    if (node.mesh === undefined) continue;
    const set = new Set<string>();
    for (const primitive of meshes[node.mesh].primitives) {
      const values = readAccessor(json, buffers, primitive.attributes.POSITION) as Float32Array;
      for (let i = 0; i < values.length; i += 3)
        set.add(key(values[i], values[i + 1], values[i + 2]));
    }
    points.set(node.name, set);
  }
  return { trs, points };
}

const key = (x: number, y: number, z: number) =>
  [x, y, z].map((v) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4)).join(',');

const quaternionOfDegrees = (r: number[]) =>
  new Quaternion().setFromEuler(
    new Euler(...(r.map((d) => (d * Math.PI) / 180) as [number, number, number]), 'XYZ'),
  );

/** Every Blender object but the armature, whose Object stands at identity (#1190's choice). */
const PLACED = Object.entries(ORACLE.objects)
  .filter(([, o]) => o.type !== 'ARMATURE')
  .map(([name]) => name);

describe('#1434 step 2 — every object of the file stands where Blender stands it', () => {
  it('the fixture holds what the test is about: empties, nesting, a bone parent, a non-XYZ order', () => {
    expect(PLACED.sort()).toEqual(['Cone', 'Cube', 'Held', 'Holder', 'Plane', 'Spike', 'Spun']);
    expect(ORACLE.objects.Held.parent_type).toBe('BONE');
    expect(ORACLE.objects.Holder.type).toBe('EMPTY');
  });

  it.each(PLACED)('%s: world position, orientation and scale at frame 1', async (name) => {
    const { state } = await imported(`${SCENE}.fbx`);
    const want = yUp(ORACLE.objects[name].frames['1']);
    const world = resolveWorldTransform(state, named(state, name).id, AT)!;
    const t = new Vector3();
    const q = new Quaternion();
    const s = new Vector3();
    new Matrix4().fromArray(world.matrix).decompose(t, q, s);
    expect(t.distanceTo(want.t)).toBeLessThan(1e-4);
    expect(Math.abs(Math.abs(q.dot(want.q)) - 1)).toBeLessThan(1e-6);
    expect(s.distanceTo(want.s)).toBeLessThan(1e-4);
  });
});

describe('#1434 step 2 / #1440 — each object’s FIELDS read Blender’s split, in Y-up', () => {
  it.each(PLACED)(
    '%s: its own position, orientation and scale are the glTF export’s',
    async (name) => {
      const { state } = await imported(`${SCENE}.fbx`);
      const { trs } = await gltfOf(`${SCENE}.glb`);
      const want = trs.get(name)!;
      const p = named(state, name).params as {
        position: number[];
        rotation: number[];
        scale: number[];
      };
      expect(
        new Vector3(...(p.position as [number, number, number])).distanceTo(want.t),
      ).toBeLessThan(1e-4);
      expect(Math.abs(Math.abs(quaternionOfDegrees(p.rotation).dot(want.q)) - 1)).toBeLessThan(
        1e-6,
      );
      expect(new Vector3(...(p.scale as [number, number, number])).distanceTo(want.s)).toBeLessThan(
        1e-4,
      );
    },
  );

  it.each(PLACED)('%s: in euler mode, as Blender’s FBX import makes every object', async (name) => {
    expect(ORACLE.objects[name].frames['1'].rotation_mode).toBe('XYZ');
    const { state } = await imported(`${SCENE}.fbx`);
    expect((named(state, name).params as { rotationMode?: string }).rotationMode).toBeUndefined();
  });

  it('#1440 — the icosphere beside a rig reads rotation 0 and scale 1, as in Blender', async () => {
    const oracle = oracleOf('blender-oracle-fbx-keyed-bar-objects.json').objects.Icosphere;
    expect(oracle.frames['1'].rotation_mode).toBe('XYZ');
    const { state } = await imported('skinned-bar-keyed-scale-blender-default.fbx');
    const p = named(state, 'Icosphere').params as { rotation: number[]; scale: number[] };
    // Within 1e-4°: the file's own −90° reads −90.0000093 in single precision.
    p.rotation.forEach((r) => expect(r).toBeCloseTo(0, 4));
    p.scale.forEach((v) => expect(v).toBeCloseTo(1, 6));
  });

  it.each(['Cube', 'Cone', 'Spike', 'Plane', 'Held'])(
    '%s: its points are the glTF export’s, in the Object’s own frame',
    async (name) => {
      const { state } = await imported(`${SCENE}.fbx`);
      const { points } = await gltfOf(`${SCENE}.glb`);
      const id = (named(state, name).inputs.data as { node: string }).node;
      const packed = (state.nodes[id].params as { mesh: PackedMeshData }).mesh;
      const mesh = unpackMeshData(packed);
      const ours = new Set<string>();
      for (let i = 0; i < mesh.points.length; i += 3) {
        ours.add(key(mesh.points[i], mesh.points[i + 1], mesh.points[i + 2]));
      }
      expect([...ours].sort()).toEqual([...points.get(name)!].sort());
    },
  );
});

describe('#1434 step 2 — the hierarchy is the file’s, as edges', () => {
  it('each object hangs under its Blender parent; a top-level one under the scene', async () => {
    const { state } = await imported(`${SCENE}.fbx`);
    const scene = state.outputs.scene!.node;
    for (const name of PLACED) {
      const blender = ORACLE.objects[name];
      const parent = parentOf(state, named(state, name).id);
      if (blender.parent_type === 'BONE') {
        expect(parent, name).toBe(skeletonObjectId('sk'));
      } else if (blender.parent === null) {
        expect(parent, name).toBe(scene);
      } else {
        expect(parent, name).toBe(named(state, blender.parent).id);
      }
    }
  });

  it('a mesh under a bone names the bone it hangs from', async () => {
    const { state } = await imported(`${SCENE}.fbx`);
    expect(ORACLE.objects.Held.parent_bone).toBe('Arm');
    expect((named(state, 'Held').params as { parentBone?: string }).parentBone).toBe('Arm');
  });
});

describe('#1434 step 2 — a node the rig reader claims is never written by the scene', () => {
  // The armature node (its transform folded into the bones, #1190) and an empty inside the chain
  // (Blender's fake bone). Written as a Group too, each transform would apply twice.
  it.each([
    [`${SCENE}.fbx`, ['Rig']],
    ['skinned-bar-keyed-scale-blender-default.fbx', ['SkinnedBar']],
    ['panel-five-influences-blender-default.fbx', ['Rig']],
  ])('%s: no node written for %j or for any bone', (file, armatures) => {
    const parsed = parseFbx(bytes(file), 'x');
    const written = parsed.scene.nodes.map((n) => n.name);
    const bones = parsed.skeletonParams.bones.map((b) => b.name);
    expect(written.filter((n) => armatures.includes(n) || bones.includes(n))).toEqual([]);
  });

  it('null-in-chain.fbx: its armature and the empty inside its chain stay the rig’s', () => {
    const b = readFileSync('public/fixtures/anim/null-in-chain.fbx');
    const parsed = parseFbx(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    );
    expect(parsed.skeletonParams.bones.map((x) => x.name)).toContain('Mid');
    expect(parsed.scene.nodes.map((n) => n.name)).toEqual([]);
  });
});

describe('#1434 step 2 — what the scene cannot hold is refused by name', () => {
  it('a camera refuses the import, under the issue that brings cameras across', async () => {
    await expect(imported('unskinned-edges-blender-default.fbx')).rejects.toThrow(
      'FBX node "Cam" is a camera, which an import does not bring across yet (#1319).',
    );
  });

  it('two Objects sharing one mesh refuse the import, under the issue that brings sharing', async () => {
    await expect(imported('rigged-scene-shared-mesh-blender-default.fbx')).rejects.toThrow(
      'FBX nodes "Plane" and "PlaneB" share one mesh, which an import does not bring across yet (#1061).',
    );
  });

  // Built by hand: no exporter writes these, and each guard must be seen to fire.
  const fileNode = <T extends Object3D>(node: T, name: string, id: number): T => {
    node.name = name;
    (node as unknown as { ID: number }).ID = id;
    return node;
  };
  const args = (claimed: Object3D[] = []) => ({
    claimed: new Set(claimed),
    armatures: new Set<Object3D>(),
    boneIndexOf: () => -1,
    boneWorlds: [],
    meshOf: new Map<Object3D, number>(),
    metresPerUnit: 1,
  });

  it('a placement an Object cannot hold (a shear) is refused, not kept wrong', () => {
    // A non-uniform scale on a CLAIMED node over a turned child: the child's local, taken from its
    // written grandparent, is the stretch times the turn — a shear. (A stretch on the written parent
    // itself multiplies back out and shears nothing.)
    const scene = new Group();
    const plain = fileNode(new Group(), 'Plain', 1);
    const between = fileNode(new Group(), 'Between', 2);
    between.scale.set(1, 3, 1);
    const turned = fileNode(new Group(), 'Turned', 3);
    turned.rotation.set(0, 0, Math.PI / 4);
    scene.add(plain);
    plain.add(between);
    between.add(turned);
    expect(() => readFbxScene(scene, args([between]))).toThrow(
      'FBX node "Turned" has a placement an Object cannot hold',
    );
  });

  it('the same nodes without the stretch are held, the turn read through the claimed node', () => {
    const scene = new Group();
    const plain = fileNode(new Group(), 'Plain', 1);
    const between = fileNode(new Group(), 'Between', 2);
    const turned = fileNode(new Group(), 'Turned', 3);
    turned.rotation.set(0, 0, Math.PI / 4);
    scene.add(plain);
    plain.add(between);
    between.add(turned);
    const { nodes } = readFbxScene(scene, args([between]));
    expect(nodes.map((n) => n.name)).toEqual(['Plain', 'Turned']);
    // The file's 45° about Z is 45° about Y in Y-up.
    nodes[1].transform.rotation.forEach((r, axis) => expect(r).toBeCloseTo([0, 45, 0][axis], 9));
  });

  it('a curve is left out and named', () => {
    const scene = new Group();
    scene.add(fileNode(new Line(new BufferGeometry()), 'Path', 1));
    scene.add(fileNode(new Mesh(new BufferGeometry()), 'Unread', 2));
    expect(readFbxScene(scene, args()).notices).toEqual([
      'curve "Path" was left out: curves are not imported',
    ]);
  });
});
