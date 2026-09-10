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
import { registerAllNodes } from '../../nodes/registerAll';
import { makeSplitCube } from '../../test-utils/splitCube';

describe('applyOp — #423 wrong-half write is REPORTABLE', () => {
  beforeEach(() => {
    registerAllNodes();
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

// ---------------------------------------------------------------------------
// #1008 — the same check, one level down
// ---------------------------------------------------------------------------

describe('applyOp — #1008 a stripped write is caught at every depth', () => {
  beforeEach(() => {
    registerAllNodes();
  });

  function cube() {
    return applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'n',
      nodeType: 'Object',
      params: {},
    }).next;
  }

  // THE ROW THIS SECTION EXISTS FOR. #423 compared the ROOT key across the parse,
  // so a bad key nested under a root the schema DOES own left that root in place
  // and reported nothing: the write returned success and changed the graph not at
  // all. `overridden` is a real param of Object; `overridden.bogus` is not.
  it('flags a bad key NESTED under a root the schema owns', () => {
    const result = applyOp(cube(), {
      type: 'setParam',
      nodeId: 'n',
      paramPath: 'overridden.bogus',
      value: true,
    });
    expect(result.reportable?.badge).toBe('stripped-write');
    expect(result.reportable?.paramPath).toBe('overridden.bogus');
    // The reason does NOT restate the path — the badge's own opening clause
    // already names it, and repeating it renders the path twice in one sentence.
    expect(result.reportable?.reason).toBe('Object has no such parameter');
    expect(result.reportable?.reason).not.toContain('overridden');
    // The value did not land — which is the claim. Note what it DOES leave behind:
    // `setAtPath` creates the container on the way down and zod keeps it, so the
    // params gain an empty `overridden: {}`. So the write is not a clean no-op; it
    // is a no-op with a residue that still moves the params hash. That is a second
    // reason to surface it rather than let it pass, and it is asserted here so the
    // next reader meets the residue in the row instead of in a diff.
    const params = result.next.nodes.n.params as Record<string, unknown>;
    expect((params.overridden as Record<string, unknown>).bogus).toBeUndefined();
    expect(params.overridden).toEqual({});
    expect(params.position).toEqual([0, 0, 0]);
  });

  it('CONTROL: a real nested path is NOT flagged', () => {
    const result = applyOp(cube(), {
      type: 'setParam',
      nodeId: 'n',
      paramPath: 'overridden.position',
      value: true,
    });
    expect(result.reportable).toBeUndefined();
    expect(result.next.nodes.n.params.overridden).toMatchObject({ position: true });
  });

  it('a bad ROOT key under a NESTED path names the segment that failed', () => {
    const result = applyOp(cube(), {
      type: 'setParam',
      nodeId: 'n',
      paramPath: 'transform.position.y',
      value: 2,
    });
    expect(result.reportable?.badge).toBe('stripped-write');
    // Here the root and the path differ, so naming the root IS new information.
    expect(result.reportable?.reason).toBe("Object has no parameter 'transform'");
  });

  it('a bad ROOT key equal to the whole path adds nothing but the node type', () => {
    const result = applyOp(cube(), {
      type: 'setParam',
      nodeId: 'n',
      paramPath: 'size',
      value: 5,
    });
    expect(result.reportable?.badge).toBe('stripped-write');
    expect(result.reportable?.reason).toBe('Object has no such parameter');
  });

  // The guard that keeps the product's own cleanup un-badged: `idRefSweep` clears a
  // dangling reference by writing `undefined` at its path. "No value at the path"
  // is the INTENT there, so it must not read as a defect.
  it('CONTROL: a deliberate undefined write is not a strip', () => {
    const seeded = applyOp(cube(), {
      type: 'setParam',
      nodeId: 'n',
      paramPath: 'overridden.position',
      value: true,
    }).next;
    const result = applyOp(seeded, {
      type: 'setParam',
      nodeId: 'n',
      paramPath: 'overridden.position',
      value: undefined,
    });
    expect(result.reportable).toBeUndefined();
  });
});
