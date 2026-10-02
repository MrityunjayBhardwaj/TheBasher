// #1434 step 0 — the fixtures and oracles for an FBX without a skin.
//
// Both fixtures are made in Blender 5.1.1 and exported with its FBX exporter's defaults:
// `rigless-hierarchy-blender-default.fbx` (probe q20 — an Empty `Holder` over a keyed `Cube` over a
// `Cone`, and a loose `Plane` with `PlaneMat`; no bone anywhere) and
// `unskinned-edges-blender-default.fbx` (probe q22 — two Objects sharing one mesh, a Camera, a ZXY
// Empty keyed at two frames, and a Cube parented to a bone of an otherwise unused Armature). Each
// oracle is Blender's FBX import of its file (probe q21); each `.glb` is Blender's glTF export of
// the same scene.
//
// The glTF export cross-checks position, orientation and scale ONLY: Blender's FBX import lands
// every Object in XYZ Euler (it never sets `rotation_mode`, `import_fbx.py:2750`, `:702`), its glTF
// import in QUATERNION, so the two agree on where a thing is and never on how its rotation reads.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { FBX_NOTHING_TO_IMPORT, parseFbx, readFbx } from './fbx';

const DIR = resolve(process.cwd(), 'src/core/import/__fixtures__');

function arrayBufferOf(file: string): ArrayBuffer {
  const buf = readFileSync(`${DIR}/${file}`);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

interface OracleFrame {
  world_translation: [number, number, number];
  world_quat_wxyz: [number, number, number, number];
  world_scale: [number, number, number];
}
interface Oracle {
  objects: Record<string, { type: string; frames: Record<string, OracleFrame> }>;
}

interface GltfNode {
  name?: string;
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  children?: number[];
}

/** Every named node's world matrix in a `.glb`, composed from its JSON chunk. */
function glbWorlds(file: string): Map<string, Matrix4> {
  const buf = readFileSync(`${DIR}/${file}`);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8')) as {
    nodes: GltfNode[];
  };
  const parentOf = new Map<number, number>();
  json.nodes.forEach((node, i) => node.children?.forEach((c) => parentOf.set(c, i)));
  const local = (node: GltfNode) =>
    new Matrix4().compose(
      new Vector3(...((node.translation ?? [0, 0, 0]) as [number, number, number])),
      new Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
      new Vector3(...((node.scale ?? [1, 1, 1]) as [number, number, number])),
    );
  const worlds = new Map<string, Matrix4>();
  json.nodes.forEach((node, i) => {
    const world = local(node);
    for (let p = parentOf.get(i); p !== undefined; p = parentOf.get(p))
      world.premultiply(local(json.nodes[p]));
    if (node.name) worlds.set(node.name, world);
  });
  return worlds;
}

/** Blender's Z-up world, re-expressed in glTF's Y-up: (x, y, z) → (x, z, −y). */
function yUp(frame: OracleFrame): { t: Vector3; q: Quaternion; s: Vector3 } {
  const [x, y, z] = frame.world_translation;
  const [qw, qx, qy, qz] = frame.world_quat_wxyz;
  const [sx, sy, sz] = frame.world_scale;
  return {
    t: new Vector3(x, z, -y),
    q: new Quaternion(qx, qz, -qy, qw),
    s: new Vector3(sx, sz, sy),
  };
}

describe.each([
  ['rigless-hierarchy-blender-default.glb', 'blender-oracle-fbx-rigless-hierarchy.json'],
  ['unskinned-edges-blender-default.glb', 'blender-oracle-fbx-unskinned-edges.json'],
  ['rigged-scene-blender-default.glb', 'blender-oracle-fbx-rigged-scene.json'],
])('the two Blender oracles agree on where each Object is (%s)', (glb, oracleFile) => {
  const oracle = JSON.parse(readFileSync(`${DIR}/${oracleFile}`, 'utf8')) as Oracle;
  const worlds = glbWorlds(glb);
  // Blender's glTF exporter leaves cameras out by default, so a camera has no glTF side to check.
  const checked = Object.entries(oracle.objects).filter(([, o]) => o.type !== 'CAMERA');

  it('every non-camera Object in the FBX oracle has a node in the glTF export', () => {
    expect(checked.length).toBeGreaterThan(0);
    for (const [name] of checked) expect(worlds.has(name), name).toBe(true);
  });

  it.each(checked.map(([name]) => name))(
    '%s: world position, orientation and scale at frame 1',
    (name) => {
      const want = yUp(oracle.objects[name].frames['1']);
      const t = new Vector3();
      const q = new Quaternion();
      const s = new Vector3();
      worlds.get(name)!.decompose(t, q, s);
      expect(t.distanceTo(want.t)).toBeLessThan(1e-4);
      // q and −q are one orientation.
      expect(Math.abs(Math.abs(q.dot(want.q)) - 1)).toBeLessThan(1e-4);
      expect(s.distanceTo(want.s)).toBeLessThan(1e-4);
    },
  );
});

describe('a file without a bone', () => {
  // #1434 step 4 — this used to pin the refusal of the rigless fixture; the file is now read as a
  // model (what lands is `fbxModelLanding.test.ts`). A file with nothing at all is still refused.
  it('is read as a model: its meshes and empties, and no rig', () => {
    const read = readFbx(arrayBufferOf('rigless-hierarchy-blender-default.fbx'), 'rigless');
    expect(read.kind).toBe('model');
    expect(read.scene.nodes.map((n) => n.name).sort()).toEqual(['Cone', 'Cube', 'Holder', 'Plane']);
  });

  it('a file with no bone, mesh or empty is refused whole, by the reason the reader gives', () => {
    expect(() => readFbx(arrayBufferOf('nothing-blender-default.fbx'), 'nothing')).toThrow(
      FBX_NOTHING_TO_IMPORT,
    );
  });

  it('the rig reader refuses a model by name, not with a skeleton of no bones', () => {
    expect(() =>
      parseFbx(arrayBufferOf('rigless-hierarchy-blender-default.fbx'), 'rigless'),
    ).toThrow('FBX holds no bone: it is a model, not a rig.');
  });
});
