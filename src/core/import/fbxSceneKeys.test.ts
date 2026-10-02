// #1441 (#1434 step 3) — an FBX's keyed empties and loose meshes play as Object channels, folded as
// their transforms are (`fbxScene.ts`, KEYS), and every track that plays nowhere is named.
//
// The scene is made in Blender 5.1.1 and exported with its FBX defaults except "All Actions" and "NLA
// Strips", so the file holds ONE take keying every object (with them on, it holds one take per action
// per object — #1446) (`ref/probes/blender-armature-deform/q24_fbx_keyed_scene_fixture.py --one-take`):
// a top-level Empty sweeping 300° about Z under a keyed non-uniform scale, a keyed Cube under it and
// an unkeyed Cone under that, a top-level ZXY Empty keyed on three axes, and under an armature a keyed
// Empty on its bone (Tag), a keyed Empty on its Object (Flag), and two keyed MESHES (Held on the bone,
// Prop on the Object), whose keys Blender's import does not play. The oracle is Blender's FBX import of
// the file at every frame of the keys' span (`q25_fbx_keyed_oracle.py`).

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Group, Matrix4, Quaternion, Vector3, type Object3D } from 'three';
import { __resetRegistryForTests } from '../dag/registry';
import { applyOp } from '../dag';
import type { DagState } from '../dag/state';
import { buildDefaultDagState } from '../project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { motionImportOps } from '../../app/asset/importBvhFbx';
import { resolveWorldTransform } from '../../app/resolveWorldTransform';
import { objectChannelId } from './modelImport';
import { buildFbxImportOps, type FbxImportChainResult } from './fbxImportChain';
import { readFbxScene, type FbxNodeTrack } from './fbxScene';

const DIR = 'src/core/import/__fixtures__';
const FILE = 'keyed-scene-one-take.fbx';

const bytes = (file: string): ArrayBuffer => {
  const b = readFileSync(`${DIR}/${file}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

interface OracleFrame {
  world_translation: [number, number, number];
  world_quat_wxyz: [number, number, number, number];
  world_scale: [number, number, number];
}
interface OracleObject {
  type: string;
  parent: string | null;
  parent_type: string;
  rotation_mode: string;
  curves: { path: string; index: number; keys: [number, number][]; interpolation: string[] }[];
  frames: Record<string, OracleFrame>;
}
const ORACLE = JSON.parse(
  readFileSync(`${DIR}/blender-oracle-fbx-keyed-scene-one-take.json`, 'utf8'),
) as {
  blender: string;
  fps: number;
  sampled: [number, number];
  objects: Record<string, OracleObject>;
};

async function imported(): Promise<{
  state: DagState;
  built: FbxImportChainResult;
  notices: readonly string[];
}> {
  let state = buildDefaultDagState();
  const built = await buildFbxImportOps({
    data: bytes(FILE),
    name: 'keyed',
    ids: { skeleton: 'sk', layer: 'motion' },
    storeImage: () => Promise.resolve('img'),
  });
  const landed = motionImportOps(built, 'keyed', state);
  for (const op of landed.ops) state = applyOp(state, op).next;
  return { state, built, notices: landed.notices };
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

/** Blender's frame f is the file's time (f − 1) / fps: its import starts the take at frame 1. */
const at = (frame: number) =>
  ({ time: { frame, seconds: (frame - 1) / ORACLE.fps, normalized: 0 } }) as never;

const FRAMES = Array.from(
  { length: ORACLE.sampled[1] - ORACLE.sampled[0] + 2 },
  (_, i) => ORACLE.sampled[0] - 1 + i,
).filter((f) => ORACLE.objects.Holder.frames[String(f)]);
const KEYED = ['Holder', 'Cube', 'Spun', 'Tag', 'Flag'];
/** The keyed objects whose rotation is keyed: the Cube's is not (q24). */
const TURNED = ['Holder', 'Spun', 'Tag', 'Flag'];
const ALL = [...KEYED, 'Cone', 'Held', 'Prop'];

describe('#1441 — the fixture holds what the test is about', () => {
  it('Blender keys the empties and the free Cube in Euler, linear; it keys neither mesh under the armature', () => {
    expect(ORACLE.blender).toMatch(/^5\.1/);
    for (const name of KEYED) {
      const curves = ORACLE.objects[name].curves;
      expect(
        curves.map((c) => c.path),
        name,
      ).toContain('rotation_euler');
      expect(
        curves.some((c) => c.path === 'rotation_quaternion'),
        name,
      ).toBe(false);
      expect(new Set(curves.flatMap((c) => c.interpolation)), name).toEqual(new Set(['LINEAR']));
      expect(ORACLE.objects[name].rotation_mode, name).toBe('XYZ');
    }
    expect(ORACLE.objects.Held.curves).toEqual([]);
    expect(ORACLE.objects.Prop.curves).toEqual([]);
    expect([ORACLE.objects.Held.parent_type, ORACLE.objects.Prop.parent_type]).toEqual([
      'BONE',
      'OBJECT',
    ]);
    expect(ORACLE.objects.Tag.parent_type).toBe('BONE');
    // Holder's Z turn goes past 180° and on to 300°: Blender's keys stay continuous through it.
    const z = ORACLE.objects.Holder.curves.find(
      (c) => c.path === 'rotation_euler' && c.index === 2,
    )!;
    expect(z.keys.at(-1)![1]).toBeCloseTo((300 * Math.PI) / 180, 5);
    // Every frame of the take, 2 to 26: the exporter baked a key at each one.
    expect(FRAMES).toEqual(Array.from({ length: 25 }, (_, i) => i + 2));
  });
});

describe('#1441 — every object stands where Blender stands it, at every frame', () => {
  it.each(ALL)(
    '%s: world position, orientation and scale at each frame of the take',
    async (name) => {
      const { state } = await imported();
      const id = named(state, name).id;
      let worstT = 0;
      let worstQ = 0;
      let worstS = 0;
      for (const frame of FRAMES) {
        const want = yUp(ORACLE.objects[name].frames[String(frame)]);
        const world = resolveWorldTransform(state, id, at(frame))!;
        const t = new Vector3();
        const q = new Quaternion();
        const s = new Vector3();
        new Matrix4().fromArray(world.matrix).decompose(t, q, s);
        worstT = Math.max(worstT, t.distanceTo(want.t));
        worstQ = Math.max(worstQ, Math.abs(Math.abs(q.dot(want.q)) - 1));
        worstS = Math.max(worstS, s.distanceTo(want.s));
      }
      expect(worstT).toBeLessThan(1e-4);
      expect(worstQ).toBeLessThan(1e-6);
      expect(worstS).toBeLessThan(1e-4);
    },
  );

  it('the keyed objects do move: a still answer cannot pass the test above', () => {
    for (const name of [...KEYED, 'Cone']) {
      const first = ORACLE.objects[name].frames[String(FRAMES[0])].world_translation;
      const last = ORACLE.objects[name].frames[String(FRAMES.at(-1))];
      const moved =
        new Vector3(...first).distanceTo(new Vector3(...last.world_translation)) +
        Math.abs(
          Math.abs(
            new Quaternion(...last.world_quat_wxyz.slice(1), last.world_quat_wxyz[0]).dot(
              new Quaternion(
                ...ORACLE.objects[name].frames[String(FRAMES[0])].world_quat_wxyz.slice(1),
                ORACLE.objects[name].frames[String(FRAMES[0])].world_quat_wxyz[0],
              ),
            ),
          ) - 1,
        );
      expect(moved, name).toBeGreaterThan(0.1);
    }
  });
});

describe('#1441 — the keys are the channels Auto-Key makes, in the form Blender’s FBX import gives', () => {
  it.each(KEYED)(
    '%s: Euler rotation, linear, on its own params; no quaternion channel',
    async (name) => {
      const { state } = await imported();
      const target = named(state, name);
      expect((target.params as { rotationMode?: string }).rotationMode).toBeUndefined();
      const channels = Object.values(state.nodes).filter(
        (n) => (n.params as { target?: string }).target === target.id,
      );
      expect(channels.length).toBeGreaterThan(0);
      for (const channel of channels) {
        const p = channel.params as { paramPath: string; keyframes: { easing: string }[] };
        expect(channel.type).toBe('KeyframeChannelVec3');
        expect(channel.id).toBe(objectChannelId(target.id, p.paramPath));
        expect(['position', 'rotation', 'scale']).toContain(p.paramPath);
        expect(new Set(p.keyframes.map((k) => k.easing))).toEqual(new Set(['linear']));
      }
      expect(
        channels.map((c) => (c.params as { paramPath: string }).paramPath).includes('rotation'),
      ).toBe(TURNED.includes(name));
    },
  );

  it('Holder’s 300° turn is keyed continuously: no two neighbouring keys a turn apart', async () => {
    const { state } = await imported();
    const holder = named(state, 'Holder');
    const keys = (
      state.nodes[objectChannelId(holder.id, 'rotation')].params as {
        keyframes: { value: number[] }[];
      }
    ).keyframes;
    let widest = 0;
    for (let i = 1; i < keys.length; i++) {
      for (let a = 0; a < 3; a++) {
        widest = Math.max(widest, Math.abs(keys[i].value[a] - keys[i - 1].value[a]));
      }
    }
    // 300° over 24 steps is 12.5° a step; a canonical Euler would jump ~360° where it crosses 180°.
    expect(widest).toBeLessThan(20);
    // The file's Z turn is a turn about Y in Y-up, and it reaches 300° there.
    expect(keys.at(-1)!.value[1] - keys[0].value[1]).toBeCloseTo(300, 3);
  });

  it('the counts: channels keyed, armature rest tracks, nothing else dropped', async () => {
    const { built } = await imported();
    expect(built.dropped).toEqual({
      nodeTracks: 3, // Held's position and quaternion, Prop's position
      otherPropertyTracks: 0,
      unparsedTracks: 0,
      otherTakes: 0,
    });
    // Holder p/r/s, Cube p/s, Spun r, Tag p/r, Flag p/r.
    expect(built.objectChannels).toBe(10);
  });

  it('the meshes under the armature keep their rest, and their keys are named as not playing', async () => {
    const { notices } = await imported();
    expect(notices).toContain(
      'keys on "Held", "Prop" did not play: a mesh parented to an armature plays no keys of its own, as in Blender\'s FBX import',
    );
  });
});

describe('#1441 — each track that plays nowhere is named, with why', () => {
  // Built by hand: no exporter writes these, and each guard must be seen to fire.
  const fileNode = <T extends Object3D>(node: T, name: string, id: number): T => {
    node.name = name;
    (node as unknown as { ID: number }).ID = id;
    return node;
  };
  const track = (node: string, property: string, values: number[]): FbxNodeTrack => ({
    node,
    property,
    times: [0, 1],
    values,
  });
  const args = (tracks: FbxNodeTrack[], claimed: Object3D[] = [], armatures: Object3D[] = []) => ({
    claimed: new Set([...claimed, ...armatures]),
    armatures: new Set(armatures),
    boneIndexOf: () => -1,
    boneWorlds: [],
    meshOf: new Map<Object3D, number>(),
    metresPerUnit: 1,
    tracks,
  });

  it('a node no reader stands, a name two nodes share, a property that is not a transform', () => {
    const scene = new Group();
    const a = fileNode(new Group(), 'Twin', 1);
    const b = fileNode(new Group(), 'Twin', 2);
    const solo = fileNode(new Group(), 'Solo', 3);
    scene.add(a, b, solo);
    const { leftOut, nodes } = readFbxScene(
      scene,
      args([
        track('Ghost', 'position', [0, 0, 0, 1, 1, 1]),
        track('Twin', 'position', [0, 0, 0, 1, 1, 1]),
        track('Solo', 'morphTargetInfluences', [0, 1]),
        track('Solo', 'position', [0, 0, 0, 0, 0, 2]),
      ]),
    );
    expect(leftOut).toEqual([
      { node: 'Ghost', property: 'position', reason: 'no-node' },
      { node: 'Twin', property: 'position', reason: 'ambiguous' },
      { node: 'Solo', property: 'morphTargetInfluences', reason: 'property' },
    ]);
    // At the top a position is only scaled (here by 1): the turn A⁻¹ sits to its right.
    expect(nodes.find((n) => n.name === 'Solo')!.keys!.position!.values).toEqual([
      [0, 0, 0],
      [0, 0, 2],
    ]);
  });

  it('a key that would shear under a claimed stretch is named, not kept wrong', () => {
    const scene = new Group();
    const plain = fileNode(new Group(), 'Plain', 1);
    const between = fileNode(new Group(), 'Between', 2);
    between.scale.set(1, 3, 1);
    const spun = fileNode(new Group(), 'Spun', 3);
    scene.add(plain);
    plain.add(between);
    between.add(spun);
    const quarter = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const { leftOut, nodes } = readFbxScene(
      scene,
      args([track('Spun', 'quaternion', [0, 0, 0, 1, ...quarter.toArray()])], [between]),
    );
    expect(leftOut).toEqual([{ node: 'Spun', property: 'quaternion', reason: 'shear' }]);
    expect(nodes.find((n) => n.name === 'Spun')!.keys).toBeNull();
  });

  it('the armature node: holding its rest is counted, moving is named', () => {
    const scene = new Group();
    const rig = fileNode(new Group(), 'Rig', 1);
    rig.position.set(1, 2, 3);
    scene.add(rig);
    const still = readFbxScene(
      scene,
      args([track('Rig', 'position', [1, 2, 3, 1, 2, 3])], [], [rig]),
    );
    expect([still.armatureRestTracks, still.leftOut]).toEqual([1, []]);
    const moving = readFbxScene(
      scene,
      args([track('Rig', 'position', [1, 2, 3, 1, 2, 4])], [], [rig]),
    );
    expect([moving.armatureRestTracks, moving.leftOut]).toEqual([
      0,
      [{ node: 'Rig', property: 'position', reason: 'armature-moves' }],
    ]);
  });
});

describe('#1446 — a file with several takes plays the first, and names the rest', () => {
  // The same scene exported with Blender's defaults ("All Actions" on): every action written onto every
  // object it fits, one take each — 5 × 5 = 25 (`q24_fbx_keyed_scene_fixture.py`, no `--one-take`).
  it('the other 24 takes are counted and named, under the issue that decides which one plays', async () => {
    const built = await buildFbxImportOps({
      data: bytes('keyed-scene-every-action.fbx'),
      name: 'every-action',
      storeImage: () => Promise.resolve('img'),
    });
    expect(built.dropped.otherTakes).toBe(24);
    const said = built.notices.find((n) => n.startsWith('24 more takes ('));
    expect(said).toMatch(/\(#1446\)$/);
    expect(said).toContain('"Spun|SpunAction"');
  });
});
