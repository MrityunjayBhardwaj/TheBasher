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
//   box    6/6      sphere 6/6      gltf 0/6      baked 0/6
//
// A generated mesh answers every question the model can ask. An imported one answers none
// of them: `GeometryDescriptor` is build recipes and references with nowhere to put an
// attribute, so `gltf` carries an `assetRef` and a `childName` and the questions have
// nothing to read. That is the root defect, and #605 / #607 / #496 are it seen from three
// sides. When they land, these numbers move and this file must be edited.
//
// Two formats are absent from the table rather than scoring zero on it, which is a
// different and worse thing:
//   - FBX imports NO geometry at all (`src/core/import/fbx.ts:11` — mesh import deferred);
//     it contributes a skeleton and a clip.
//   - OBJ has no descriptor kind; the union has no `obj` arm to ask questions of.
//
// ── MEASURED LIMIT ────────────────────────────────────────────────────────────────────
//
// This covers the four LEAF kinds. The operator kinds (`array`, `mirror`, `subset`,
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
  ['gltf', { kind: 'gltf', assetRef: 'user-imports/x/x.gltf', childName: 'Cube' }],
  ['baked', { kind: 'baked', hash: 'abc', vertexCount: 24 }],
];

/**
 * The distance, as last agreed. Generated kinds answer everything; imported kinds answer
 * nothing. EDIT THESE when #605 / #607 / #496 move them — that edit is the point.
 */
const ANSWERED: Readonly<Record<string, number>> = {
  box: 6,
  sphere: 6,
  gltf: 0,
  baked: 0,
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
    expect(SUBJECTS.length).toBe(4);
    expect(Object.keys(ANSWERED).sort()).toEqual(SUBJECTS.map(([n]) => n).sort());
  });
});
