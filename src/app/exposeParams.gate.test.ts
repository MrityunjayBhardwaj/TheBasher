// THE BYTE-IDENTICAL PROJECTION GATE (#394, PLAN-3 P1).
//
// `exposeParams` must reproduce EXACTLY the rows the inspector renders today — same set,
// same order — before any UI is pointed at it. This is the safety property that makes the
// later stages (which move NPanel's row-building onto the projection) attemptable at all:
// without it, "the panel looks the same" is an eyeball claim over a large component.
//
// ── WHY THE EXPECTATION IS TRANSCRIBED AND NOT COMPUTED ─────────────────────────────
//
// The expected rows are built HERE, by a hand transcription of NPanel's two row-building
// blocks, and never by calling the subject. A gate that builds its expectation from the
// function under test asserts `f == f` and passes against any defect — measured on this
// very branch at S1a, where both material controls built their expectation by calling the
// schema they were testing and changing every primitive's colour left 3206 tests green.
//
// The transcription deliberately re-spells the CONTROL FILTER (reading `SECTION_CONTROLS`
// directly rather than the subject's `sectionRowFilter`), because that filter is part of
// what the gate is checking. It does share `sectionsOf` and `paramToSection`: those are
// today's behaviour, unchanged by this stage, and re-implementing them here would test the
// transcription rather than the projection.
//
// The transcription's own faithfulness is checked where it cannot be argued — in a real
// browser, against the DOM the panel actually renders (`tmp-p394-p1-projection-observe`).
//
// ── SCOPE ───────────────────────────────────────────────────────────────────────────
//
// The panel renders two node roles: the selected node, and the base data node it poses.
// The projection carries MORE — data-lane operators and one hop of linked producers — for
// the stages that follow. So byte-identity is asserted over `origin ∈ {poser, base}`, and
// the extra origins are asserted separately below. Widening the gate to the extra rows
// would be asserting that the panel renders something it does not.
//
// REF: src/app/exposeParams.ts; src/app/NPanel.tsx (`:2691` LinkedDataSections, `:3016`
//      the main-node block); PLAN-3 §4 P1 and §5 gate 1.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { getNodeType } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { SPLIT_KINDS, splitOps, type SplitKindName } from '../test-utils/splitKinds';
import { canApplyTransform } from './animate/dispatchApplyTransform';
import { paramToSection, sectionsOf, type SectionId } from './inspectorSections';
import { SECTION_CONTROLS, controlOwnedRowKeys, makeSectionCtx } from './inspectorSectionBody';
import { resolveDataLaneBase } from './operatorChain';
import { exposeParams, type ExposedParam } from './exposeParams';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function applyOps(state: DagState, ops: readonly Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

/** One row, flattened to a comparable string. Node AND path AND destination — a projection
 *  that put the right param in the wrong section would otherwise pass. */
function key(r: { nodeId: string; paramPath: string; home: { section: SectionId | null } }) {
  return `${r.nodeId} | ${r.paramPath} | ${r.home.section ?? '(unrouted)'}`;
}

// ════════════════════════════════════════════════════════════════════════════════════
// THE TRANSCRIPTION — NPanel's two row blocks, re-spelled. Keep it literal; the value of
// this file is that it was written from the component, not from the subject.
// ════════════════════════════════════════════════════════════════════════════════════

function isBindingShaped(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as { node?: unknown; socket?: unknown };
  return typeof o.node === 'string' && typeof o.socket === 'string';
}

/** NPanel `:3016` (the main-node block) and `:2691` (LinkedDataSections). */
function panelRows(state: DagState, nodeId: string, role: 'main' | 'linked', objectId: string) {
  const node = state.nodes[nodeId];
  if (!node)
    return [] as { nodeId: string; paramPath: string; home: { section: SectionId | null } }[];
  const declared = sectionsOf(state, nodeId);
  const params = (node.params ?? {}) as Record<string, unknown>;
  const canApply = canApplyTransform(state, objectId);
  const ctx = makeSectionCtx(node, objectId, canApply);
  const refKeys = new Set(Object.keys(getNodeType(node.type)?.refParams ?? {}));
  const row = (paramPath: string, section: SectionId | null) => ({
    nodeId,
    paramPath,
    home: { section },
  });

  // `LinkedDataSections` returns null when the node declares nothing; the main block
  // instead falls back to a flat list of every param except the ref ones.
  if (declared.length === 0) {
    if (role === 'linked') return [];
    return Object.keys(params)
      .filter((k) => !refKeys.has(k))
      .map((k) => row(k, null));
  }

  // The main block pre-filters control-owned keys across ALL declared sections, before
  // grouping. The linked block does not.
  //
  // ⚠️ DECLARED GAP: this gate does NOT cover that difference, and it was falsified to find
  // out — collapsing the two roles in the subject leaves all 14 cases green. No node type
  // that can be a linked data half can trigger it today (`slotIndex`'s only owner is a
  // scene-band wrapper; every `refParams` declarer is a constraint or query node; every
  // data type declares at least one section). Transcribed faithfully anyway, because the
  // difference is what the panel does and becomes observable the day a data node owns a
  // control-owned unrouted key. Written down rather than left implied.
  const owned = role === 'main' ? controlOwnedRowKeys(declared, ctx) : new Set<string>();
  const grouped = new Map<SectionId, string[]>();
  const unrouted: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (isBindingShaped(v)) continue;
    if (role === 'main' && refKeys.has(k)) continue;
    if (owned.has(k)) continue;
    const section = paramToSection(k, declared);
    if (section === null) {
      unrouted.push(k);
      continue;
    }
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section)!.push(k);
  }

  const out: ReturnType<typeof row>[] = [];
  for (const sectionId of declared) {
    // SectionBody's own filtering, re-spelled from the component rather than imported.
    const active = SECTION_CONTROLS[sectionId].filter((c) => c.applies(ctx));
    if (active.some((c) => c.suppressesAllRows === true)) continue;
    const omitted = new Set(active.flatMap((c) => c.omitRowKeys ?? []));
    for (const k of grouped.get(sectionId) ?? []) {
      if (!omitted.has(k)) out.push(row(k, sectionId));
    }
  }
  for (const k of unrouted) out.push(row(k, null));
  return out;
}

/** Everything the inspector renders for a selection today: the node, then its linked data
 *  half (resolved through the stack base, exactly as `NPanel.tsx:2825` does). */
function panelProjection(state: DagState, selectedId: string) {
  const rows = panelRows(state, selectedId, 'main', selectedId);
  const base = resolveDataLaneBase(state, selectedId);
  if (base !== selectedId) rows.push(...panelRows(state, base, 'linked', selectedId));
  return rows;
}

/** The subject, restricted to the two roles the panel renders. */
function subjectRows(state: DagState, selectedId: string): ExposedParam[] {
  return exposeParams(state, selectedId).filter((r) => r.origin === 'poser' || r.origin === 'base');
}

// ════════════════════════════════════════════════════════════════════════════════════

describe('exposeParams — the byte-identical projection gate', () => {
  const KINDS = Object.keys(SPLIT_KINDS) as SplitKindName[];

  it.each(KINDS)('reproduces the panel exactly for a split %s', (kind) => {
    const state = applyOps(
      emptyDagState(),
      splitOps(kind, { objectId: 'obj' }, { data: SPLIT_KINDS[kind].baseDataParams }) as Op[],
    );
    const expected = panelProjection(state, 'obj').map(key);
    const actual = subjectRows(state, 'obj').map(key);

    // VACUITY GUARD, and it is load-bearing: two empty lists are equal. A kind that
    // produced no rows at all would otherwise pass this gate silently.
    expect(expected.length, `${kind}: the panel must render SOME rows to compare`).toBeGreaterThan(
      0,
    );
    expect(actual, `${kind}: same rows, same order`).toEqual(expected);
  });

  it.each(['n_box', 'n_camera', 'n_light'])(
    'reproduces the panel exactly for the default project’s %s',
    (selected) => {
      const state = buildDefaultDagState();
      const expected = panelProjection(state, selected).map(key);
      expect(expected.length).toBeGreaterThan(0);
      expect(subjectRows(state, selected).map(key)).toEqual(expected);
    },
  );

  it('reproduces the panel for a node with NO declared sections (the flat fallback)', () => {
    // The two roles diverge hardest here: the main block renders every param flat, the
    // linked block renders nothing. Asserted through a real node type that declares none.
    const state = buildDefaultDagState();
    const bare = Object.values(state.nodes).find((n) => sectionsOf(state, n.id).length === 0);
    expect(bare, 'the default project must contain a section-less node for this case').toBeTruthy();
    const expected = panelProjection(state, bare!.id).map(key);
    expect(subjectRows(state, bare!.id).map(key)).toEqual(expected);
  });

  it('still reproduces the panel when an OPERATOR stands in the lane', () => {
    // The panel resolves through the chain to the base, so its rows are unchanged by an
    // operator. The projection additionally carries the operator's own rows — which is
    // why the gate is scoped to the two panel roles rather than the whole projection.
    let state = applyOps(
      emptyDagState(),
      splitOps('box', { objectId: 'obj' }, { data: SPLIT_KINDS.box.baseDataParams }) as Op[],
    );
    state = applyOps(state, [
      { type: 'addNode', nodeId: 'ovr', nodeType: 'MaterialOverrideOp', params: {} },
      {
        type: 'disconnect',
        from: { node: 'obj_data', socket: 'out' },
        to: { node: 'obj', socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: 'obj_data', socket: 'out' },
        to: { node: 'ovr', socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: 'ovr', socket: 'out' },
        to: { node: 'obj', socket: 'data' },
      },
    ] as Op[]);

    expect(subjectRows(state, 'obj').map(key)).toEqual(panelProjection(state, 'obj').map(key));

    // …and the operator's rows ARE in the full projection, carried for P3.
    const opRows = exposeParams(state, 'obj').filter((r) => r.origin === 'operator');
    expect(
      opRows.length,
      'the operator must contribute rows to the full projection',
    ).toBeGreaterThan(0);
    expect(opRows.every((r) => r.nodeId === 'ovr')).toBe(true);
  });
});

describe('exposeParams — what the projection carries beyond the panel', () => {
  it('exposes a LINKED PRODUCER’s params (a shared Material node)', () => {
    let state = applyOps(
      emptyDagState(),
      splitOps('box', { objectId: 'obj' }, { data: SPLIT_KINDS.box.baseDataParams }) as Op[],
    );
    state = applyOps(state, [
      { type: 'addNode', nodeId: 'mat', nodeType: 'Material', params: {} },
      {
        type: 'connect',
        from: { node: 'mat', socket: 'out' },
        to: { node: 'obj_data', socket: 'material' },
      },
    ] as Op[]);

    const linked = exposeParams(state, 'obj').filter((r) => r.origin === 'linked');
    expect(linked.length, 'the wired Material must contribute rows').toBeGreaterThan(0);
    expect(linked.every((r) => r.nodeId === 'mat')).toBe(true);
    // Addressed through the socket it arrived on, so two producers on one node stay apart.
    expect(linked.every((r) => r.relPath.startsWith('base.material/'))).toBe(true);
  });

  it('every row is addressed by the node it came from — provenance, not resolution', () => {
    const state = buildDefaultDagState();
    for (const r of exposeParams(state, 'n_box')) {
      const node = state.nodes[r.nodeId];
      expect(node, `${r.relPath} names a node that exists`).toBeTruthy();
      // The param must actually live on the node the row points at. This is the property
      // that makes a write the identity function; without it the row is still an oracle.
      const root = r.paramPath.split('.')[0];
      expect(
        root in ((node!.params ?? {}) as Record<string, unknown>),
        `${r.relPath}: ${root} must live on ${r.nodeId}`,
      ).toBe(true);
    }
  });
});

describe('exposeParams — relPath is stable across re-instantiation', () => {
  it('the same chain built with DIFFERENT node ids yields identical relPaths', () => {
    // The property that makes `relPath` the thing a template stores. `nodeId` is
    // per-instance; a curation list keyed on it breaks the second time it is instanced.
    const build = (objectId: string) => {
      let s = applyOps(
        emptyDagState(),
        splitOps('box', { objectId }, { data: SPLIT_KINDS.box.baseDataParams }) as Op[],
      );
      s = applyOps(s, [
        { type: 'addNode', nodeId: `${objectId}_ovr`, nodeType: 'MaterialOverrideOp', params: {} },
        {
          type: 'disconnect',
          from: { node: `${objectId}_data`, socket: 'out' },
          to: { node: objectId, socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: `${objectId}_data`, socket: 'out' },
          to: { node: `${objectId}_ovr`, socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: `${objectId}_ovr`, socket: 'out' },
          to: { node: objectId, socket: 'data' },
        },
      ] as Op[]);
      return s;
    };

    const a = exposeParams(build('alpha'), 'alpha');
    const b = exposeParams(build('beta_instance'), 'beta_instance');

    expect(a.length).toBeGreaterThan(0);
    expect(b.map((r) => r.relPath)).toEqual(a.map((r) => r.relPath));
    // …and the ids genuinely differ, or the assertion above is vacuous.
    expect(b.map((r) => r.nodeId)).not.toEqual(a.map((r) => r.nodeId));
  });
});
