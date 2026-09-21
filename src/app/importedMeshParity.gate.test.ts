// #1020 — HOW FAR AN IMPORTED MESH IS FROM A BOX, AS A NUMBER THAT CI RE-MEASURES.
//
// The engraved goal is one polygonal geometry data model with typed per-element attributes,
// where a format is an importer that FILLS it and then stops existing — glTF, FBX and OBJ
// behaving exactly as they do in Houdini and Blender, neither of which has an "imported
// mesh" kind. The goal also states its own done-test:
//
//     Take any question the model answers for a box and ask it of an imported mesh.
//     Every `null`, every `outside-the-descriptor`, every `drawnByAssetClone` is
//     distance remaining.
//
// Until this file, that distance was a sentence in a catalogue. A sentence ages — #628's
// status table went stale in three rows, and five issues probed in one day each stated a
// status the code contradicted. A test re-measures its premise on every run, which is the
// entire reason this is a gate and not a doc.
//
// ── IT REDS IN BOTH DIRECTIONS, AND THAT IS DELIBERATE ────────────────────────────────
//
// Obviously it reds if an imported mesh LOSES an answer. It also reds when one GAINS an
// answer, because the recorded number is the distance to the goal: closing part of that
// distance should force someone to edit this table by hand, in a diff a human reads, rather
// than letting the frontier move silently. A green here means "the distance is exactly what
// we last agreed it was", not "everything is fine" — today it is emphatically not fine.
//
// ── WHAT THE NUMBERS MEAN TODAY ───────────────────────────────────────────────────────
//
//   box 6/6     sphere 6/6     gltf 0/6     gltf+captured 3/6     baked 0/6
//
// A generated mesh answers every question the model can ask. An imported one answers none of
// them UNTIL its import captured a face count: `GeometryDescriptor` is build recipes and
// references with nowhere to put an attribute, so a bare `gltf` carries an `assetRef` and a
// `childName` and the questions have nothing to read. That is the root defect, and #605 /
// #607 / #496 are it seen from three sides.
//
// 🔑 THE TWO gltf ROWS ARE THE POINT OF THIS TABLE NOW. They are the same child; the only
// difference is whether the importer read its face count. Three answers turn on that one
// fact, which is why the escape hatch these questions declare is a CAPTURE STATE and not a
// kind — a distinction that had rotted into "the gltf arm has no answer" in two separate
// modules before #1029 made it a row here.
//
// The three a captured child still cannot answer — polygon layout, point count, edge count —
// all need the RIMS or the WELD, which are the index and position buffers rather than
// descriptor data. Note what that means and what this table cannot see: #1025 and #1028 DID
// recover an imported mesh's rims, from the built buffer, and none of these numbers moved,
// because every question here is asked of a DESCRIPTOR alone. This measures descriptor-side
// distance. It is the right thing to measure for the root defect and it is not the whole
// distance to the goal.
//
// Two formats are absent from the table rather than scoring zero on it, which is a
// different and worse thing:
//   - FBX imports NO geometry at all (`src/core/import/fbx.ts:11` — mesh import deferred);
//     it contributes a skeleton and a clip.
//   - OBJ has no descriptor kind; the union has no `obj` arm to ask questions of.
//
// ── MEASURED LIMIT ────────────────────────────────────────────────────────────────────
//
// This covers the four LEAF kinds (as five subjects — `gltf` appears twice, captured and not). The operator kinds (`array`, `mirror`, `subset`,
// `bevel`, `uvProject`, `counted`) answer through their source and are out of scope here.
// A new leaf kind added to the union does NOT red this file — there is no named leaf type
// to make exhaustive against, so that gap is real and stated rather than assumed away.
//
// REF: `.anvi/dharana.md` §0 (the goal and the done-test); epic #628; issues #605 #607
//      #496 #1020; `src/nodes/types.ts` (`GeometryDescriptor`).

import { describe, it, expect } from 'vitest';
import type { GeometryDescriptor } from '../nodes/types';
import { faceCountOf, faceArityOf, cornerCountOf } from './faceCount';
import { polygonLayoutOf } from './polygonLayout';
import { pointCountOf } from './pointIdentity';
import { edgeCountOf } from './edgeIdentity';
import { availabilityOf, drawnByAssetClone } from './geometryRegistry';
import { meshGeometryRef, packMeshData } from './meshGeometryData';

/** The questions the model answers for a box. An imported mesh should answer all of them. */
const QUESTIONS: ReadonlyArray<readonly [string, (d: GeometryDescriptor) => boolean]> = [
  ['face count', (d) => faceCountOf(d) !== null],
  ['face arity', (d) => faceArityOf(d) !== null],
  ['corner count', (d) => cornerCountOf(d) !== null],
  ['polygon layout', (d) => polygonLayoutOf(d).kind === 'laid-out'],
  ['point count', (d) => pointCountOf(d).kind === 'counted'],
  ['edge count', (d) => edgeCountOf(d).kind === 'counted'],
];

const SUBJECTS: ReadonlyArray<readonly [string, GeometryDescriptor]> = [
  ['box', { kind: 'box', size: [1, 1, 1] }],
  ['sphere', { kind: 'sphere', radius: 1, widthSegments: 8, heightSegments: 6 }],
  // An imported child whose import captured nothing — every save written before #1023, and
  // every child that is not an all-triangle mesh. It answers nothing, and must keep doing so.
  ['gltf', { kind: 'gltf', assetRef: 'user-imports/x/x.gltf', childName: 'Cube' }],
  // #1023 — the same child, imported by a build that captured its face count. THIS is the
  // row that measures the goal: it is the first imported mesh that answers anything at all.
  [
    'gltf+captured',
    { kind: 'gltf', assetRef: 'user-imports/x/x.gltf', childName: 'Cube', faceCount: 12 },
  ],
  // #1040 — the same child again, imported by a build that welded its POINT count too. The
  // row above is NOT superseded by this one and must stay: a face-count-only child is still
  // an ordinary, reachable state — every save written before #1040, and every MULTI-PRIMITIVE
  // child, whose read door holds only the first primitive's buffer so no point count may be
  // minted for it at all. Two populations, two rows.
  [
    'gltf+captured+welded',
    {
      kind: 'gltf',
      assetRef: 'user-imports/x/x.gltf',
      childName: 'Cube',
      faceCount: 12,
      pointCount: 8,
    },
  ],
  ['baked', { kind: 'baked', hash: 'abc', vertexCount: 24 }],
  // #1049 — the kind an import writes from now on: a stored polygon mesh, owned by no format. A
  // tetrahedron, so every question has faces, corners, points and edges to count.
  [
    'mesh',
    meshGeometryRef(
      packMeshData({
        points: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
        faceSizes: Uint32Array.from([3, 3, 3, 3]),
        cornerPoints: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
        cornerLayers: [],
        cornerNormals: null,
        faceLayers: [],
      }),
    ).descriptor,
  ],
];

/**
 * The distance, as last agreed. Generated kinds answer everything; imported kinds answer
 * nothing. EDIT THESE when #605 / #607 / #496 move them — that edit is the point.
 */
const ANSWERED: Readonly<Record<string, number>> = {
  box: 6,
  sphere: 6,
  gltf: 0,
  // #1023 moved this from 0 to 3. Face count, corner count and arity now answer from the
  // captured count plus the format's guarantee that a glTF face is a triangle. The three
  // that still refuse — polygon layout, point count, edge count — all need RIMS or the
  // WELD, which are the index and position buffers, not descriptor data. Their refusal is
  // about the weld and not about arity, and that is the next number to move.
  'gltf+captured': 3,
  // #1040 moved this to 4. The WELD arrived — a point count is one integer, captured from the
  // POSITION accessor at import and welded through production's own `weldByPosition`, so both
  // sides of the comparison quantise identically. Measured against the loaded buffer on every
  // fixture the real GLTFLoader can parse: 15 of 15 children agree.
  //
  // The two that still refuse — polygon layout and edge count — need RIMS, which is the index
  // buffer and not a number a descriptor can carry. That is the next thing to move, and it
  // moves both of them at once: `edgeCountOf` needs a counted point total (it now has one) AND
  // welded rims, so rims are the whole of the remaining distance.
  'gltf+captured+welded': 4,
  baked: 0,
  // #1049 — the distance closed by changing what an import IS rather than by capturing more about
  // a reference: a stored mesh carries its points, faces and corners, so it answers all six from
  // its own data with nothing mounted. `baked` stays at 0 on purpose — it is not this kind.
  mesh: 6,
};

function answeredBy(d: GeometryDescriptor): string[] {
  return QUESTIONS.filter(([, ask]) => ask(d)).map(([name]) => name);
}

describe('#1020 — the distance from an imported mesh to a box', () => {
  it('answers exactly as many of the box’s questions as last recorded', () => {
    const actual: Record<string, number> = {};
    for (const [name, d] of SUBJECTS) actual[name] = answeredBy(d).length;
    expect(
      actual,
      'An imported mesh answered a different number of the model’s questions than last ' +
        'recorded. If this went UP, the goal moved closer — update the table and say which ' +
        'issue did it. If it went DOWN, an imported mesh just lost a capability.',
    ).toEqual(ANSWERED);
  });

  it('a generated mesh answers every question — the bar the imported ones are held to', () => {
    for (const name of ['box', 'sphere']) {
      const d = SUBJECTS.find(([n]) => n === name)?.[1] as GeometryDescriptor;
      expect(answeredBy(d), `${name} stopped answering a question it used to`).toHaveLength(
        QUESTIONS.length,
      );
    }
  });

  it('names every question an imported mesh still cannot answer', () => {
    const gltf = SUBJECTS.find(([n]) => n === 'gltf')?.[1] as GeometryDescriptor;
    const unanswered = QUESTIONS.filter(([, ask]) => !ask(gltf)).map(([n]) => n);
    // Listed rather than counted, so the diff that closes one says WHICH one.
    expect(unanswered).toEqual([
      'face count',
      'face arity',
      'corner count',
      'polygon layout',
      'point count',
      'edge count',
    ]);

    // #1023 — and the three a FACE-COUNT-ONLY child still cannot answer. All three need the
    // rims or the weld; none of them needs arity any more.
    const captured = SUBJECTS.find(([n]) => n === 'gltf+captured')?.[1] as GeometryDescriptor;
    expect(QUESTIONS.filter(([, ask]) => !ask(captured)).map(([n]) => n)).toEqual([
      'polygon layout',
      'point count',
      'edge count',
    ]);

    // #1040 — and the TWO a fully captured child still cannot answer. Both need rims, and
    // stating them as a pair is the point: they are one acquisition, not two tasks.
    const welded = SUBJECTS.find(([n]) => n === 'gltf+captured+welded')?.[1] as GeometryDescriptor;
    expect(QUESTIONS.filter(([, ask]) => !ask(welded)).map(([n]) => n)).toEqual([
      'polygon layout',
      'edge count',
    ]);
  });

  it('records the one real divergence between the two imported kinds', () => {
    // `gltf` and `baked` answer the model's questions identically — they differ only in HOW
    // they reach the screen, and that bit is true rather than debt: a mounted clone draws
    // itself. Pinned so the day they diverge on anything else, it is a decision.
    const gltf = SUBJECTS.find(([n]) => n === 'gltf')?.[1] as GeometryDescriptor;
    const baked = SUBJECTS.find(([n]) => n === 'baked')?.[1] as GeometryDescriptor;
    expect(answeredBy(gltf)).toEqual(answeredBy(baked));
    expect(availabilityOf(gltf)).toBe('clone');
    expect(availabilityOf(baked)).toBe('primed');
    expect(drawnByAssetClone(gltf)).toBe(true);
    expect(drawnByAssetClone(baked)).toBe(false);
  });

  it('the questions are actually being asked — a zero with no denominator is not a finding', () => {
    // The positive control this file cannot do without: if `QUESTIONS` were empty, or the
    // subjects list were, every assertion above would pass vacuously and report 0/0 as a
    // clean parity result.
    expect(QUESTIONS.length).toBe(6);
    // 5 → 6 at #1040: the fully-captured imported child joined as its own subject rather than
    // replacing the face-count-only one, because both populations are still reachable.
    // 6 → 7 at #1049: the stored mesh an import now writes, which is the row the goal is about.
    expect(SUBJECTS.length).toBe(7);
    expect(Object.keys(ANSWERED).sort()).toEqual(SUBJECTS.map(([n]) => n).sort());
  });
});
