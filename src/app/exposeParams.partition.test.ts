// #394 P7 — where each promoted control is DRAWN, which is a question no inspector block
// can answer about itself.
//
// The inspector draws section cards from two places: the selected node's own declared
// sections, and the linked data node's. A promoted control names a home section, and both
// blocks can see that name — so if each decides independently, a section they BOTH declare
// draws the control twice, and a section NEITHER declares draws it not at all. From inside
// a block both failures are invisible: a block can only see the cards it draws.
//
// So the partition is asserted here, on the whole set at once, as three properties that
// only hold jointly:
//
//   1. TOTALITY — every input row lands in exactly one bucket. This is the property that
//      catches a dropped control, and it is asserted by PARTITION rather than by checking
//      each bucket's contents, because a rule can satisfy every individual placement test
//      and still lose a row that matches no branch.
//   2. PRECEDENCE — the selected node's sections win a contested one. Which side wins is
//      less important than that ONE side does; the test pins the choice so a later change
//      has to be deliberate.
//   3. DEGRADATION — a home nothing draws is UNPLACED, never dropped ([[V145]]). This is
//      the arm the panel renders in a visible bucket, and a control is the one row whose
//      disappearance also strands its drives.
//
// REF: src/app/exposeParams.ts (`partitionPromotedRows`), src/app/NPanel.tsx (the two
//      blocks and the unrouted bucket), src/app/PromoteParamControl.tsx (what gets drawn);
//      PLAN-3 §4 P7; #394.

import { describe, expect, it } from 'vitest';
import { partitionPromotedRows, type PromotedParam } from './exposeParams';
import type { SectionId } from './inspectorSections';

function control(controlPath: string, section: string | null): PromotedParam {
  return {
    kind: 'promoted',
    controlNodeId: 'ctl',
    controlPath,
    drives: [{ nodeId: 'ovr', paramPath: 'roughness', relPath: 'op0/roughness', driverId: 'd1' }],
    home: { section: section as SectionId | null },
  };
}

const OWN: SectionId[] = ['transform', 'layout'] as SectionId[];

describe('partitionPromotedRows', () => {
  it('every row lands in exactly one bucket — no control is silently dropped', () => {
    const rows = [
      control('a', 'transform'), // the selected node's own section
      control('b', 'material'), // the linked block's
      control('c', null), // no home at all
      control('d', 'nosuchsection'), // a home nothing declares
    ];
    const { main, linked, unplaced } = partitionPromotedRows(rows, OWN, true);
    expect(main.length + linked.length + unplaced.length).toBe(rows.length);
    // …and they are the SAME rows, not merely the same count: a rule that placed one row
    // twice and dropped another would pass a count check.
    expect(new Set([...main, ...linked, ...unplaced])).toEqual(new Set(rows));
  });

  it('a section the selected node declares goes to the main block, not the linked one', () => {
    const { main, linked } = partitionPromotedRows([control('a', 'transform')], OWN, true);
    expect(main.map((r) => r.controlPath)).toEqual(['a']);
    expect(linked).toEqual([]);
  });

  it('a section the selected node does NOT declare goes to the linked block', () => {
    const { main, linked } = partitionPromotedRows([control('b', 'material')], OWN, true);
    expect(main).toEqual([]);
    expect(linked.map((r) => r.controlPath)).toEqual(['b']);
  });

  it('with NO linked block, a section nobody draws degrades to UNPLACED — visible, not dropped', () => {
    const { main, linked, unplaced } = partitionPromotedRows(
      [control('b', 'material')],
      OWN,
      false,
    );
    expect(main).toEqual([]);
    expect(linked).toEqual([]);
    expect(unplaced.map((r) => r.controlPath)).toEqual(['b']);
  });

  it('a control with no home at all is UNPLACED even when a linked block exists', () => {
    // The unrouted arm is not "whatever is left over when a block is missing" — a control
    // whose home is absent has nowhere to be placed however many blocks are drawing.
    const { linked, unplaced } = partitionPromotedRows([control('c', null)], OWN, true);
    expect(linked).toEqual([]);
    expect(unplaced.map((r) => r.controlPath)).toEqual(['c']);
  });

  it('order within a bucket is the projection order', () => {
    const rows = [control('z', 'transform'), control('a', 'transform')];
    expect(partitionPromotedRows(rows, OWN, true).main.map((r) => r.controlPath)).toEqual([
      'z',
      'a',
    ]);
  });
});
