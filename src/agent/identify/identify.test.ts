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
import { makeSplitCube } from '../../test-utils/splitCube';
import { makeSplitSphere } from '../../test-utils/splitSphere';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function buildScene(): DagState {
  // Three split cubes (red, green, blue) + one split sphere + scene aggregator.
  // #365 Phase 5a / #384 Stage C: a cube/sphere is an Object (pose) → BoxData/SphereData
  // (geometry+material). Both the color a query like "the red cube" matches AND the geometry a
  // noun like "sphere" matches live on the data node; identify reaches through `data` to find
  // them (V107). The Object is the scene child the type-filter matches on; the linked data
  // node's type is what separates "cube" (BoxData) from "sphere" (SphereData) post-split.
  let s = emptyDagState();
  const cubes: { id: string; color: string; pos: [number, number, number] }[] = [
    { id: 'redCube', color: '#ff0000', pos: [0, 0, 0] },
    { id: 'greenCube', color: '#00ff00', pos: [2, 0, 0] },
    { id: 'blueCube', color: '#0000ff', pos: [4, 0, 0] },
  ];
  for (const c of cubes) {
    s = makeSplitCube(s, { objectId: c.id, color: c.color, position: c.pos }).state;
  }
  s = makeSplitSphere(s, { objectId: 'sphere1', radius: 1, position: [0, 2, 0] }).state;
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
    const r = identify({ query: 'selected' }, state, new Set(['redCube', 'greenCube']));
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

  it('"sphere" → the split sphere-Object only, NOT the cube-Objects that share nodeType "Object"', () => {
    // #384 Stage C: post-split, cube and sphere are both nodeType 'Object'. "sphere" narrows the
    // Object matches by reaching through `data` to the SphereData, so the 3 cube-Objects (BoxData)
    // are excluded. Without that reach this would match all 4 Objects → ambiguous.
    const state = buildScene();
    const r = identify({ query: 'sphere' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.selectors).toEqual(['sphere1']);
    }
  });

  it('"cube" (control) → the 3 cube-Objects only, NOT the split sphere-Object', () => {
    // The mirror control: the same shared-'Object'-type disambiguation, the other geometry noun.
    // "the cube" over 3 cubes is ambiguous (n=3); assert the candidate SET excludes sphere1.
    const state = buildScene();
    const r = identify({ query: 'cube', hint: 'multiple-allowed' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(new Set(r.selectors)).toEqual(new Set(['redCube', 'greenCube', 'blueCube']));
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
    // the split cube's Object type and the color filter narrows to redCube
    // (identify reaches through `data` to the BoxData's material, V107).
    const r = identify({ query: 'red', filter: { types: ['Object'] } }, state);
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
    s = makeSplitCube(s, { objectId: 'cube1', position: [0, 0, 0] }).state;
    s = makeSplitCube(s, { objectId: 'cube2', position: [2, 0, 0] }).state;
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

  it('"the boxes" (synonym plural-after-the) → match with all cubes', () => {
    // Review #28 gap: pre-fix the regex omitted "boxes" from the
    // "the X{plural}" branch — bare plural fell through to default
    // 'unique' hint and 3+ candidates returned 'ambiguous'.
    const state = buildScene();
    const r = identify({ query: 'rotate the boxes' }, state);
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

// ---------------------------------------------------------------------------
// Wave C — color polish (#16 deterministic inferColor + #18 family match)
// ---------------------------------------------------------------------------

describe('identify — color resolution (#16 + #18)', () => {
  function buildColorScene(): DagState {
    let s = emptyDagState();
    // Pure red, off-red (picker-sampled), pink, light gray — split cubes; the color a
    // query narrows on lives on each cube's BoxData (identify reaches through `data`, V107).
    s = makeSplitCube(s, { objectId: 'pureRed', color: '#ff0000', position: [0, 0, 0] }).state;
    s = makeSplitCube(s, { objectId: 'offRed', color: '#fa0a0a', position: [1, 0, 0] }).state;
    s = makeSplitCube(s, { objectId: 'pink', color: '#ffaaaa', position: [2, 0, 0] }).state;
    s = makeSplitCube(s, { objectId: 'lightGray', color: '#cccccc', position: [3, 0, 0] }).state;
    return s;
  }

  it('"red cube" matches both #ff0000 AND a slightly-off #fa0a0a (#18 fuzzy)', () => {
    const state = buildColorScene();
    const r = identify({ query: 'the red cube', hint: 'multiple-allowed' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      expect(r.selectors).toContain('pureRed');
      expect(r.selectors).toContain('offRed');
      // Pink (#ffaaaa) is high-lightness; should NOT match "red".
      expect(r.selectors).not.toContain('pink');
    }
  });

  it('"red and green cube" → red wins (first-mentioned, deterministic, #16)', () => {
    const state = buildColorScene();
    const r = identify({ query: 'the red and green cube' }, state);
    // No green node exists; "red" wins by position so the resolver
    // narrows by red. pureRed + offRed are red-family.
    expect(r.type).not.toBe('no-match');
    if (r.type === 'match' || r.type === 'ambiguous') {
      const ids = r.type === 'match' ? r.selectors : r.candidates.map((c) => c.id);
      expect(ids.some((id) => id === 'pureRed' || id === 'offRed')).toBe(true);
    }
  });

  it('"green and red cube" → green wins (first-mentioned beats red)', () => {
    const state = buildColorScene();
    const r = identify({ query: 'the green and red cube' }, state);
    // No green-family node — should be no-match (since hadColor && hadType
    // && colorMatched empty → no-match per identify.ts:155-158).
    expect(r.type).toBe('no-match');
  });

  it('exact #ff0000 matches the pure red node (explicit hex passes through)', () => {
    const state = buildColorScene();
    const r = identify({ query: 'cube #ff0000', hint: 'multiple-allowed' }, state);
    expect(r.type).toBe('match');
    if (r.type === 'match') {
      // Family match still pulls offRed too; that's intentional under #18.
      expect(r.selectors).toContain('pureRed');
    }
  });
});

describe('identify — color family saturation bound (#29)', () => {
  // Probe the red/blue/green family boundary explicitly. Pre-#29 the
  // gate was hue≤25° AND |Δl|<0.3 only, so desaturated reds (brown)
  // leaked into "red". #29 adds |Δs|<0.3. Calibration intent: brown
  // REJECTED, salmon STILL matches (salmon is genuinely reddish).
  function familyScene(refHex: string, probeId: string, probeHex: string): DagState {
    let s = emptyDagState();
    s = makeSplitCube(s, { objectId: 'ref', color: refHex, position: [0, 0, 0] }).state;
    s = makeSplitCube(s, { objectId: probeId, color: probeHex, position: [1, 0, 0] }).state;
    return s;
  }
  function matches(refHex: string, family: string, probeId: string, probeHex: string): boolean {
    const r = identify(
      { query: `the ${family} cube`, hint: 'multiple-allowed' },
      familyScene(refHex, probeId, probeHex),
    );
    return r.type === 'match' && r.selectors.includes(probeId);
  }

  // The bug fix: desaturated red must NOT read as "red".
  it('brown (#a52a2a) is NOT in the red family (the #29 fix)', () => {
    expect(matches('#ff0000', 'red', 'brown', '#a52a2a')).toBe(false);
  });
  // The calibration constraint: salmon stays reddish (must NOT regress).
  it('salmon (#fa8072) IS still in the red family (calibration held)', () => {
    expect(matches('#ff0000', 'red', 'salmon', '#fa8072')).toBe(true);
  });
  // Boundary-documentation probes — pin current behavior so a future
  // family-gate change surfaces as a visible diff (acceptance #29).
  it('navy (#000080) vs blue — boundary pinned', () => {
    expect(matches('#0000ff', 'blue', 'navy', '#000080')).toBe(true);
  });
  it('light blue (#add8e6) vs blue — boundary pinned', () => {
    expect(matches('#0000ff', 'blue', 'lightblue', '#add8e6')).toBe(false);
  });
  it('dark green (#006400) vs green — boundary pinned', () => {
    expect(matches('#00ff00', 'green', 'darkgreen', '#006400')).toBe(false);
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

  // #30 — set/change/put dropped from the verb list (additive use
  // dominates their mutation use; over-triggered Identify = latency).
  // These now must NOT trigger:
  it('"set up a sphere" → false (#30: set dropped, additive)', () => {
    expect(shouldRunIdentifyRound('set up a sphere', empty)).toBe(false);
  });
  it('"put a light over there" → false (#30: put dropped, additive)', () => {
    expect(shouldRunIdentifyRound('put a light over there', empty)).toBe(false);
  });
  it('"change tactic and add cubes" → false (#30: change dropped, additive)', () => {
    expect(shouldRunIdentifyRound('change tactic and add cubes', empty)).toBe(false);
  });
  // …and the change must NOT be a blind loosening — retained verbs
  // still bite (proves the gate still triggers on genuine mutation):
  it('"scale the box" → true (retained verb still triggers, #30 control)', () => {
    expect(shouldRunIdentifyRound('scale the box', empty)).toBe(true);
  });
  it('"move the light" → true (retained verb still triggers, #30 control)', () => {
    expect(shouldRunIdentifyRound('move the light', empty)).toBe(true);
  });
});
