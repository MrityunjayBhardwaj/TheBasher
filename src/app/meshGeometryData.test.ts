// #1049 — a stored polygon mesh answers the model's questions the way a box does, from its own
// data, with nothing loaded or mounted.
import { describe, expect, it } from 'vitest';
import type { GeometryDescriptor, MeshGeometryData } from '../nodes/types';
import {
  buildMeshGeometry,
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

function cube(withNormals = true): MeshGeometryData {
  return {
    points: Float32Array.from(CUBE_POINTS.flat()),
    faceSizes: Uint32Array.from(CUBE_FACES.map(() => 4)),
    cornerPoints: Uint32Array.from(CUBE_FACES.flatMap(([rim]) => rim)),
    cornerUVs: Float32Array.from(CUBE_FACES.flatMap(() => QUAD_UV)),
    cornerNormals: withNormals
      ? Float32Array.from(CUBE_FACES.flatMap(([, n]) => [...n, ...n, ...n, ...n]))
      : null,
  };
}

describe('meshDataProblem', () => {
  it('accepts a well-formed cube', () => {
    expect(meshDataProblem(cube())).toBeNull();
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

  it('refuses a UV array of the wrong length', () => {
    expect(meshDataProblem({ ...cube(), cornerUVs: new Float32Array(46) })).toMatch(/cornerUVs/);
  });
});

describe('the packed form', () => {
  it('round-trips every array exactly', () => {
    const data = cube();
    const back = unpackMeshData(packMeshData(data));
    expect(Array.from(back.points)).toEqual(Array.from(data.points));
    expect(Array.from(back.faceSizes)).toEqual(Array.from(data.faceSizes));
    expect(Array.from(back.cornerPoints)).toEqual(Array.from(data.cornerPoints));
    expect(Array.from(back.cornerUVs!)).toEqual(Array.from(data.cornerUVs!));
    expect(Array.from(back.cornerNormals!)).toEqual(Array.from(data.cornerNormals!));
  });

  it('keeps an absent corner attribute absent', () => {
    const packed = packMeshData(cube(false));
    expect(packed.cornerNormals).toBeNull();
    expect(unpackMeshData(packed).cornerNormals).toBeNull();
  });

  it('decodes once per packed object', () => {
    const packed = packMeshData(cube());
    expect(unpackMeshData(packed)).toBe(unpackMeshData(packed));
  });

  it('keys by content: identical meshes share a key, one moved point does not', () => {
    const a = meshGeometryRef(packMeshData(cube()));
    const b = meshGeometryRef(packMeshData(cube()));
    const moved = cube();
    moved.points[0] = -0.6;
    const c = meshGeometryRef(packMeshData(moved));
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
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
    const noNormals = { ...cube(false), cornerUVs: new Float32Array(48) };
    expect(meshSplitLayout(noNormals).vertexCorner.length).toBe(8);
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
