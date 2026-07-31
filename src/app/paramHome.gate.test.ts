// THE PARAM->SECTION ROUTING GATE (#394, PLAN-3 P6a).
//
// Every declared param of every registered node type, and the section it routes to.
// 410 cells, frozen in `paramHomeGolden.ts`.
//
// ── WHY THIS GATE EXISTS ────────────────────────────────────────────────────────────
//
// P6 moves param->section routing off `paramToSection`'s central if-chain onto per-node
// `home` declarations. PLAN-3 §4 P6 says the P1 byte-identical gate is what makes that
// swap safe. IT IS NOT, and this was MEASURED before building rather than assumed:
// deleting `radius` from the mesh routing arm — a real defect, `radius` leaves the Mesh
// section for the unrouted bucket on both SphereData and SphereMesh — left
//
//     exposeParams.gate.test.ts   14/14 green
//     the section suite           50/50 green
//     the whole tracked tier      3320/281 green
//
// The cause is written down in that gate's own header: it deliberately SHARES
// `paramToSection` with the subject ("today's behaviour, unchanged by this stage"). So on
// the routing dimension it asserts `f == f`. It pins the WALK — which nodes contribute
// rows, in what order — and never the DESTINATION. P6 changes exactly the dimension it
// does not cover.
//
// Coverage before this file: of 67 distinct routed param keys, 22 had an explicit
// destination assertion (9 camera + 12 light + `color`, in inspectorSections.test.ts).
// The other 45 — every transform, mesh, render, animate, channel, curve, modifier,
// environment and layout key — had none.
//
// ── WHY THE EXPECTATION IS FROZEN BYTES ─────────────────────────────────────────────
//
// `paramHomeGolden.ts` was GENERATED ONCE from the pre-P6 if-chain and committed as data.
// It is never regenerated from the subject. That is the whole point: a golden produced by
// the OLD implementation is a valid oracle for the NEW one, where sharing a live call to
// the function being replaced is not. Regenerating it to make this file pass destroys the
// only evidence that the swap preserved behaviour.
//
// A legitimate new param, or a deliberate re-home, edits the golden IN THE SAME COMMIT as
// the change, and the diff names the cell — which is the review surface this table exists
// to provide.
//
// ── THE ONE LINE THAT MOVES AT P6b ──────────────────────────────────────────────────
//
// `homeOf` below is the production seam. At P6a it calls `paramToSection(key, declared)`.
// At P6b it calls the `home`-backed resolver instead, and NOTHING else in this file
// changes — the golden is untouched, so byte-identity across the swap is what a green run
// means.
//
// REF: PLAN-3 §4 P6 and §5 gates 1/4; src/app/inspectorSections.ts; src/app/exposeParams.gate.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { getNodeType, listNodeTypes } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { paramToSection, type SectionId } from './inspectorSections';
import { declaredParamKeys } from './inspectorSectionBody';
import { GOLDEN_PARAM_HOMES, GOLDEN_TOTALS } from './paramHomeGolden';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const UNROUTED = '(unrouted)';

/** THE PRODUCTION SEAM. P6b repoints this at the `home`-backed resolver; the golden and
 *  every assertion below stay exactly as they are. */
function homeOf(nodeType: string, paramKey: string, declared: readonly SectionId[]) {
  void nodeType;
  return paramToSection(paramKey, declared);
}

function declaredSectionsOf(nodeType: string): readonly SectionId[] {
  return (getNodeType(nodeType)?.inspectorSections ?? []) as readonly SectionId[];
}

/** One node type's whole routing row, in the golden's format. */
function lineFor(nodeType: string): string {
  const declared = declaredSectionsOf(nodeType);
  const cells = declaredParamKeys(nodeType).map(
    (k) => `${k}=${homeOf(nodeType, k, declared) ?? UNROUTED}`,
  );
  return `[${declared.join(',')}]${cells.length ? ' ' + cells.join(' ') : ''}`;
}

describe('param->section routing is pinned cell by cell', () => {
  it('the registry actually seeded — the comparison has a subject', () => {
    // H219: a table-comparison gate is worthless if both sides can empty together. If
    // registration silently no-ops, every line below becomes '[] == []' and passes.
    const types = listNodeTypes();
    expect(types.length).toBeGreaterThan(50);
    expect(types).toContain('SphereData');
    expect(declaredParamKeys('SphereData').length).toBeGreaterThan(0);
    expect(Object.keys(GOLDEN_PARAM_HOMES).length).toBeGreaterThan(50);
  });

  it('every registered node type appears in the golden, and vice versa', () => {
    // Both directions: a new node type must declare its homes (it cannot slip in
    // unrouted-by-default), and a deleted one must leave the table.
    expect([...listNodeTypes()].sort()).toEqual(Object.keys(GOLDEN_PARAM_HOMES).sort());
  });

  it.each(Object.keys(GOLDEN_PARAM_HOMES).sort())('%s routes exactly as frozen', (nodeType) => {
    expect(lineFor(nodeType)).toBe(GOLDEN_PARAM_HOMES[nodeType]);
  });

  it('the routed/unrouted split is what the golden recorded', () => {
    // H246 — the property here is HOW MANY, so assert the count, not just the shape. A
    // change that re-homed one param and unrouted another would keep every line's length
    // and still be caught above; this catches the coarser "the router stopped routing".
    let routed = 0;
    let unrouted = 0;
    for (const nodeType of listNodeTypes()) {
      const declared = declaredSectionsOf(nodeType);
      for (const k of declaredParamKeys(nodeType)) {
        if (homeOf(nodeType, k, declared) === null) unrouted++;
        else routed++;
      }
    }
    expect({ types: listNodeTypes().length, routed, unrouted }).toEqual(GOLDEN_TOTALS);
  });
});

describe('the collisions that make per-node homes necessary', () => {
  // The measured reason PLAN-3 §3.4 gives for decentralizing: the same param key routes
  // to DIFFERENT sections depending on what the node declares. Three keys do this today.
  // Pinned so P6b cannot quietly collapse one — a `home` table resolves these by
  // construction, and this is what "by construction" has to keep meaning.
  it('lookAt routes three ways', () => {
    expect(paramToSection('lookAt', ['transform'])).toBe('transform');
    expect(paramToSection('lookAt', ['camera'])).toBe('camera');
    expect(paramToSection('lookAt', ['light'])).toBe('light');
  });
  it('roll routes two ways', () => {
    expect(paramToSection('roll', ['transform'])).toBe('transform');
    expect(paramToSection('roll', ['camera'])).toBe('camera');
  });
  it('color routes two ways', () => {
    expect(paramToSection('color', ['material'])).toBe('material');
    expect(paramToSection('color', ['light'])).toBe('light');
  });
  it('and a node declaring neither claims none of them', () => {
    expect(paramToSection('color', ['driver'])).toBeNull();
    expect(paramToSection('lookAt', ['driver'])).toBeNull();
    expect(paramToSection('roll', ['driver'])).toBeNull();
  });
});
