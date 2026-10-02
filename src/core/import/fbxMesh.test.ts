// #1429 — an FBX's meshes arrive as Blender's FBX importer makes them. The oracle is Blender 5.1.1
// re-importing its own default export (`ref/probes/blender-armature-deform/q15_fbx_mesh_fixture.py`
// makes the file, `q16_fbx_mesh_oracle.py` records the import), every vertex at frames 1, 13, 25.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { Color, Matrix4, Vector3, type Material, type Mesh } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
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
import { imageHasAlpha, readFbxMeshes } from './fbxMesh';
import { sniffImage } from './modelImport';
import { openpbrToThree } from '../../app/material/openpbrToThree';
import { resolveWorldTransform } from '../../app/resolveWorldTransform';

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

/** Every image an import stored, in order: the bytes and type, keyed `img<n>`. */
let stored: { bytes: Uint8Array; mime: string }[] = [];
const storeImage = (bytes: Uint8Array, mime: string): Promise<string> => {
  stored.push({ bytes, mime });
  return Promise.resolve(`img${stored.length - 1}`);
};

/** The file imported through the assembly every FBX door uses, into a default project. */
async function imported(
  path: string,
  name: string,
): Promise<{ state: DagState; notices: readonly string[] }> {
  stored = [];
  let state = buildDefaultDagState();
  const built = motionImportOps(
    await buildFbxImportOps({
      data: bytes(path),
      name,
      ids: { skeleton: `${name}_skel`, layer: `${name}_motion` },
      storeImage,
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
  it('the panel: its quad, pentagon and triangle, its points, its groups and its stack', async () => {
    const want = ORACLE.meshes.Panel;
    const { state, notices } = await imported(PANEL, 'panel');
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

  it('every influence: the point Blender binds to five bones is bound to five here', async () => {
    const want = ORACLE.meshes.Panel;
    const { state } = await imported(PANEL, 'panel');
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
  ] as const)(
    'at Blender frame %s every point is where Blender puts it',
    async (frame, seconds) => {
      const { state } = await imported(PANEL, 'panel');
      const object = objectNamed(state, 'Panel');
      const modifier = (object.inputs.data as { node: string }).node;
      const value = evaluate(state, modifier, CTX).value as ModifiedDataValue;
      const descriptor = value.geometry.descriptor;
      if (!value.skin || descriptor.kind !== 'mesh') throw new Error('no skin');
      const moved = sampleSkinDeform(value.skin, descriptor.data, seconds);
      ORACLE.meshes.Panel.frames[frame].forEach((v, p) =>
        v.forEach((c, k) => expect(moved[p * 3 + k], `point ${p} axis ${k}`).toBeCloseTo(c, 4)),
      );
    },
  );

  it('two slots, each face drawn by the one Blender gives it, coloured as Blender reads them', async () => {
    const want = ORACLE.meshes.Panel;
    const { state } = await imported(PANEL, 'panel');
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
      // #1435 — no image, so no image alpha: drawn as every untextured slot is.
      expect(slot.geometry.renderMethod).toBeUndefined();
    });
  });
});

describe('#1429 — an unskinned FBX mesh stands as an Object of its own', () => {
  it('the cube: six quads, and its points where Blender puts them', async () => {
    const want = ORACLE.meshes.Prop;
    const { state } = await imported(PANEL, 'panel');
    const object = objectNamed(state, 'Prop');
    const { mesh } = storedMesh(state, object.id);
    expect(Array.from(mesh.faceSizes)).toEqual(want.faceSizes);
    expect(mesh.points.length / 3).toBe(want.verts);
    // Through the product's own world read: the Object's fields and the points it holds are
    // Blender's split (#1434), and only their product is where Blender draws it.
    const world = new Matrix4().fromArray(
      resolveWorldTransform(state, object.id, {
        time: { frame: 0, seconds: 0, normalized: 0 },
      } as never)!.matrix,
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

  it('null-in-chain: the body Blender places at (0,0,0) (1,0,0) (0,2,0), in groups Hips and Tip', async () => {
    // Blender 5.1.1, `q16_fbx_mesh_oracle.py` at frame 1: those three vertices, groups Hips and Tip
    // — the chain's middle node is a Null (a fake bone, #1190) that no weight names.
    const { state } = await imported('public/fixtures/anim/null-in-chain.fbx', 'chain');
    const { mesh } = storedMesh(state, objectNamed(state, 'Body').id);
    expect(Array.from(mesh.points)).toEqual(
      [0, 0, 0, 1, 0, 0, 0, 2, 0].map((c) => expect.closeTo(c, 5)),
    );
    expect(mesh.vertexGroups).toEqual(['Hips', 'Tip']);
  });

  it('a file with no mesh imports exactly as before: a skeleton and its motion, nothing else', async () => {
    const { state, notices } = await imported(WALK, 'walk');
    expect(Object.values(state.nodes).filter((n) => n.type === 'PolyMeshData')).toEqual([]);
    expect(notices).toEqual([]);
  });
});

// #1434 — the images an FBX slot samples. The oracle is Blender 5.1.1 importing its own export of
// a material with an RGBA base colour image and a normal map, embedded
// (`ref/probes/blender-armature-deform/q17_fbx_texture_fixture.py` makes the file,
// `q18_fbx_texture_oracle.py` records which input each image feeds, its colour space and pixels).
const TILE = `${DIR}/tile-textured-blender-embedded.fbx`;
interface OracleInput {
  colorspace: string;
  size: [number, number];
  pixels: number[];
  extension: string;
  depth: number;
  image: string;
}
const TILE_ORACLE = JSON.parse(
  readFileSync(`${DIR}/blender-oracle-fbx-tile-textured.json`, 'utf8'),
) as {
  materials: Record<string, { inputs: Record<string, OracleInput>; surface_render_method: string }>;
};

/** An 8-bit RGB or RGBA PNG's texels, bottom row first as Blender lists them, in 0..1. */
function pngTexels(png: Uint8Array): { size: [number, number]; pixels: number[] } {
  const view = Buffer.from(png);
  const [width, height] = [view.readUInt32BE(16), view.readUInt32BE(20)];
  const [depth, type] = [view[24], view[25]];
  expect([depth, [2, 6].includes(type)], 'an 8-bit RGB or RGBA PNG').toEqual([8, true]);
  const channels = type === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let i = 8; i < view.length; ) {
    const len = view.readUInt32BE(i);
    if (view.subarray(i + 4, i + 8).toString('latin1') === 'IDAT') {
      chunks.push(view.subarray(i + 8, i + 8 + len));
    }
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const up = rows[y - 1] ?? new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const c = x >= channels ? up[x - channels] : 0;
      const p = a + up[x] - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - up[x]) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - up[x]) <= Math.abs(p - c)
            ? up[x]
            : c;
      const add = [0, a, up[x], (a + up[x]) >> 1, paeth][filter];
      row[x] = (row[x] + add) & 0xff;
    }
    rows.push(row);
  }
  const pixels: number[] = [];
  for (const row of rows.reverse()) {
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 4; k++) pixels.push(k < channels ? row[x * channels + k] / 255 : 1);
    }
  }
  return { size: [width, height], pixels };
}

describe('#1434 — an FBX slot’s images come across as the project’s own files', () => {
  const blender = TILE_ORACLE.materials['Tile/Textured'].inputs;

  it('the base colour and the normal map sample the file’s own images, as Blender’s do', async () => {
    const { state, notices } = await imported(TILE, 'tile');
    const { dataNode } = storedMesh(state, objectNamed(state, 'Tile').id);
    const material = (state.nodes[dataNode].params as { material: InlineMaterialSpec }).material;
    const albedo = material.maps.albedo!;
    const normal = material.maps.normal!;
    expect([albedo.store, normal.store]).toEqual(['project', 'project']);
    expect(stored.map((s) => s.mime)).toEqual(['image/png', 'image/png']);
    // Each map names the image Blender links to the same input, pixel for pixel.
    const byKey = (key: string) => pngTexels(stored[Number(key.slice('img'.length))].bytes);
    for (const [ref, input] of [
      [albedo, blender['Base Color']],
      [normal, blender.Normal],
    ] as const) {
      const got = byKey(ref.hash);
      expect(got.size).toEqual(input.size);
      got.pixels.forEach((v, i) => expect(v, `texel channel ${i}`).toBeCloseTo(input.pixels[i], 2));
    }
    // Colour image sRGB, normal map data, both repeating — Blender's colour spaces and extension.
    expect([blender['Base Color'].colorspace, blender.Normal.colorspace]).toEqual([
      'sRGB',
      'Non-Color',
    ]);
    expect([albedo.colorSpace, normal.colorSpace]).toEqual(['srgb', 'srgb-linear']);
    expect([blender['Base Color'].extension, blender.Normal.extension]).toEqual([
      'REPEAT',
      'REPEAT',
    ]);
    expect([albedo.wrapS, albedo.wrapT, normal.wrapS, normal.wrapT]).toEqual([
      'repeat',
      'repeat',
      'repeat',
      'repeat',
    ]);
    // #1435 — and nothing is left out: the transparency link names the base colour image, whose
    // alpha the surface draws.
    expect(notices).toEqual([]);
  });

  it('#1435 — the base colour image’s alpha is the surface’s, drawn dithered as Blender draws it', async () => {
    const { state } = await imported(TILE, 'tile');
    const { dataNode } = storedMesh(state, objectNamed(state, 'Tile').id);
    const material = (state.nodes[dataNode].params as { material: InlineMaterialSpec }).material;
    const oracle = TILE_ORACLE.materials['Tile/Textured'];
    // Blender feeds Alpha from the base colour image (its own copy of the same file, the same
    // texels) and sets the dithered render method.
    expect(oracle.inputs.Alpha.image.startsWith(oracle.inputs['Base Color'].image)).toBe(true);
    expect(oracle.inputs.Alpha.pixels).toEqual(oracle.inputs['Base Color'].pixels);
    expect(oracle.surface_render_method).toBe('DITHERED');
    expect(material.geometry.renderMethod).toBe('dithered');
    // The map that carries it is the base colour map, whose texels hold the half-transparent one.
    const base = pngTexels(stored[Number(material.maps.albedo!.hash.slice('img'.length))].bytes);
    expect(base.pixels[15]).toBeCloseTo(0.502, 2);
    // Drawn as three draws a hashed cutout, not blended.
    const drawn = openpbrToThree(material);
    expect([drawn.alphaHash, drawn.transparent]).toEqual([true, false]);
  });

  it('#1435 — every PNG colour type and WebP encoding has alpha exactly when Blender says so', () => {
    // Blender's own answer for each image (`q19_image_alpha_depth.py`): depth 32 is alpha.
    const oracle = JSON.parse(
      readFileSync(`${DIR}/blender-oracle-image-alpha-depth.json`, 'utf8'),
    ) as { images: { name: string; depth: number; base64: string }[] };
    expect(oracle.images).toHaveLength(12);
    const rows = oracle.images.map(({ name, base64 }) => {
      const data = new Uint8Array(Buffer.from(base64, 'base64'));
      return [name, imageHasAlpha(data, sniffImage(data)!)];
    });
    expect(rows).toEqual(oracle.images.map(({ name, depth }) => [name, depth === 32]));
    // Both answers occur, so the rule is not passing by answering one way.
    expect(new Set(rows.map(([, alpha]) => alpha))).toEqual(new Set([true, false]));
  });

  it('#1435 — an image has alpha exactly when Blender loads it at depth 32', () => {
    const { images } = parseFbx(bytes(TILE), 'tile').meshes;
    const inputs = TILE_ORACLE.materials['Tile/Textured'].inputs;
    const depthOf = (file: string) =>
      [inputs['Base Color'], inputs.Normal].find((i) => file.endsWith(i.image))!.depth;
    expect(images.map((i) => [i.hasAlpha, depthOf(i.file) === 32])).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  it('a textured base colour draws the image alone: Blender leaves the socket’s colour unread', async () => {
    const { state } = await imported(TILE, 'tile');
    const { dataNode } = storedMesh(state, objectNamed(state, 'Tile').id);
    const material = (state.nodes[dataNode].params as { material: InlineMaterialSpec }).material;
    expect(material.base.color).toBe('#ffffff');
  });

  it('an untextured file stores no image', async () => {
    await imported(PANEL, 'panel');
    expect(stored).toEqual([]);
  });
});

describe('#1435 — the image that gives the surface its alpha, in Blender’s order', () => {
  // The tile links one RGBA image to DiffuseColor and to TransparencyFactor, and an RGB normal map.
  const BASE = 'tile-textured.fbm/tex_base.png';
  /** The tile's loader record, its links changed by `edit`, read again. */
  function readLinks(edit: (links: Record<string, unknown>[]) => void) {
    const group = new FBXLoader().parse(bytes(TILE), '');
    group.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh) edit((mesh.material as Material).userData.fbxTextures);
    });
    const read = readFbxMeshes(group, () => 0, 1);
    return { images: read.images, notices: read.notices.join('\n') };
  }
  const link = (links: Record<string, unknown>[], name: string) =>
    links.find((t) => t.link === name)!;
  /** The base colour becomes an RGB image of its own: the normal map's bytes, under a new name. */
  const rgbBase = (links: Record<string, unknown>[]) => {
    Object.assign(link(links, 'DiffuseColor'), {
      file: 'rgb.png',
      content: link(links, 'NormalMap').content,
    });
  };

  it('the file as made: the base colour image has alpha, so nothing is left out', () => {
    const { images, notices } = readLinks(() => {});
    expect(images.map((i) => [i.file, i.hasAlpha])).toEqual([
      [BASE, true],
      ['tile-textured.fbm/tex_normal.png', false],
    ]);
    expect(notices).toBe('');
  });

  it('a base colour image with alpha overrides a transparency link to another image', () => {
    const { notices } = readLinks((links) => {
      Object.assign(link(links, 'TransparencyFactor'), {
        file: 'other.png',
        content: link(links, 'DiffuseColor').content,
      });
    });
    expect(notices).toBe('');
  });

  it('a base colour without alpha and a transparency image WITH alpha: named, not stored', () => {
    const { images, notices } = readLinks(rgbBase);
    expect(images.map((i) => [i.file, i.hasAlpha])).toEqual([
      ['rgb.png', false],
      ['tile-textured.fbm/tex_normal.png', false],
    ]);
    expect(notices).toContain(
      `TransparencyFactor: "${BASE}" gives the surface its alpha, and only the base colour image's alpha is drawn yet (#1439)`,
    );
  });

  it('a transparency link to an image without alpha draws nothing, as Blender’s Alpha of 1', () => {
    // To the base colour image itself, and to another RGB image: both opaque in Blender too.
    for (const target of ['rgb.png', 'tile-textured.fbm/tex_normal.png']) {
      const { notices } = readLinks((links) => {
        rgbBase(links);
        const source =
          target === 'rgb.png' ? link(links, 'DiffuseColor') : link(links, 'NormalMap');
        Object.assign(link(links, 'TransparencyFactor'), {
          file: target,
          content: source.content,
        });
      });
      expect(notices, target).toBe('');
    }
  });

  it('a transparency image that cannot be read is named', () => {
    const { notices } = readLinks((links) => {
      rgbBase(links);
      link(links, 'TransparencyFactor').content = null;
    });
    expect(notices).toContain(`TransparencyFactor: "${BASE}" is not embedded in the file`);
  });
});

describe('#1434 — a map that cannot be drawn as Blender draws it is left out by name', () => {
  /** The tile's loader record, its base colour texture changed by `edit`, read again. */
  function readEdited(edit: (texture: Record<string, unknown>) => void) {
    const group = new FBXLoader().parse(bytes(TILE), '');
    group.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      const textures = (mesh.material as Material).userData.fbxTextures as Record<
        string,
        unknown
      >[];
      edit(textures.find((t) => t.link === 'DiffuseColor')!);
    });
    const read = readFbxMeshes(group, () => 0, 1);
    return { slot: read.meshes[0].materials[0], images: read.images, notices: read.notices };
  }

  it('a second image on the base colour is named; the first is kept', () => {
    const group = new FBXLoader().parse(bytes(TILE), '');
    group.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      const textures = (mesh.material as Material).userData.fbxTextures as Record<
        string,
        unknown
      >[];
      const diffuse = textures.find((t) => t.link === 'DiffuseColor')!;
      textures.push({ ...diffuse, file: 'other.png' });
    });
    const read = readFbxMeshes(group, () => 0, 1);
    expect(read.meshes[0].materials[0].baseColorImage?.image).toBe(0);
    expect(read.notices.join('\n')).toContain(
      'DiffuseColor: "other.png" is a second image for the same input',
    );
  });

  it('a mesh that is left out leaves no image behind', () => {
    // No bone of the rig stands for the skin's: the skinned tile is refused.
    const read = readFbxMeshes(new FBXLoader().parse(bytes(TILE), ''), () => -1, 1);
    expect(read.meshes).toEqual([]);
    expect(read.notices.join('\n')).toContain('was left out');
    expect(read.images).toEqual([]);
  });

  it.each([
    [
      'not embedded',
      (t: Record<string, unknown>) => (t.content = null),
      'is not embedded in the file',
    ],
    [
      'scaled on the surface',
      (t: Record<string, unknown>) => (t.scaling = [2, 2, 1]),
      'is moved, turned or scaled on the surface',
    ],
    [
      'not an image a browser decodes',
      (t: Record<string, unknown>) => (t.content = new Uint8Array([0x42, 0x4d, 0, 0]).buffer),
      'is not PNG, JPEG or WebP',
    ],
  ])('%s: the base colour keeps its colour, and the notice says why', (_, edit, why) => {
    const { slot, images, notices } = readEdited(edit);
    expect(slot.baseColorImage).toBeUndefined();
    expect(slot.normalImage).toBeDefined();
    expect(images).toHaveLength(1);
    expect(notices.join('\n')).toContain(`DiffuseColor: "tile-textured.fbm/tex_base.png" ${why}`);
  });

  it('the unedited record keeps both images: the rows above can only fail on their edit', () => {
    const { slot, images } = readEdited(() => {});
    expect([slot.baseColorImage?.image, slot.normalImage?.image]).toEqual([0, 1]);
    expect(images).toHaveLength(2);
  });
});
