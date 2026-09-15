// #1117 — a bevel refuses, by name, a source carrying corner layers it does not write.
//
// ── WHY A REFUSAL AND NOT A DRAW WITHOUT THEM ─────────────────────────────────────────────────
//
// `buildBevel` writes `position`, interpolates `uv` onto the corners it mints, and computes
// normals. A stored mesh can now carry a second UV set (`uv1` …) and a colour (`color`), and a
// bevel that built anyway would draw the mesh as if it never had them, with nothing said. Carrying
// them is interpolation, the same question `uv` already answers, and it is #881's. Until then the
// honest answer is the one `buildBevel` already gives for everything else it cannot do: no build,
// and a sentence naming why.
//
// ── THE CONTROL IS THE SAME CUBE WITHOUT THE LAYER ────────────────────────────────────────────
//
// Every refusal row has a twin that differs by exactly the layer under test and builds, so a
// refusal that fired for some other reason (a cube the bevel cannot lay out, a registry miss)
// cannot pass as this one.
//
// REF: src/app/geometryRegistry.ts (`buildBevel`, the refusal); src/app/meshGeometryData.ts
//      (`CORNER_LAYER_SLOTS`, the slots a stored mesh's layers draw to); issues #1117, #881, #1062.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bevelGeometryRef } from './modifierGeometry';
import { clear, getForRead } from './geometryRegistry';
import { CORNER_LAYER_SLOTS, meshGeometryRef, packMeshData } from './meshGeometryData';
import type { GeometryRef, MeshCornerLayer, MeshGeometryData } from '../nodes/types';

const h = 0.5;
const POINTS = [
  [-h, -h, -h],
  [h, -h, -h],
  [h, h, -h],
  [-h, h, -h],
  [-h, -h, h],
  [h, -h, h],
  [h, h, h],
  [-h, h, h],
];
// Six outward-wound quads over the eight points: a closed manifold, which a bevel lays out.
const FACES = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [3, 7, 6, 2],
  [0, 4, 7, 3],
  [1, 2, 6, 5],
];
const CORNERS = FACES.length * 4;

const uvMap = (): MeshCornerLayer => ({
  name: 'UVMap',
  type: 'float2',
  data: Float32Array.from(FACES.flatMap(() => [0, 0, 1, 0, 1, 1, 0, 1])),
});
const secondUvs = (): MeshCornerLayer => ({
  name: 'UVMap.001',
  type: 'float2',
  data: Float32Array.from({ length: CORNERS * 2 }, (_, i) => i / (CORNERS * 2)),
});
const colour = (): MeshCornerLayer => ({
  name: 'Color',
  type: 'float4',
  data: Float32Array.from({ length: CORNERS * 4 }, (_, i) => i / (CORNERS * 4)),
});

function storedCube(extra: readonly MeshCornerLayer[]): GeometryRef {
  const data: MeshGeometryData = {
    points: Float32Array.from(POINTS.flat()),
    faceSizes: Uint32Array.from(FACES.map(() => 4)),
    cornerPoints: Uint32Array.from(FACES.flat()),
    cornerLayers: [uvMap(), ...extra],
    cornerNormals: null,
  };
  return meshGeometryRef(packMeshData(data));
}

describe('#1117 a bevel over a stored mesh with corner layers it does not write', () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clear();
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
  });

  const refusals = () =>
    errors.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("cannot build a 'bevel'"));

  it('control: the cube with only its first UV layer bevels, and carries that uv', () => {
    const built = getForRead(bevelGeometryRef(storedCube([]), 0.1));
    expect(built, 'the control builds').not.toBeNull();
    expect(built!.getAttribute('uv'), 'and carries its uv').toBeDefined();
    expect(refusals()).toEqual([]);
  });

  it.each([
    ['a second UV set', [secondUvs()], ['uv1']],
    ['a colour', [colour()], ['color']],
    ['both', [secondUvs(), colour()], ['uv1', 'color']],
  ] as const)('refuses a cube carrying %s, and names the slots and #881', (_, extra, slots) => {
    // The source really does carry the slots: the refusal below is about them, not a missing mesh.
    const source = getForRead(storedCube(extra));
    expect(source, 'the source builds').not.toBeNull();
    for (const slot of slots) expect(source!.getAttribute(slot), slot).toBeDefined();

    const built = getForRead(bevelGeometryRef(storedCube(extra), 0.1));
    expect(built, 'no bevel is built').toBeNull();
    const said = refusals();
    expect(said, 'exactly one sentence says why').toHaveLength(1);
    expect(said[0]).toContain(`carries ${slots.join(', ')}`);
    expect(said[0]).toContain('#881');
  });

  it('refuses for every slot a stored mesh layer can draw to except the one it writes', () => {
    // Pinned so a slot added to the build without a decision here reds by name.
    expect(CORNER_LAYER_SLOTS).toEqual(['uv', 'uv1', 'uv2', 'uv3', 'color']);
  });
});
