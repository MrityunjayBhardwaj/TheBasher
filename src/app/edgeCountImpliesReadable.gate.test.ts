// #1039 — A DERIVABLE EDGE COUNT MUST IMPLY READABLE GEOMETRY, AND NOTHING ELSE ENFORCES IT.
//
// ── THE ROAD THIS PROTECTS ────────────────────────────────────────────────────────────
//
// `resolveComponentSelection`'s angle arm reads a built buffer through `edgeIndicesByAngle`,
// and turns a null into `refuse()`, which THROWS. `evaluate` runs on the render walk with no
// `try` above it — the comment beside that arm records the same shape taking the whole app
// down once already (`angleLimit` at 90 on a default cube, reachable by a scrub drag). #862
// fixed the EMPTY case by resolving instead of refusing; the `refused` case still throws.
//
// The arm is only reached after the edge-count guard passes, and that guard returns `null`
// rather than throwing when nothing was authored. So the throw needs BOTH a derivable edge
// count AND unbuildable geometry. Today nothing has both: every descriptor whose buffers live
// elsewhere also declines to state an edge count.
//
// 🔴 THAT ALIGNMENT IS NOT A GUARD ANYONE WROTE, AND THE ROUTE IS COMMITTED TO REMOVING IT.
// `.anvi/dharana.md` §0 states the done-test as *"Every `null`, every `outside-the-descriptor`,
// every `drawnByAssetClone` is distance remaining"* — and `outside-the-descriptor` IS the
// alignment. The day an imported mesh states its edge count from the descriptor, which is the
// GOAL, a bevel with an angle limit over a glTF whose clone has not mounted becomes
// `counted` + `null`, and the arm throws. The success condition and the landmine are one change.
//
// So this file does not fix a crash nobody can trigger. It reds the day the crash becomes
// constructible, which is the moment the fix is both needed and cheap — the same fix #862
// already established: resolve rather than refuse when the cause is "not readable YET".
//
// ── WHY THE KIND LIST IS SCANNED AND NOT WRITTEN ──────────────────────────────────────
//
// A hand-written list of descriptor kinds is the exact thing that rots: a kind added later is
// simply absent, and an absent subject makes this file pass by examining less. So the list is
// read off `faceCountOf`'s switch, which is closed by `const unreachable: never` in PRODUCTION
// code — a new kind is a typecheck error there (and `npm run typecheck` sees production), and
// an unlisted one is a red here. Comments are stripped first so prose naming a kind is not
// mistaken for an arm.
//
// REF: src/nodes/componentSelection.ts (the angle arm, `refuse`), src/app/edgeAngleSelection.ts
//      (`edgeIndicesByAngle`), src/app/faceCount.ts (the scanned switch). Issues #1039, #496,
//      #862, #847.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { componentCountOf } from '../nodes/componentSelection';
import { getForRead } from './geometryRegistry';
import { arrayGeometryRef, mirrorGeometryRef } from './modifierGeometry';
import { stripComments } from '../test-utils/sourceScan';
import type { GeometryDescriptor, GeometryRef } from '../nodes/types';

/** The kinds `faceCountOf` handles, read off its own `never`-closed switch. */
function scannedKinds(): string[] {
  const src = stripComments(readFileSync('src/app/faceCount.ts', 'utf8'));
  const body = src.slice(src.indexOf('export function faceCountOf'));
  const end = body.indexOf('\n}');
  return [
    ...new Set([...body.slice(0, end).matchAll(/case '([a-zA-Z]+)'/g)].map((m) => m[1])),
  ].sort();
}

const box: GeometryRef = { key: 'box|1,1,1', descriptor: { kind: 'box', size: [1, 1, 1] } };
const sphere: GeometryRef = {
  key: 'sphere|1|8|6',
  descriptor: { kind: 'sphere', radius: 1, widthSegments: 8, heightSegments: 6 },
};
const gltf: GeometryRef = {
  key: 'gltf|a|c',
  descriptor: { kind: 'gltf', assetRef: 'a', childName: 'c', faceCount: 12 },
};
const baked: GeometryRef = {
  key: 'baked|dead',
  descriptor: { kind: 'baked', hash: 'deadbeef', vertexCount: 24 },
};

/**
 * One representative per kind. Typed `Record<GeometryDescriptor['kind'], …>` so a missing kind
 * is a type error in an editor, AND checked against {@link scannedKinds} below so it is a RED
 * in CI, where this file's types are not checked at all.
 */
const REPRESENTATIVE: Record<GeometryDescriptor['kind'], GeometryRef> = {
  box,
  sphere,
  gltf,
  baked,
  array: arrayGeometryRef(box, 3, [1, 0, 0]),
  mirror: mirrorGeometryRef(box, 'x', 0),
  subset: arrayGeometryRef(box, 2, [1, 0, 0]), // a generator stands in; see the note below
  bevel: arrayGeometryRef(sphere, 2, [1, 0, 0]),
  uvProject: arrayGeometryRef(box, 2, [0, 1, 0]),
};

/** Composed refs over BUFFER sources — where a count and a buffer are most likely to diverge. */
const COMPOSED: [string, GeometryRef][] = [
  ['array(gltf)', arrayGeometryRef(gltf, 3, [1, 0, 0])],
  ['mirror(gltf)', mirrorGeometryRef(gltf, 'x', 0)],
  ['array(baked)', arrayGeometryRef(baked, 3, [1, 0, 0])],
  ['mirror(baked)', mirrorGeometryRef(baked, 'x', 0)],
];

/** Does this ref have BOTH a derivable edge count and unreadable geometry? */
function dangerous(ref: GeometryRef): boolean {
  const count = componentCountOf('edge', ref.descriptor);
  if (count.kind !== 'counted') return false;
  try {
    return getForRead(ref) === null;
  } catch {
    return true; // a throw on the read road is at least as bad as a null
  }
}

describe('#1039 — a derivable edge count implies readable geometry', () => {
  it('covers every descriptor kind the substrate has', () => {
    // The list is scanned, so this reds when a kind is added and not represented here.
    expect(Object.keys(REPRESENTATIVE).sort()).toEqual(scannedKinds());
    expect(scannedKinds().length).toBeGreaterThan(5); // the scan found a real switch
  });

  it('🔴 no descriptor can both state an edge count and refuse to build', () => {
    const rows: [string, GeometryRef][] = [...Object.entries(REPRESENTATIVE), ...COMPOSED];

    // POSITIVE CONTROL — the detector must be able to SAY yes. Without this row a green here
    // is indistinguishable from a predicate that can only ever answer `false`, which is the
    // failure mode this whole file exists to avoid in other people's gates.
    const liar: GeometryRef = { key: 'liar', descriptor: box.descriptor };
    expect(
      dangerous(liar) === false,
      'control: a box is safe, so the predicate is not answering true for everything',
    ).toBe(true);
    const forced = { ...box, key: 'forced' };
    expect(
      componentCountOf('edge', forced.descriptor).kind,
      'control: a box DOES state an edge count, so the first half of the predicate is live',
    ).toBe('counted');
    expect(
      getForRead(gltf),
      'control: an unmounted clone IS unreadable, so the second half is live',
    ).toBeNull();

    const bad = rows.filter(([, ref]) => dangerous(ref)).map(([label]) => label);
    expect(rows.length, 'control: the census examined every row').toBe(13);
    expect(
      bad,
      'A descriptor now states an edge count while its geometry cannot be read. That combination ' +
        "is what makes `resolveComponentSelection`'s angle arm reach `refuse()`, which THROWS " +
        'inside `evaluate` on the render walk. Fix the arm the way #862 fixed its sibling — ' +
        'resolve to an empty/waiting selection when the cause is "not readable yet" — rather ' +
        'than re-closing the gap that used to hide this.',
    ).toEqual([]);
  });
});
