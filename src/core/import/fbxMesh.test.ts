// #1429 — an FBX's meshes arrive as Blender's FBX importer makes them. The oracle is Blender 5.1.1
// re-importing its own default export (`ref/probes/blender-armature-deform/q15_fbx_mesh_fixture.py`
// makes the file, `q16_fbx_mesh_oracle.py` records the import), every vertex at frames 1, 13, 25.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Color, Matrix4, Quaternion, Vector3 } from 'three';
import { __resetRegistryForTests } from '../dag/registry';
import { applyOp, evaluate } from '../dag';
import type { DagState } from '../dag/state';
import { buildDefaultDagState } from '../project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import { skinLanes, skinSetCount } from '../../nodes/skinInfluences';
import { MATERIAL_INDEX } from '../../nodes/attributes';
import type { InlineMaterialSpec, MeshGeometryData, ModifiedDataValue } from '../../nodes/types';
import { unpackMeshData, type PackedMeshData } from '../../app/meshGeometryData';
import { motionImportOps } from '../../app/asset/importBvhFbx';
import { buildFbxImportOps } from './fbxImportChain';
import { parseFbx } from './fbx';

const DIR = 'src/core/import/__fixtures__';
const PANEL = `${DIR}/panel-five-influences-blender-default.fbx`;
const BAR = `${DIR}/skinned-bar-keyed-scale-blender-default.fbx`;
const WALK = `${DIR}/walk-blender-default.fbx`;

interface OracleMesh {
  parent: string | null;
  modifiers: [string, string | null][];
  verts: number;
  loops: number;
  faceSizes: number[];
  materialIndex: number[];
  groups: string[];
  materials: ({ name: string; base: number[]; roughness: number; metallic: number } | null)[];
  influences: number[];
  frames: Record<string, number[][]>;
}
const ORACLE = JSON.parse(readFileSync(`${DIR}/blender-oracle-fbx-panel-mesh.json`, 'utf8')) as {
  fps: number;
  meshes: Record<string, OracleMesh>;
};

const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** The file imported through the assembly every FBX door uses, into a default project. */
function imported(path: string, name: string): { state: DagState; notices: readonly string[] } {
  let state = buildDefaultDagState();
  const built = motionImportOps(
    buildFbxImportOps({
      data: bytes(path),
      name,
      ids: { skeleton: `${name}_skel`, layer: `${name}_motion` },
    }),
    name,
    state,
  );
  for (const op of built.ops) state = applyOp(state, op).next;
  return { state, notices: built.notices };
}

const CTX = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } };

function objectNamed(state: DagState, name: string) {
  const node = Object.values(state.nodes).find(
    (n) => n.type === 'Object' && (n.meta as { name?: string } | undefined)?.name === name,
  );
  if (!node) throw new Error(`no Object named ${name}`);
  return node;
}

function storedMesh(
  state: DagState,
  objectId: string,
): { mesh: MeshGeometryData; dataNode: string } {
  let id = (state.nodes[objectId].inputs.data as { node: string }).node;
  while (state.nodes[id].type !== 'PolyMeshData') {
    id = (state.nodes[id].inputs.target as { node: string }).node;
  }
  const packed = (state.nodes[id].params as { mesh: PackedMeshData }).mesh;
  return { mesh: unpackMeshData(packed), dataNode: id };
}

describe('#1429 — a skinned FBX mesh arrives as Blender imports it', () => {
  it('the panel: its quad, pentagon and triangle, its points, its groups and its stack', () => {
    const want = ORACLE.meshes.Panel;
    const { state, notices } = imported(PANEL, 'panel');
    const object = objectNamed(state, 'Panel');
    const { mesh } = storedMesh(state, object.id);
    expect(Array.from(mesh.faceSizes)).toEqual(want.faceSizes);
    expect(mesh.points.length / 3).toBe(want.verts);
    expect(mesh.cornerPoints.length).toBe(want.loops);
    expect(mesh.vertexGroups).toEqual(want.groups);
    // Hung under the armature's Object, deformed by a modifier pointed at it.
    const modifier = (object.inputs.data as { node: string }).node;
    expect(state.nodes[modifier].type).toBe('ArmatureModifier');
    const armature = (state.nodes[modifier].inputs.armature as { node: string }).node;
    expect((state.nodes[armature].meta as { name?: string }).name).toBe('panel');
    // Beside it in the scene at identity (a child edge would close a cycle through the stack).
    expect(object.params).toMatchObject({ position: [0, 0, 0], scale: [1, 1, 1] });
    expect(notices).toEqual([]);
  });

  it('every influence: the point Blender binds to five bones is bound to five here', () => {
    const want = ORACLE.meshes.Panel;
    const { state } = imported(PANEL, 'panel');
    const { mesh } = storedMesh(state, objectNamed(state, 'Panel').id);
    expect(skinSetCount(mesh)).toBe(2);
    const { weights, width } = skinLanes(mesh)!;
    const influences = Array.from(
      { length: want.verts },
      (_, p) =>
        Array.from({ length: width }, (_, lane) => weights[p * width + lane]).filter((w) => w > 0)
          .length,
    );
    expect(influences).toEqual(want.influences);
  });

  it.each([
    ['1', 0],
    ['13', 0.5],
    ['25', 1],
  ] as const)('at Blender frame %s every point is where Blender puts it', (frame, seconds) => {
    const { state } = imported(PANEL, 'panel');
    const object = objectNamed(state, 'Panel');
    const modifier = (object.inputs.data as { node: string }).node;
    const value = evaluate(state, modifier, CTX).value as ModifiedDataValue;
    const descriptor = value.geometry.descriptor;
    if (!value.skin || descriptor.kind !== 'mesh') throw new Error('no skin');
    const moved = sampleSkinDeform(value.skin, descriptor.data, seconds);
    ORACLE.meshes.Panel.frames[frame].forEach((v, p) =>
      v.forEach((c, k) => expect(moved[p * 3 + k], `point ${p} axis ${k}`).toBeCloseTo(c, 4)),
    );
  });

  it('two slots, each face drawn by the one Blender gives it, coloured as Blender reads them', () => {
    const want = ORACLE.meshes.Panel;
    const { state } = imported(PANEL, 'panel');
    const { mesh, dataNode } = storedMesh(state, objectNamed(state, 'Panel').id);
    const index = mesh.faceLayers.find((l) => l.name === MATERIAL_INDEX)!;
    expect(Array.from(index.data)).toEqual(want.materialIndex);
    const params = state.nodes[dataNode].params as { materialSlots?: InlineMaterialSpec[] };
    expect(params.materialSlots).toHaveLength(2);
    params.materialSlots!.forEach((slot, i) => {
      const blender = want.materials[i]!;
      expect(slot.name).toBe(blender.name);
      // The stored colour is sRGB hex; Blender's base colour is linear.
      const linear = new Color(slot.base.color).toArray();
      blender.base.forEach((c, k) => expect(linear[k], `slot ${i} channel ${k}`).toBeCloseTo(c, 2));
      expect(slot.specular.roughness).toBeCloseTo(blender.roughness, 4);
      expect(slot.base.metalness).toBe(blender.metallic);
    });
  });
});

describe('#1429 — an unskinned FBX mesh stands as an Object of its own', () => {
  it('the cube: six quads, and its points where Blender puts them', () => {
    const want = ORACLE.meshes.Prop;
    const { state } = imported(PANEL, 'panel');
    const object = objectNamed(state, 'Prop');
    const { mesh } = storedMesh(state, object.id);
    expect(Array.from(mesh.faceSizes)).toEqual(want.faceSizes);
    expect(mesh.points.length / 3).toBe(want.verts);
    const p = object.params as {
      position: number[];
      scale: number[];
      quaternion: [number, number, number, number];
    };
    const world = new Matrix4().compose(
      new Vector3(...p.position),
      new Quaternion(...p.quaternion),
      new Vector3(...p.scale),
    );
    const v = new Vector3();
    want.frames['1'].forEach((w, i) => {
      v.fromArray(mesh.points, i * 3).applyMatrix4(world);
      w.forEach((c, k) => expect(v.getComponent(k), `point ${i} axis ${k}`).toBeCloseTo(c, 4));
    });
  });
});

describe('#1429 — the files that were already imported', () => {
  it('skinned-bar: Blender’s two meshes, the bar skinned and the icosphere standing alone', () => {
    const { meshes } = parseFbx(bytes(BAR), 'bar').meshes;
    expect(
      meshes.map((m) => [m.name, m.data.points.length / 3, m.data.cornerPoints.length]),
    ).toEqual(
      expect.arrayContaining([
        ['Icosphere', 42, 240],
        ['Mesh_0', 6, 12],
      ]),
    );
  });

  it('null-in-chain: the body Blender places at (0,0,0) (1,0,0) (0,2,0), in groups Hips and Tip', () => {
    // Blender 5.1.1, `q16_fbx_mesh_oracle.py` at frame 1: those three vertices, groups Hips and Tip
    // — the chain's middle node is a Null (a fake bone, #1190) that no weight names.
    const { state } = imported('public/fixtures/anim/null-in-chain.fbx', 'chain');
    const { mesh } = storedMesh(state, objectNamed(state, 'Body').id);
    expect(Array.from(mesh.points)).toEqual(
      [0, 0, 0, 1, 0, 0, 0, 2, 0].map((c) => expect.closeTo(c, 5)),
    );
    expect(mesh.vertexGroups).toEqual(['Hips', 'Tip']);
  });

  it('a file with no mesh imports exactly as before: a skeleton and its motion, nothing else', () => {
    const { state, notices } = imported(WALK, 'walk');
    expect(Object.values(state.nodes).filter((n) => n.type === 'PolyMeshData')).toEqual([]);
    expect(notices).toEqual([]);
  });
});
