// THE PARAM->SECTION ROUTING GATE (#394, PLAN-3 P6a).
//
// Every declared param of every registered node type, and the section it routes to.
// 361 cells, frozen in `paramHomeGolden.ts` (410 before #365 Phase 5 deleted seven fused types).
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
// ── THE ONE LINE THAT MOVED AT P6b ──────────────────────────────────────────────────
//
// `homeOf` below is the production seam. At P6a it called `paramToSection(key, declared)`,
// the if-chain. At P6b it calls the `home`-backed resolver, and the golden was NOT touched
// in that commit — so all 90 lines and both totals passing is the evidence that the swap
// preserved every one of the 410 cells.
//
// The collision block below WAS re-anchored at P6b, and deliberately: it had been written
// against synthetic section lists, a shape that stopped existing when routing became
// node-based. It now names real registered node types, which is strictly stronger. The
// reachability block is new at P6b — it is the cost of decentralizing, priced in.
//
// REF: PLAN-3 §4 P6 and §5 gates 1/4; src/app/inspectorSections.ts; src/app/exposeParams.gate.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { getNodeType, listNodeTypes } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { isSectionId, paramToSection, type SectionId } from './inspectorSections';
import { declaredParamKeys } from './inspectorSectionBody';
import { GOLDEN_PARAM_HOMES, GOLDEN_TOTALS } from './paramHomeGolden';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const UNROUTED = '(unrouted)';

/** THE PRODUCTION SEAM. Repointed at P6b from the if-chain to the `home`-backed
 *  resolver. The golden and every assertion below were NOT touched in that commit —
 *  that is what makes a green run here evidence of byte-identity across the swap. */
function homeOf(nodeType: string, paramKey: string, declared: readonly SectionId[]) {
  return paramToSection(paramKey, declared, nodeType);
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
  // The measured reason PLAN-3 §3.4 gives for decentralizing: the same param key lands on
  // DIFFERENT cards depending on the node. TWO keys do this today — `lookAt` and `color`.
  // It was three until #599 deleted the fused camera and left `roll` with a single owner;
  // the count shrinks as the split completes, because a fused node routing a lens param to
  // 'transform' was itself one half of most of these collisions.
  //
  // RE-ANCHORED AT P6b, AND STRICTER. These were written against hypothetical section
  // lists (`paramToSection('color', ['light'])`) — a shape that stopped existing when
  // routing became node-based, and one that never proved any REAL node disambiguates.
  // They now name registered node types, so the assertion is about the shipped `home`
  // tables rather than about a signature.
  const routes = (nodeType: string, key: string) =>
    homeOf(nodeType, key, declaredSectionsOf(nodeType));

  it('lookAt lands on two different cards, on two real nodes', () => {
    // This was a THREE-way collision, and it shrank exactly as the previous note here
    // predicted. The fused AreaLight held the 'transform' corner until #365 Phase 5 deleted
    // it; PerspectiveCamera was the last registered node routing `lookAt` there, and #599
    // deleted that too. Two owners is the real count now, and re-inflating it to three would
    // mean inventing a node to satisfy the fixture rather than recording the shipped tables.
    // The claim the case exists to make survives at two: `lookAt` still lands on different
    // cards on different nodes, so a per-node home is still what disambiguates it.
    expect(routes('CameraData', 'lookAt')).toBe('camera');
    expect(routes('LightData', 'lookAt')).toBe('light');
  });
  // `roll` was the second collision, PerspectiveCamera('transform') against
  // CameraData('camera'). With the fused camera deleted (#599), CameraData is its only owner
  // — so `roll` does not collide at all any more and there is nothing left for a case to
  // assert. It is dropped rather than reduced to a single-node routing check, which would be
  // a weaker duplicate of the frozen golden row that already pins it.
  it('color lands on two different cards, on two real nodes', () => {
    expect(routes('MaterialOverride', 'color')).toBe('material');
    expect(routes('LightData', 'color')).toBe('light');
  });
  it('a node that declares no home for a key does not claim it', () => {
    // The old chain answered this by every arm testing `declaredSections.includes(...)`.
    // The table answers it by absence — assert the absence is real, not accidental.
    expect(routes('ArrayModifier', 'color')).toBeNull();
    expect(routes('ArrayModifier', 'lookAt')).toBeNull();
    // AmbientLight declares `color` and no home for it — the surviving unsplit light, and a
    // real node rather than a hypothetical section list.
    expect(routes('AmbientLight', 'color')).toBeNull();
  });
});

describe('every declared home is reachable (PLAN-3 §5 gate 4)', () => {
  // The cost of decentralizing: the table stops being centrally auditable, so the thing
  // that used to be impossible by construction — routing a param to a card this node does
  // not draw — becomes merely a typo. `rowsForNode` emits rows by walking the DECLARED
  // sections, so such a row is never emitted and the param VANISHES from the inspector.
  // The resolver degrades it to unrouted (visible) as a backstop; this is the gate that
  // means the backstop should never fire.
  it.each(Object.keys(GOLDEN_PARAM_HOMES).sort())('%s declares no unreachable home', (t) => {
    const declared = declaredSectionsOf(t);
    const params = declaredParamKeys(t);
    for (const [key, section] of Object.entries(getNodeType(t)?.home ?? {})) {
      expect(
        { key, section, isSectionId: isSectionId(section) },
        `${t}.home.${key} names '${section}'`,
      ).toMatchObject({ isSectionId: true });
      expect(
        declared,
        `${t}.home.${key} routes to '${section}', which ${t} does not declare`,
      ).toContain(section);
      expect(params, `${t}.home.${key} homes a param ${t} does not declare`).toContain(key);
    }
  });
});
