// agent.identify unit tests.
//
// Match strategies (exact-id, selection, type-filter, color/param) +
// confidence derivation (P-6 mitigation) + ambiguity branch.
//
// REF: P2.5.2 PLAN §5 Wave B; vyapti V13.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { identify } from './identify';
import { COMMIT_THRESHOLD, deriveConfidence } from './confidence';
import { shouldRunIdentifyRound } from '../orchestrator';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function buildScene(): DagState {
  // Three cubes (red, green, blue) + one sphere + scene aggregator.
  let s = emptyDagState();
  const cubes = [
    { id: 'redCube', color: '#ff0000', pos: [0, 0, 0] },
    { id: 'greenCube', color: '#00ff00', pos: [2, 0, 0] },
    { id: 'blueCube', color: '#0000ff', pos: [4, 0, 0] },
  ];
  for (const c of cubes) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: c.id,
      nodeType: 'BoxMesh',
      params: {
        size: [1, 1, 1],
        position: c.pos,
        rotation: [0, 0, 0],
        material: { name: 'default', color: c.color },
      },
    }).next;
  }
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'sphere1',
    nodeType: 'SphereMesh',
    params: { radius: 1, position: [0, 2, 0] },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  return s;
}

// ---------------------------------------------------------------------------
// confidence.ts
// ---------------------------------------------------------------------------

describe('deriveConfidence (P-6 mitigation)', () => {
  it('exactly 1 candidate → 1.0', () => {
    expect(
      deriveConfidence({
        candidates: [{ id: 'a', nodeType: 'BoxMesh' }],
        typeConsistent: true,
      }),
    ).toBe(1.0);
  });

  it('2-3 type-consistent candidates → 0.6', () => {
    const cs = [
      { id: 'a', nodeType: 'BoxMesh' },
      { id: 'b', nodeType: 'BoxMesh' },
      { id: 'c', nodeType: 'BoxMesh' },
    ];
    expect(deriveConfidence({ candidates: cs, typeConsistent: true })).toBe(0.6);
  });

  it('>3 candidates → 0.3 even when type-consistent', () => {
    const cs = Array.from({ length: 5 }, (_, i) => ({
      id: `n${i}`,
      nodeType: 'BoxMesh',
    }));
    expect(deriveConfidence({ candidates: cs, typeConsistent: true })).toBe(0.3);
  });

  it('type-inconsistent candidates → 0.3', () => {
    const cs = [
      { id: 'a', nodeType: 'BoxMesh' },
      { id: 'b', nodeType: 'SphereMesh' },
    ];
    expect(deriveConfidence({ candidates: cs, typeConsistent: false })).toBe(0.3);
  });

  it('zero candidates → 0', () => {
    expect(deriveConfidence({ candidates: [], typeConsistent: false })).toBe(0);
  });

  it('COMMIT_THRESHOLD is 0.7 — single match commits, ambiguous does not', () => {
    expect(COMMIT_THRESHOLD).toBe(0.7);
    expect(1.0 >= COMMIT_THRESHOLD).toBe(true);
    expect(0.6 >= COMMIT_THRESHOLD).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// identify resolver
// ---------------------------------------------------------------------------

describe('identify — match strategies', () => {
  it('exact node-id match → confidence 1.0, strategy "exact-id"', () => {
    const state = buildScene();
    const r = identify({ query: 'redCube' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.confidence).toBe(1.0);
      expect(r.selectors).toEqual(['redCube']);
      expect(r.strategy).toBe('exact-id');
    }
  });

  it('"selected" with one selected id → match with confidence 1.0', () => {
    const state = buildScene();
    const r = identify({ query: 'selected' }, state, new Set(['greenCube']));
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.selectors).toEqual(['greenCube']);
      expect(r.strategy).toBe('selection');
    }
  });

  it('"selected" with empty selection → no-match', () => {
    const state = buildScene();
    const r = identify({ query: 'selected' }, state, new Set());
    expect(r.type).toBe('no-match');
  });

  it('"selected" with two selected ids commits both (selection is allowed multi)', () => {
    const state = buildScene();
    // Two-id selection — selection strategy keeps all of them. Wave A's
    // closure infers from the union.
    const r = identify(
      { query: 'selected' },
      state,
      new Set(['redCube', 'greenCube']),
    );
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.selectors).toEqual(expect.arrayContaining(['redCube', 'greenCube']));
    }
  });

  it('"the cube" with three cubes → ambiguous (n=3 type-matched, conf 0.6)', () => {
    const state = buildScene();
    const r = identify({ query: 'the cube' }, state);
    expect(r.type).toBe('ambiguous');
    if (r.type === 'ambiguous') {
      expect(r.candidates).toHaveLength(3);
    }
  });

  it('"the green cube" → match (color narrows to one)', () => {
    const state = buildScene();
    const r = identify({ query: 'the green cube' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.selectors).toEqual(['greenCube']);
    }
  });

  it('"sphere" with one SphereMesh → match', () => {
    const state = buildScene();
    const r = identify({ query: 'sphere' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.selectors).toEqual(['sphere1']);
    }
  });

  it('explicit hex "#00ff00" → matches greenCube', () => {
    const state = buildScene();
    const r = identify({ query: 'the #00ff00 cube' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') expect(r.selectors).toEqual(['greenCube']);
  });

  it('color word with no matching node → no-match', () => {
    const state = buildScene();
    const r = identify({ query: 'the orange cube' }, state);
    expect(r.type).toBe('no-match');
  });

  it('hint "multiple-allowed" commits even at high candidate count', () => {
    const state = buildScene();
    const r = identify({ query: 'cube', hint: 'multiple-allowed' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') expect(r.selectors).toHaveLength(3);
  });

  it('filter.types narrows to specific node types', () => {
    const state = buildScene();
    // Without filter "red" alone has no resolver; with filter we can target
    // BoxMesh and the color filter narrows to redCube.
    const r = identify({ query: 'red', filter: { types: ['BoxMesh'] } }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') expect(r.selectors).toEqual(['redCube']);
  });

  it('totally unresolvable query → no-match with rationale', () => {
    const state = buildScene();
    const r = identify({ query: 'flux capacitor' }, state);
    expect(r.type).toBe('no-match');
    if (r.type === 'no-match') {
      expect(r.rationale.length).toBeGreaterThan(0);
    }
  });

  it('deterministic: same inputs → same result shape', () => {
    const state = buildScene();
    const a = identify({ query: 'the green cube' }, state);
    const b = identify({ query: 'the green cube' }, state);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// shouldRunIdentifyRound heuristic (P-3 mitigation)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wave A — Identify-v2 (#24 quantifiers + #25 generic nouns)
// ---------------------------------------------------------------------------

describe('identify — quantifiers (#24)', () => {
  it('"each cube" → match with all cubes (multi-target)', () => {
    const state = buildScene();
    const r = identify({ query: 'each cube' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.selectors).toHaveLength(3);
      expect(new Set(r.selectors)).toEqual(new Set(['redCube', 'greenCube', 'blueCube']));
    }
  });

  it('"all spheres" → match with the sphere', () => {
    const state = buildScene();
    const r = identify({ query: 'all spheres' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.selectors).toEqual(['sphere1']);
    }
  });

  it('"every cube" → match with all cubes', () => {
    const state = buildScene();
    const r = identify({ query: 'every cube' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.selectors).toHaveLength(3);
    }
  });

  it('"both cubes" with 2 cubes → match (plural-after-the without "the")', () => {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'cube1',
      nodeType: 'BoxMesh',
      params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'cube2',
      nodeType: 'BoxMesh',
      params: { size: [1, 1, 1], position: [2, 0, 0], rotation: [0, 0, 0] },
    }).next;
    const r = identify({ query: 'both cubes' }, s);
    expect(r.type).toBe('match');
    if (r.type === 'match') expect(r.selectors).toHaveLength(2);
  });

  it('"the cubes" (bare plural) → match with all cubes', () => {
    const state = buildScene();
    const r = identify({ query: 'the cubes' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') expect(r.selectors).toHaveLength(3);
  });

  it('"ball" alone (no quantifier) does NOT trigger multi-target promotion', () => {
    // "ball" matches the sphere alias but isn't a quantifier — singular
    // resolution. Only one sphere exists so this is unambiguous either
    // way; the test pins the behavior.
    const state = buildScene();
    const r = identify({ query: 'ball' }, state);
    expect(r.type).toBe('match');
  });
});

describe('identify — generic-noun aliases (#25)', () => {
  it('"each of the objects" resolves to all primitives', () => {
    const state = buildScene();
    const r = identify({ query: 'each of the objects' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      // Scene is excluded; cubes + sphere are visible primitives.
      expect(new Set(r.selectors)).toEqual(
        new Set(['redCube', 'greenCube', 'blueCube', 'sphere1']),
      );
    }
  });

  it('"every thing" → all visible primitives', () => {
    const state = buildScene();
    const r = identify({ query: 'every thing' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') expect(r.selectors.length).toBeGreaterThanOrEqual(4);
  });

  it('"everything" (single word) → all visible primitives', () => {
    const state = buildScene();
    const r = identify({ query: 'everything' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') expect(r.selectors.length).toBeGreaterThanOrEqual(4);
  });

  it('"all of them" → all visible primitives', () => {
    const state = buildScene();
    const r = identify({ query: 'all of them' }, state);
    expect(r.type).toBe('match');
  });

  it('"all nodes" → all visible primitives (pro-mode synonym)', () => {
    const state = buildScene();
    const r = identify({ query: 'all nodes' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') expect(r.selectors.length).toBeGreaterThanOrEqual(4);
  });

  it('exact id "redCube" still wins over generic-noun alias', () => {
    const state = buildScene();
    const r = identify({ query: 'redCube' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') expect(r.selectors).toEqual(['redCube']);
  });
});

describe('shouldRunIdentifyRound', () => {
  const empty = new Set<string>();
  const oneSelected = new Set(['box1']);

  it('"add a red cube" → false (purely additive)', () => {
    expect(shouldRunIdentifyRound('add a red cube', empty)).toBe(false);
  });

  it('"make a sphere" → false', () => {
    expect(shouldRunIdentifyRound('make a sphere', empty)).toBe(false);
  });

  it('"rotate the cube" → true (selective reference)', () => {
    expect(shouldRunIdentifyRound('rotate the cube', empty)).toBe(true);
  });

  it('"rotate selected" → true', () => {
    expect(shouldRunIdentifyRound('rotate selected', oneSelected)).toBe(true);
  });

  it('"rotate this 45 deg" → true (pronoun)', () => {
    expect(shouldRunIdentifyRound('rotate this 45 deg', oneSelected)).toBe(true);
  });

  it('"rotate the box named hero" → true', () => {
    expect(shouldRunIdentifyRound('rotate the box named hero', empty)).toBe(true);
  });

  it('default with no selection and no markers → false', () => {
    expect(shouldRunIdentifyRound('rotate stuff', empty)).toBe(false);
  });

  it('default with selection present → true', () => {
    expect(shouldRunIdentifyRound('rotate stuff', oneSelected)).toBe(true);
  });

  // #15 — verb-noun co-reference (replaces bare \bthe\b trigger)
  it('"delete the cube" → true (delete + cube)', () => {
    expect(shouldRunIdentifyRound('delete the cube', empty)).toBe(true);
  });

  it('"color the sphere red" → true (color + sphere)', () => {
    expect(shouldRunIdentifyRound('color the sphere red', empty)).toBe(true);
  });

  it('"duplicate every cube" → true (duplicate + cube)', () => {
    expect(shouldRunIdentifyRound('duplicate every cube', empty)).toBe(true);
  });

  it('"the cube is broken" → false (no mutation verb, no selection)', () => {
    expect(shouldRunIdentifyRound('the cube is broken', empty)).toBe(false);
  });

  it('"is there a sphere?" → false (no verb, no selection, no markers)', () => {
    expect(shouldRunIdentifyRound('is there a sphere?', empty)).toBe(false);
  });

  it('"create the missing light" → false (additive prefix wins)', () => {
    expect(shouldRunIdentifyRound('create the missing light', empty)).toBe(false);
  });

  it('"place the camera on the wall" → false (no mutation verb in list, no selection)', () => {
    // "place" is intentionally NOT in the verb list — it's ambiguous
    // between additive ("place a camera") and mutating ("move the
    // camera to here"). The user can use a more explicit verb.
    expect(shouldRunIdentifyRound('place the camera on the wall', empty)).toBe(false);
  });
});
