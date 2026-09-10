// #786 — THE GATE: an AUTHORED corner layer reaches the render buffer, and the buffer can hold it.
//
// ── WHAT HAD TO BE PROVED, AND WHY THE OBVIOUS ASSERTION IS THE WRONG ONE ─────────────────
//
// #786's own kill switch is *"if no operator ever authors a corner value that differs between two
// loops at one render vertex, the split never fires and the whole materialisation is a copy."*
// #994 broke that switch — 22 disagreeing corners on an 8x6 sphere — so the work is about
// something. What this file has to show is the other half: that those 22 SURVIVE the trip to the
// buffer instead of being quietly collapsed onto one slot apiece.
//
// 🔴 AND "COUNT THE DISAGREEMENTS ON THE BUILT BUFFER" IS EXACTLY THE WRONG TEST, which is worth
// stating because it is the first thing anyone writes. After materialisation that number is ZERO
// BY CONSTRUCTION — every vertex whose loops disagreed has been split until none do. A gate
// asserting a non-zero count there would fail on a correct build and pass on one that never ran.
//
// The statement that actually distinguishes them is LOSSLESSNESS: lift the layer back off the
// built buffer through its own rims and compare it, element for element, with what the operator
// authored. A buffer that collapsed the seams reproduces the wrong values at those corners; a
// buffer that split them reproduces all 176 exactly. The lift is `readMeshUVs`, which already
// exists and is the inverse direction — so the round trip is run through production code on both
// legs rather than through a probe written to agree with itself.
//
// REF: src/app/cornerMaterialisation.ts (the split); src/app/geometryRegistry.ts
//      (`buildUVProject`, `projectionMaterialises`); src/app/uvProjection.ts (the author);
//      src/app/uvAttributes.ts (`readMeshUVs` — the lift, used here as the inverse);
//      issues #786, #994, #776, #738, #1005.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  availabilityOf,
  clear,
  drawnByAssetClone,
  getForRead,
  readGeometry,
} from './geometryRegistry';
import { alignedSplitRims } from './builtRims';
import { boxGeometryRef, sphereGeometryRef, uvProjectGeometryRef } from './modifierGeometry';
import { cubeProjectedLayer } from './cubeProjection';
import { readMeshUVs } from './uvAttributes';
import { materialiseCornerLayer } from './cornerMaterialisation';
import { faceArityOf } from './faceCount';
import { read } from './attributeStore';
import { UV_MAP } from '../nodes/attributes';
import type { GeometryRef } from '../nodes/types';

const SIZE = 2;
const SPHERE = () => sphereGeometryRef(1, 8, 6, null);
const BIG_SPHERE = () => sphereGeometryRef(1, 32, 16, null);
const BOX = () => boxGeometryRef([1, 1, 1], null);

/** What the operator AUTHORS over a source, before anything materialises it. */
function authored(source: GeometryRef): Float32Array {
  const geometry = getForRead(source)!;
  return cubeProjectedLayer(geometry, alignedSplitRims(source, geometry)!, SIZE)
    .data as Float32Array;
}

/** How many render vertices carry more than one loop, and how many of those DISAGREE. */
function sharedAndDisagreeing(ref: GeometryRef, uvs: Float32Array) {
  const geometry = getForRead(ref)!;
  const perVertex = new Map<number, { u: number; v: number }[]>();
  let corner = 0;
  for (const rim of alignedSplitRims(ref, geometry)!)
    for (const vertex of rim) {
      const seen = perVertex.get(vertex) ?? [];
      seen.push({ u: uvs[corner * 2], v: uvs[corner * 2 + 1] });
      perVertex.set(vertex, seen);
      corner++;
    }
  expect(uvs.length, 'the layer does not cover every corner').toBe(corner * 2);
  let shared = 0;
  let disagreeing = 0;
  for (const [, values] of perVertex) {
    if (values.length < 2) continue;
    shared++;
    const first = values[0];
    if (values.some((x) => Math.abs(x.u - first.u) > 1e-6 || Math.abs(x.v - first.v) > 1e-6))
      disagreeing++;
  }
  return { shared, disagreeing };
}

/** The layer LIFTED back off a built geometry through its own rims — the inverse direction. */
function lifted(ref: GeometryRef): Float32Array {
  const result = readMeshUVs(ref);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  expect(
    result.attribute.kind,
    result.attribute.kind === 'not-derivable' ? result.attribute.why : '',
  ).toBe('resident');
  if (result.attribute.kind !== 'resident') throw new Error('unreachable');
  return read(result.attribute.key)![UV_MAP].data as Float32Array;
}

describe('#786 the authored layer reaches the buffer', () => {
  beforeEach(() => clear());

  it('🔴 THE FALSIFICATION: the 22 disagreeing corners SURVIVE, element for element', () => {
    const source = SPHERE();
    const ref = uvProjectGeometryRef(source, SIZE);

    // 1. The disagreement is real on the SOURCE, where the loops still share vertices. This is
    //    #994's measured row, re-taken here rather than cited: if it ever reads 0 the rest of
    //    this test is asserting things about nothing.
    const layer = authored(source);
    expect(sharedAndDisagreeing(source, layer)).toEqual({ shared: 45, disagreeing: 22 });

    // 2. Lifted back off the BUILT projection, the layer is reproduced EXACTLY. This is the whole
    //    claim: 176 authored values, 176 recovered, no seam collapsed onto a neighbour.
    expect(Array.from(lifted(ref))).toEqual(Array.from(layer));

    // 3. And on the built buffer nothing disagrees any more, because the split is what removes
    //    the disagreement. Asserted so that a build which quietly stopped splitting — and would
    //    therefore FAIL step 2 with wrong values — cannot also look right here.
    expect(sharedAndDisagreeing(ref, lifted(ref)).disagreeing).toBe(0);
  });

  it('🔴 THE CONTROL: a BOX splits NOTHING, and its positions and index are untouched', () => {
    // The control that says the split fires on disagreement rather than on being called. A box's
    // 24 loops and 24 render vertices are one-to-one, so no cube side is ever chosen twice at one
    // vertex and there is nothing to duplicate. If this row ever grows a duplicate, the split is
    // firing on identity rather than on difference and every count below it is inflated.
    const source = BOX();
    const ref = uvProjectGeometryRef(source, SIZE);
    const before = getForRead(source)!;
    const after = getForRead(ref)!;

    expect(after.getAttribute('position').count).toBe(before.getAttribute('position').count);
    expect(Array.from(after.getIndex()!.array)).toEqual(Array.from(before.getIndex()!.array));
    for (const name of ['position', 'normal'])
      expect(Array.from(after.getAttribute(name).array), name).toEqual(
        Array.from(before.getAttribute(name).array),
      );
    // The one attribute that MUST differ — otherwise the projection wrote nothing at all.
    expect(Array.from(after.getAttribute('uv').array)).not.toEqual(
      Array.from(before.getAttribute('uv').array),
    );
  });

  it('what the split costs, stated exactly', () => {
    // Exact rather than `> 0`, for the reason every census here is exact: a floor cannot catch a
    // drop. `weld` is the number `pointCountMismatch` compares against descriptor arithmetic, and
    // it is the row that says the parity check needs no exemption — see the next test.
    const rows = [
      { name: 'box', source: BOX(), positions: [24, 24], weld: 8 },
      { name: 'sphere 8x6', source: SPHERE(), positions: [63, 93], weld: 42 },
      { name: 'sphere 32x16', source: BIG_SPHERE(), positions: [561, 669], weld: 482 },
    ];
    for (const row of rows) {
      const ref = uvProjectGeometryRef(row.source, SIZE);
      const before = getForRead(row.source)!.getAttribute('position').count;
      const after = getForRead(ref)!.getAttribute('position').count;
      expect([before, after], row.name).toEqual(row.positions);
    }
  });

  it('🔴 the POINT-COUNT PARITY stays silent, because a duplicate lands on its own position', () => {
    // The risk #786's body names, run rather than argued. `pointCountMismatch` compares the
    // descriptor's topological arithmetic against a POSITION weld — two questions in different
    // units — and `build()` warns on every disagreement. A split duplicates a vertex WITHOUT
    // moving it, so the weld fuses the copies and reads what it read before.
    //
    // ⚠️ WHAT THIS ROW CAN AND CANNOT CATCH, MEASURED RATHER THAN ASSUMED. It was written
    // expecting to catch any mis-placed duplicate, and it does not. A duplicate written at some
    // OTHER existing vertex's position leaves this silent — stacking copies cannot raise a count
    // of DISTINCT positions — and the falsification that stacked all 30 on vertex 0 passed here
    // while failing the losslessness row above. What it does catch is a duplicate at a position
    // no vertex held before: offsetting one by a unit reds this row. So it is a one-sided guard,
    // in the same direction and for the same reason as the clamped-bevel exemption it sits
    // beside, and the losslessness row is what covers the other side.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const source of [BOX(), SPHERE(), BIG_SPHERE()])
        getForRead(uvProjectGeometryRef(source, SIZE));
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([]);
      expect(error.mock.calls.map((c) => String(c[0]))).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('🔴 THE CONTROL THE BOX CANNOT BE: 45 SHARED vertices that AGREE split NOTHING', () => {
    // 🔴 THIS ROW EXISTS BECAUSE THE BOX ROW WAS MEASURED UNABLE TO DO ITS JOB. The box control
    // above says a mesh with nothing to duplicate duplicates nothing — but a box's 24 loops sit
    // on 24 vertices, one loop each, so NO vertex is shared and the minting branch is never
    // reached at all. A split that fired on SHARING rather than on DISAGREEMENT would leave the
    // box untouched and pass. Falsified directly: forcing every value comparison to report
    // "different" left the box row green.
    //
    // A sphere carrying its own UV0 LIFT is the subject that separates them. It has the same 45
    // shared render vertices the projection does, and — structurally, because a lift is a
    // pullback along loop → vertex — it disagrees at none of them. So a correct split duplicates
    // nothing here, over a mesh where there was every opportunity to.
    const source = SPHERE();
    const geometry = getForRead(source)!;
    const layer = lifted(source);
    expect(sharedAndDisagreeing(source, layer)).toEqual({ shared: 45, disagreeing: 0 });

    const result = materialiseCornerLayer(
      geometry,
      faceArityOf(source.descriptor)!,
      alignedSplitRims(source, geometry)!,
      { domain: 'corner', type: 'float2', count: layer.length / 2, data: layer },
      'uv',
    );
    expect(result.kind, result.kind === 'refused' ? result.why : '').toBe('materialised');
    if (result.kind !== 'materialised') throw new Error('unreachable');
    expect(result.duplicates).toBe(0);
    expect(result.geometry.getAttribute('position').count).toBe(
      geometry.getAttribute('position').count,
    );
  });

  it('🔴 a source with NO polygons PASSES THROUGH rather than vanishing', () => {
    // #738's set, and the regression this arm exists to prevent. An imported mesh states no face
    // arity, so the projection cannot materialise anything over it. Answering the composed
    // availability there would turn `drawnByAssetClone` false, send the Object looking for its
    // own buffers, and draw NOTHING — a director watching their imported model disappear the
    // moment they add a modifier. So it passes through, unchanged and still drawn.
    const asset: GeometryRef = {
      key: 'gltf|asset-a|Cube',
      descriptor: { kind: 'gltf', assetRef: 'asset-a', childName: 'Cube' },
    };
    const ref = uvProjectGeometryRef(asset, SIZE);
    expect(availabilityOf(ref.descriptor)).toBe('clone');
    expect(availabilityOf(ref.descriptor)).toBe(availabilityOf(asset.descriptor));
    expect(drawnByAssetClone(ref.descriptor)).toBe(true);
    // And the read door agrees with the availability rule — one answer, not two.
    expect(readGeometry(ref).status).toBe('elsewhere');
  });
});
