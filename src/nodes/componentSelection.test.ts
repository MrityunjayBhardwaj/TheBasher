// ns-2 step 9 (#607, #660) — the resolver, the parser, the canonicaliser, and the three
// degenerate cases that are DECIDED here rather than looked up.
//
// The reference does not document what an empty or unmatched Group field means, and it does
// not document how `!` and `^` compose. Both were checked; neither is stated. So the rows
// below are the contract, minted rather than found, and they are what a later reader should
// argue with — not the module's prose.
//
// REF: src/nodes/componentSelection.ts; ref/houdini/SOP.md §4; issues #607, #660.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetSelectionMemoForTests,
  canonicalScopeQuery,
  resolveComponentSelection,
  totalSelection,
  SCOPE_PARAM,
  type ComponentSelection,
} from './componentSelection';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';
import { faceCountOf } from '../app/faceCount';
import type { ObjectData } from './types';

/** A twelve-face box on the data lane — the population every row below resolves against. */
const BOX: ObjectData = {
  kind: 'MeshData',
  geometry: { key: 'box|1,1,1', descriptor: { kind: 'box', size: [1, 1, 1] } },
  material: null,
};

/** A gltf source: real, reachable, and with NO derivable face count. */
const GLTF: ObjectData = {
  kind: 'BakedData',
  geometry: { key: 'baked|dead-8', descriptor: { kind: 'baked', hash: 'dead', vertexCount: 8 } },
  material: null,
};

/**
 * A camera — an `ObjectData` member that carries no mesh at all.
 *
 * Written out in full rather than cast through `as unknown as`. A fixture that reaches the
 * union through a cast can carry fields that disagree with each other, and the reading it
 * produces is then an artifact of the cast rather than a fact about the code.
 */
const CAMERA: ObjectData = {
  kind: 'CameraData',
  projection: 'Perspective',
  fov: 50,
  zoom: 1,
  near: 0.1,
  far: 500,
  sensorSize: 36,
  dofEnabled: false,
  focusDistance: 10,
  fStop: 2.8,
  focusOnTarget: false,
  lookAt: [0, 0, 0],
  roll: 0,
};

const scope = (query: string): ComponentSelection =>
  resolveComponentSelection(BOX, { [SCOPE_PARAM]: query });

/** The selected indices, read only through the accessor. */
const selected = (s: ComponentSelection): number[] =>
  Array.from({ length: s.length }, (_, i) => i).filter((i) => s.has(i));

beforeEach(() => {
  // The memo never evicts, so without this a growth- or identity-shaped row reads the
  // previous case's state and passes or fails by the order the file happens to be written.
  __resetSelectionMemoForTests();
});

describe('#607 the three degenerate cases, decided here', () => {
  it('NO scope param at all selects everything', () => {
    const s = resolveComponentSelection(BOX, {});
    expect({ count: s.count, length: s.length, domain: s.domain }).toEqual({
      count: 12,
      length: 12,
      domain: 'face',
    });
    expect(s.has(0)).toBe(true);
    expect(s.has(11)).toBe(true);
  });

  it('a query resolving to ZERO elements selects nothing — and is distinct BY VALUE from a total', () => {
    // Asserted as its own row rather than as "not everything". A collapse and a default
    // agree on every degenerate population, so the two ends have to be pinned separately.
    const nothing = scope('50-99'); // wholly outside a twelve-face box
    expect({ count: nothing.count, length: nothing.length }).toEqual({ count: 0, length: 12 });
    expect(nothing.has(0)).toBe(false);

    const everything = resolveComponentSelection(BOX, {});
    expect(nothing.count).not.toBe(everything.count);
  });

  it('an UNRESOLVABLE query throws BY NAME — it never falls back to everything', () => {
    // The row that matters most. A lost scope silently meaning "everything" applies the
    // operation to the whole mesh, which is the loudest wrong answer with the quietest
    // failure. The throw is asserted, and so is the fact that it names the offending text.
    expect(() => scope('not-a-range!!')).toThrow(/componentSelection/);
    expect(() => scope('@v>0')).toThrow(/attribute expressions are not implemented/);
    expect(() => scope('arm*')).toThrow(/wildcards are not implemented/);
    expect(() => scope('head')).toThrow(/named groups are not implemented/);
    expect(() => scope('5-2')).toThrow(/inverted range/);
    expect(() => scope('0-10:0')).toThrow(/step must be at least 1/);
  });

  it('a BLANK query is an absent one, not an unresolvable one', () => {
    // The empty Group field the reference leaves opaque. Decided: blank means no filter,
    // which is what a blank field means in every authoring surface anyone has used.
    expect(resolveComponentSelection(BOX, { [SCOPE_PARAM]: '' }).count).toBe(12);
    expect(resolveComponentSelection(BOX, { [SCOPE_PARAM]: '   ' }).count).toBe(12);
  });
});

describe('#607 a selection cannot be built against a count that does not exist', () => {
  it('refuses a descriptor with no derivable face count, by name', () => {
    // Pre-mortem 2. Without this the selection would be built at length 0 — a "scope
    // nothing" on a mesh the author can see, with faces they can count.
    expect(() => resolveComponentSelection(GLTF, {})).toThrow(/no derivable face count/);
    expect(() => resolveComponentSelection(GLTF, { [SCOPE_PARAM]: '0-5' })).toThrow(
      /no derivable face count/,
    );
  });

  it('refuses a value that has no mesh components at all, by name', () => {
    expect(() => resolveComponentSelection(CAMERA, {})).toThrow(/has no mesh components/);
  });

  it('and this is NOT `faceAttributeMismatch` — measured, because the plan named it', () => {
    // ns-2's step-9 pre-mortem said this refusal would make `faceAttributeMismatch` live
    // for the first time. It cannot: that guard returns `null` — "no objection" — for every
    // count whenever `faceCountOf` is null, which is exactly the case being refused here.
    // Recorded as a row so the claim is not re-inherited from the plan.
    expect(() => resolveComponentSelection(GLTF, {})).toThrow();
  });
});

describe('#607 the resolved selection exposes no buffer', () => {
  it('has exactly four members, none of them an array', () => {
    // What makes the memoized total safe to share. A reader that mutated it would corrupt
    // every other operator's scope, so the buffer has no constructor rather than a rule.
    const s = scope('0-5');
    expect(Object.keys(s).sort()).toEqual(['count', 'domain', 'has', 'length']);
    for (const name of Object.getOwnPropertyNames(s)) {
      const value = (s as unknown as Record<string, unknown>)[name];
      expect(ArrayBuffer.isView(value)).toBe(false);
      expect(Array.isArray(value)).toBe(false);
    }
  });

  it('and the total selection is the SAME object at one (domain, length)', () => {
    expect(totalSelection('face', 12)).toBe(totalSelection('face', 12));
    expect(totalSelection('face', 12)).not.toBe(totalSelection('face', 24));
    expect(totalSelection('face', 12)).not.toBe(totalSelection('point', 12));
  });

  it('and the reset actually empties the memo', () => {
    // The reset is only worth shipping if it works; a no-op reset is worse than none,
    // because every later row would trust it.
    const before = totalSelection('face', 12);
    __resetSelectionMemoForTests();
    expect(totalSelection('face', 12)).not.toBe(before);
  });
});

describe('#607 the query language, as decided', () => {
  it('reads ranges, single indices, steps and both operators', () => {
    expect(selected(scope('0-3'))).toEqual([0, 1, 2, 3]);
    expect(selected(scope('0 2 4'))).toEqual([0, 2, 4]);
    expect(selected(scope('0-11:3'))).toEqual([0, 3, 6, 9]);
    expect(selected(scope('0-5 ^2-3'))).toEqual([0, 1, 4, 5]);
    expect(selected(scope('!0-5'))).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it('accumulates LEFT TO RIGHT, which is why the operators do not commute', () => {
    // The composition rule the reference does not state. Pinned in the form that shows it
    // is an ORDER, not a set of independent filters.
    expect(selected(scope('0-5 ^2'))).toEqual([0, 1, 3, 4, 5]);
    expect(selected(scope('^2 0-5'))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('drops out-of-range indices instead of refusing them', () => {
    expect(selected(scope('9-99'))).toEqual([9, 10, 11]);
  });

  it('treats whitespace and commas alike, because a separator carries no meaning', () => {
    expect(selected(scope('0,2,4'))).toEqual(selected(scope('0 2 4')));
  });
});

describe('#607 the canonicaliser, pinned in BOTH directions', () => {
  const QUERIES = [
    '0-5',
    '5,4,3,2,1,0',
    '0 1 2 3 4 5',
    '0-2 3-5',
    '0-11',
    '!6-11',
    '!0-5',
    '0-11:2',
    '0-11:3',
    '0-5 ^2',
    '^2 0-5',
    '6-11',
    '0-5 6-11',
    '3',
    '3 3 3',
    '0-5 ^2-3 ^4',
  ];
  const LENGTHS = [6, 12, 24, 48];

  it('collapses the spellings the plan named — the injective-downward half', () => {
    expect(canonicalScopeQuery('5,4,3,2,1,0')).toBe('0-5');
    expect(canonicalScopeQuery('0-5')).toBe('0-5');
    expect(canonicalScopeQuery('0-2 3-5')).toBe('0-5');
    expect(canonicalScopeQuery('3 3 3')).toBe('3');
  });

  it('PRESERVES MEANING — canonicalising a query never changes what it resolves to', () => {
    // The property the coalescing above could quietly break, and the one that makes the
    // soundness row below follow rather than be hoped for. Quantified over N lengths and
    // ITERATED over N, because a loop over one axis is blind along a second collapsed to a
    // single sample.
    for (const q of QUERIES) {
      for (const length of LENGTHS) {
        const direct = selected(resolveAt(q, length));
        const viaCanonical = selected(resolveAt(canonicalScopeQuery(q), length));
        expect({ q, length, sel: viaCanonical }).toEqual({ q, length, sel: direct });
      }
    }
  });

  it('IS SOUND — two queries with one canonical form resolve alike at every length', () => {
    // 🔴 The half that had no assertion anywhere before this commit, and the half that is a
    // BUG rather than a waste: over-coalescing merges two different scopes onto one cached
    // geometry, so the wrong mesh draws. Every pair is checked, not a sample.
    let comparedPairs = 0;
    for (let i = 0; i < QUERIES.length; i += 1) {
      for (let j = i + 1; j < QUERIES.length; j += 1) {
        if (canonicalScopeQuery(QUERIES[i]) !== canonicalScopeQuery(QUERIES[j])) continue;
        for (const length of LENGTHS) {
          comparedPairs += 1;
          expect({
            a: QUERIES[i],
            b: QUERIES[j],
            length,
            sel: selected(resolveAt(QUERIES[i], length)),
          }).toEqual({
            a: QUERIES[i],
            b: QUERIES[j],
            length,
            sel: selected(resolveAt(QUERIES[j], length)),
          });
        }
      }
    }
    // A property test over pairs that share nothing compares nothing and passes. The count
    // is asserted so a green here means the loop had work to do.
    expect(comparedPairs).toBeGreaterThan(0);
  });

  it('is NOT total, and the counter-example is pinned rather than described', () => {
    // `0-5` and `!6-11` name the same six faces of a twelve-face box and cannot be
    // recognised as equal without knowing the box has twelve faces — which the canonicaliser
    // deliberately does not, because folding a resolved mask is O(elements) on the drag road.
    // They mint two cached geometries. That is accepted, and it is written as a literal so
    // that "make canonicalisation total" is a decision someone takes, not a green they get.
    expect(selected(resolveAt('0-5', 12))).toEqual(selected(resolveAt('!6-11', 12)));
    expect(canonicalScopeQuery('0-5')).not.toBe(canonicalScopeQuery('!6-11'));

    // And they are genuinely different queries: at a different length they diverge, which
    // is why coalescing them would be WRONG rather than merely clever.
    expect(selected(resolveAt('0-5', 24))).not.toEqual(selected(resolveAt('!6-11', 24)));
  });
});

describe('#607 the query has exactly one reader', () => {
  it('no production module but the resolver reads the scope param', () => {
    // The whole point of the road: an operator that forgot to parse correctly has no
    // constructor, because it never sees the query. `examined` is reported beside `found`,
    // since a clean zero from a walk that never descended reads like a healthy repo.
    const files = sourceFiles();
    const readers = files
      .filter(([, src]) =>
        /\bSCOPE_PARAM\b|params\s*(?:\.\s*scope\b|\[\s*['"]scope['"]\s*\])/.test(
          stripComments(src),
        ),
      )
      .map(([path]) => path);

    expect({ examined: files.length, readers }).toEqual({
      examined: files.length,
      readers: ['src/nodes/componentSelection.ts'],
    });
    expect(files.length).toBeGreaterThan(500);
  });

  it('and the parser is not exported, so a second reader has no import to reach', () => {
    // Stated as the module's export list. If the parser is ever exported this reds in the
    // same commit that exported it, rather than in the commit that starts using it.
    const module = sourceFiles().find(([p]) => p === 'src/nodes/componentSelection.ts')![1];
    const exported = [
      ...stripComments(module).matchAll(/export (?:const|function|interface|type) (\w+)/g),
    ]
      .map((m) => m[1])
      .sort();
    expect(exported).toEqual([
      'ComponentSelection',
      'SCOPE_PARAM',
      '__resetSelectionMemoForTests',
      'canonicalScopeQuery',
      'componentCountOf',
      'resolveComponentSelection',
      'totalSelection',
    ]);
  });
});

/**
 * Resolve `query` against a mesh with EXACTLY `faces` faces, through the real resolver.
 *
 * A sphere tessellates to `2 * w * (h - 1)`, so `h = 2` and `w = faces / 2` gives any even
 * count from six up (three.js clamps `w` to its own minimum of 3, and `faceCountOf` clamps
 * with it). The produced count is ASSERTED rather than assumed — a fixture that quietly
 * built a different mesh than the one named would invert every row that reads it.
 */
function resolveAt(query: string, faces: number): ComponentSelection {
  expect(faces % 2 === 0 && faces >= 6).toBe(true);
  const descriptor = {
    kind: 'sphere' as const,
    radius: 1,
    widthSegments: faces / 2,
    heightSegments: 2,
  };
  expect(faceCountOf(descriptor)).toBe(faces);
  const spine: ObjectData = {
    kind: 'MeshData',
    geometry: { key: `sphere|${faces}`, descriptor },
    material: null,
  };
  return resolveComponentSelection(spine, query === '' ? {} : { [SCOPE_PARAM]: query });
}
