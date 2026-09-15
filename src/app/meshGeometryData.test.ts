// #1049 — a stored polygon mesh answers the model's questions the way a box does, from its own
// data, with nothing loaded or mounted. #1117 — its UV sets and colours are named corner layers.
import { describe, expect, it } from 'vitest';
import type { GeometryDescriptor, MeshCornerLayer, MeshGeometryData } from '../nodes/types';
import {
  buildMeshGeometry,
  cornerLayerBufferNames,
  isPackedMeshData,
  meshGeometryRef,
  packMeshData,
  unpackMeshData,
} from './meshGeometryData';
import { cornerCountOf, faceArityOf, faceCountOf } from './faceCount';
import { meshDataProblem, meshSplitLayout, polygonLayoutOf } from './polygonLayout';
import { pointCountOf, weldByPosition } from './pointIdentity';
import { edgeCountOf, weldedPolygonsOf } from './edgeIdentity';
import { availabilityOf, readGeometry } from './geometryRegistry';
import { composedWeldOf } from './builtRims';

const h = 0.5;
// Eight corners of a unit cube, and six outward-wound quads over them.
const CUBE_POINTS = [
  [-h, -h, -h],
  [h, -h, -h],
  [h, h, -h],
  [-h, h, -h],
  [-h, -h, h],
  [h, -h, h],
  [h, h, h],
  [-h, h, h],
];
const CUBE_FACES: ReadonlyArray<readonly [number[], [number, number, number]]> = [
  [
    [0, 3, 2, 1],
    [0, 0, -1],
  ],
  [
    [4, 5, 6, 7],
    [0, 0, 1],
  ],
  [
    [0, 1, 5, 4],
    [0, -1, 0],
  ],
  [
    [3, 7, 6, 2],
    [0, 1, 0],
  ],
  [
    [0, 4, 7, 3],
    [-1, 0, 0],
  ],
  [
    [1, 2, 6, 5],
    [1, 0, 0],
  ],
];
const QUAD_UV = [0, 0, 1, 0, 1, 1, 0, 1];

const uvMap = (): MeshCornerLayer => ({
  name: 'UVMap',
  type: 'float2',
  data: Float32Array.from(CUBE_FACES.flatMap(() => QUAD_UV)),
});

function cube(withNormals = true): MeshGeometryData {
  return {
    points: Float32Array.from(CUBE_POINTS.flat()),
    faceSizes: Uint32Array.from(CUBE_FACES.map(() => 4)),
    cornerPoints: Uint32Array.from(CUBE_FACES.flatMap(([rim]) => rim)),
    cornerLayers: [uvMap()],
    cornerNormals: withNormals
      ? Float32Array.from(CUBE_FACES.flatMap(([, n]) => [...n, ...n, ...n, ...n]))
      : null,
  };
}

/** A per-face colour: every corner of face `f` carries the same RGBA, distinct per face. */
const colour = (): MeshCornerLayer => ({
  name: 'Color',
  type: 'float4',
  data: Float32Array.from(
    CUBE_FACES.flatMap((_, f) => {
      const c = [f / 5, 1 - f / 5, 0.5, 1];
      return [...c, ...c, ...c, ...c];
    }),
  ),
});

/** The cube with the two layers glTF brings beyond TEXCOORD_0: a second UV set and a colour. */
function layered(): MeshGeometryData {
  const base = cube();
  return {
    ...base,
    cornerLayers: [
      ...base.cornerLayers,
      {
        name: 'UVMap.001',
        type: 'float2',
        data: Float32Array.from(CUBE_FACES.flatMap((_, f) => [f, 0, f, 1, f, 2, f, 3])),
      },
      colour(),
    ],
  };
}

describe('meshDataProblem', () => {
  it('accepts a well-formed cube, and one carrying a second UV set and a colour', () => {
    expect(meshDataProblem(cube())).toBeNull();
    expect(meshDataProblem(layered())).toBeNull();
  });

  it('refuses a face with fewer than three corners, by face', () => {
    const d = { ...cube(), faceSizes: Uint32Array.from([4, 4, 4, 4, 4, 2]) };
    expect(meshDataProblem(d)).toMatch(/face 5 has 2 corners/);
  });

  it('refuses corner arrays that disagree with the face sizes', () => {
    const d = { ...cube(), faceSizes: Uint32Array.from([4, 4, 4, 4, 4, 5]) };
    expect(meshDataProblem(d)).toMatch(/25 corners but 24/);
  });

  it('refuses a corner that cites a point the mesh does not have', () => {
    const cornerPoints = cube().cornerPoints.slice();
    cornerPoints[3] = 8;
    expect(meshDataProblem({ ...cube(), cornerPoints })).toMatch(/cites point 8 of 8/);
  });

  it('refuses a layer of the wrong length, by name', () => {
    const d = { ...cube(), cornerLayers: [{ ...uvMap(), data: new Float32Array(46) }] };
    expect(meshDataProblem(d)).toMatch(/corner layer 'UVMap' holds 46 numbers for 24 corners/);
  });

  it('refuses a layer type a stored mesh does not hold, by name', () => {
    const normals = { name: 'N', type: 'float3', data: new Float32Array(72) };
    const d = { ...cube(), cornerLayers: [normals as unknown as MeshCornerLayer] };
    expect(meshDataProblem(d)).toMatch(/'N' is 'float3', which a stored mesh does not hold/);
  });

  it('refuses two layers with one name, and a layer with no name', () => {
    expect(meshDataProblem({ ...cube(), cornerLayers: [uvMap(), uvMap()] })).toMatch(
      /two corner layers are both named 'UVMap'/,
    );
    expect(meshDataProblem({ ...cube(), cornerLayers: [{ ...uvMap(), name: '' }] })).toMatch(
      /a corner layer has no name/,
    );
  });

  it('refuses more layers than the render buffer has slots for', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...uvMap(), name: `UV${i}` }));
    expect(meshDataProblem({ ...cube(), cornerLayers: five })).toMatch(
      /5 UV layers, but the render buffer draws at most 4/,
    );
    expect(
      meshDataProblem({ ...cube(), cornerLayers: [colour(), { ...colour(), name: 'Color.001' }] }),
    ).toMatch(/2 colour layers, but the render buffer draws at most 1/);
    // Control: four UV layers and one colour are exactly what fits.
    expect(
      meshDataProblem({ ...cube(), cornerLayers: [...five.slice(0, 4), colour()] }),
    ).toBeNull();
  });
});

describe('the packed form', () => {
  it('round-trips every array and every layer exactly, in order', () => {
    const data = layered();
    const back = unpackMeshData(packMeshData(data));
    expect(Array.from(back.points)).toEqual(Array.from(data.points));
    expect(Array.from(back.faceSizes)).toEqual(Array.from(data.faceSizes));
    expect(Array.from(back.cornerPoints)).toEqual(Array.from(data.cornerPoints));
    const spell = (layers: readonly MeshCornerLayer[]) =>
      layers.map((l) => [l.name, l.type, Array.from(l.data)]);
    expect(spell(back.cornerLayers)).toEqual(spell(data.cornerLayers));
    expect(Array.from(back.cornerNormals!)).toEqual(Array.from(data.cornerNormals!));
  });

  it('keeps absent normals absent, and a mesh with no layers has an empty list', () => {
    const packed = packMeshData({ ...cube(false), cornerLayers: [] });
    expect(packed.cornerNormals).toBeNull();
    expect(packed.cornerLayers).toEqual([]);
    expect(unpackMeshData(packed).cornerNormals).toBeNull();
    expect(unpackMeshData(packed).cornerLayers).toEqual([]);
  });

  it('decodes once per packed object', () => {
    const packed = packMeshData(cube());
    expect(unpackMeshData(packed)).toBe(unpackMeshData(packed));
  });

  it('recognises the packed shape by its fields, and not the retired fixed-field shape', () => {
    const packed = packMeshData(layered());
    expect(isPackedMeshData(packed)).toBe(true);
    const retired = {
      points: packed.points,
      faceSizes: packed.faceSizes,
      cornerPoints: packed.cornerPoints,
      cornerUVs: null,
      cornerNormals: packed.cornerNormals,
    };
    expect(isPackedMeshData(retired)).toBe(false);
  });

  it('keys by content: identical meshes share a key; a moved point, renamed or added layer does not', () => {
    const a = meshGeometryRef(packMeshData(cube()));
    const b = meshGeometryRef(packMeshData(cube()));
    const moved = cube();
    moved.points[0] = -0.6;
    const c = meshGeometryRef(packMeshData(moved));
    const renamed = meshGeometryRef(
      packMeshData({ ...cube(), cornerLayers: [{ ...uvMap(), name: 'UVMap.001' }] }),
    );
    const added = meshGeometryRef(packMeshData(layered()));
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
    expect(renamed.key).not.toBe(a.key);
    expect(added.key).not.toBe(a.key);
    expect(a.key.startsWith('mesh|')).toBe(true);
  });
});

describe('a stored cube answers like a box', () => {
  const ref = meshGeometryRef(packMeshData(cube()));
  const d: GeometryDescriptor = ref.descriptor;
  const box: GeometryDescriptor = { kind: 'box', size: [1, 1, 1] };

  it('states the same element counts as a box', () => {
    expect(faceCountOf(d)).toBe(faceCountOf(box));
    expect(cornerCountOf(d)).toBe(cornerCountOf(box));
    expect(faceArityOf(d)).toEqual(faceArityOf(box));
    expect(pointCountOf(d)).toEqual(pointCountOf(box));
    expect(edgeCountOf(d)).toEqual({ kind: 'counted', count: 12 });
    expect(edgeCountOf(d)).toEqual(edgeCountOf(box));
  });

  it('lays out, from the descriptor alone, in the numbering the build writes', () => {
    const layout = polygonLayoutOf(d);
    expect(layout.kind).toBe('laid-out');
    if (layout.kind !== 'laid-out') return;
    const built = buildMeshGeometry(cube());
    expect(layout.polygons).toEqual(built.splitRims);
    // Every rim's split vertices sit at that face's stored points.
    const pos = built.geometry.getAttribute('position');
    CUBE_FACES.forEach(([rim], f) => {
      layout.polygons[f].forEach((v, k) => {
        const p = CUBE_POINTS[rim[k]];
        expect([pos.getX(v), pos.getY(v), pos.getZ(v)]).toEqual(p);
      });
    });
  });

  it('welded rims are the stored corners', () => {
    expect(weldedPolygonsOf(d)).toEqual(CUBE_FACES.map(([rim]) => rim));
  });

  it('is available the way a box is, and reads ok with nothing mounted', () => {
    expect(availabilityOf(d)).toBe(availabilityOf(box));
    const read = readGeometry(ref);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.geometry.getAttribute('position').count).toBe(24);
    expect(read.geometry.getIndex()!.count).toBe(36);
    expect(weldByPosition(read.geometry).points).toBe(8);
  });

  it('weld comes from the corners, so two coincident stored points stay two', () => {
    // A seam cut on purpose: face 5 cites a ninth point at point 1's position.
    const data = cube();
    const points = Float32Array.from([...data.points, ...CUBE_POINTS[1]]);
    const cornerPoints = data.cornerPoints.slice();
    cornerPoints[20] = 8;
    const cut = meshGeometryRef(packMeshData({ ...data, points, cornerPoints }));
    expect(pointCountOf(cut.descriptor)).toEqual({ kind: 'counted', count: 9 });
    expect(composedWeldOf(cut)?.points).toBe(9);
    // Control: a position weld of the same buffer merges them, which is exactly the loss avoided.
    const read = readGeometry(cut);
    if (read.status !== 'ok') throw new Error(read.status);
    expect(weldByPosition(read.geometry).points).toBe(8);
  });
});

describe('the build', () => {
  it('splits a point only where its corners disagree', () => {
    // Normals differ per face, so the cube splits into 24 render vertices.
    expect(meshSplitLayout(cube()).vertexCorner.length).toBe(24);
    // Without normals, corners that share a point AND a uv collapse into one vertex.
    const flat = { ...cube(false), cornerLayers: [{ ...uvMap(), data: new Float32Array(48) }] };
    expect(meshSplitLayout(flat).vertexCorner.length).toBe(8);
  });

  it('splits a point where a colour disagrees, exactly as it does for a UV', () => {
    const flat = { ...cube(false), cornerLayers: [{ ...uvMap(), data: new Float32Array(48) }] };
    // Every point sits on three faces of three different colours, so each becomes three vertices.
    const coloured = { ...flat, cornerLayers: [...flat.cornerLayers, colour()] };
    expect(meshSplitLayout(coloured).vertexCorner.length).toBe(24);
  });

  it('draws each layer to the slot three reads, and every drawn vertex carries its corner’s values', () => {
    const data = layered();
    const { geometry, splitRims } = buildMeshGeometry(data);
    const slots = ['uv', 'uv1', 'color'];
    expect(slots.map((s) => geometry.getAttribute(s)?.itemSize)).toEqual([2, 2, 4]);
    let corner = 0;
    for (let f = 0; f < data.faceSizes.length; f++) {
      for (let k = 0; k < data.faceSizes[f]; k++, corner++) {
        const v = splitRims[f][k];
        data.cornerLayers.forEach((layer, i) => {
          const width = layer.type === 'float4' ? 4 : 2;
          const drawn = geometry.getAttribute(slots[i]).array;
          expect(
            Array.from(drawn.slice(v * width, v * width + width)),
            `${layer.name} face ${f} corner ${k}`,
          ).toEqual(Array.from(layer.data.slice(corner * width, corner * width + width)));
        });
      }
    }
  });

  it('names buffer slots by layer order: UV layers count up, the colour layer is `color`', () => {
    expect(
      cornerLayerBufferNames([{ type: 'float2' }, { type: 'float4' }, { type: 'float2' }]),
    ).toEqual(['uv', 'color', 'uv1']);
  });

  it('draws no uv buffer for a mesh with no UV layer', () => {
    const built = buildMeshGeometry({ ...cube(), cornerLayers: [] });
    expect(built.geometry.getAttribute('uv')).toBeUndefined();
    expect(built.geometry.getAttribute('color')).toBeUndefined();
  });

  it('derives normals when the mesh stores none', () => {
    const built = buildMeshGeometry(cube(false));
    expect(built.geometry.getAttribute('normal')).toBeDefined();
  });

  it('refuses malformed data by name instead of building garbage', () => {
    const bad = { ...cube(), faceSizes: Uint32Array.from([4, 4, 4, 4, 4, 2]) };
    expect(() => buildMeshGeometry(bad)).toThrow(/face 5 has 2 corners/);
  });
});
