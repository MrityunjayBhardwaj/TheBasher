// #423 — a setParam aimed at the wrong half of a split object is ACCEPTED but
// changes nothing (a non-strict schema strips the unknown root key, so
// `safeParse` succeeds and the write silently no-ops). applySetParam now detects
// the strip and marks the op REPORTABLE — accepted, not rejected, but surfaced.
//
// The measurement instrument is part of the fixture: every assertion below is
// falsifiable (neuter the strip check in ops.ts and the wrong-half case goes
// green-silent), and the two CONTROL rows prove the detector does not fire on a
// legitimate real write or a legitimate same-value (idempotent) write.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from './ops';
import { emptyDagState } from './state';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { makeSplitCube } from '../../test-utils/splitCube';

describe('applyOp — #423 wrong-half write is REPORTABLE', () => {
  beforeEach(() => {
    __reseedAllNodesForTests();
  });

  // A split cube: the Object owns the transform (position/rotation/scale) and
  // does NOT own `material` — that lives on the linked BoxData.
  function splitCube() {
    return makeSplitCube(emptyDagState(), { objectId: 'n_cube', size: [1, 1, 1] });
  }

  it('flags a material write aimed at the Object half (which does not own material)', () => {
    const { state } = splitCube();
    const result = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_cube', // the Object — material lives on n_cube_data
      paramPath: 'material.base.color',
      value: '#ff0000',
    });

    // Accepted (an inverse is still produced) but surfaced as a no-op.
    expect(result.inverse.type).toBe('setParam');
    expect(result.reportable).toBeDefined();
    expect(result.reportable?.badge).toBe('stripped-write');
    expect(result.reportable?.nodeId).toBe('n_cube');
    expect(result.reportable?.paramPath).toBe('material.base.color');
    // And it genuinely changed nothing — the Object's params are untouched.
    expect(result.next.nodes.n_cube.params).toEqual(state.nodes.n_cube.params);
  });

  it('CONTROL: a real transform write on the Object is NOT flagged', () => {
    const { state } = splitCube();
    const result = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_cube',
      paramPath: 'position',
      value: [3, 4, 5], // a NEW value, distinct from the default [0,0,0]
    });
    expect(result.reportable).toBeUndefined();
    expect(result.next.nodes.n_cube.params.position).toEqual([3, 4, 5]);
  });

  it('CONTROL: a same-value (idempotent) write is NOT flagged as a strip', () => {
    // Seed a non-default position, then write the SAME value again. The key
    // survives the parse, so this must NOT be mistaken for a wrong-half strip.
    let state = splitCube().state;
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_cube',
      paramPath: 'position',
      value: [3, 4, 5],
    }).next;
    const result = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_cube',
      paramPath: 'position',
      value: [3, 4, 5], // identical
    });
    expect(result.reportable).toBeUndefined();
  });

  it('CONTROL: the SAME material write on the owning BoxData half is NOT flagged', () => {
    const { state, dataId } = splitCube();
    const result = applyOp(state, {
      type: 'setParam',
      nodeId: dataId, // the BoxData — it owns material
      paramPath: 'material.base.color',
      value: '#ff0000',
    });
    expect(result.reportable).toBeUndefined();
  });
});
