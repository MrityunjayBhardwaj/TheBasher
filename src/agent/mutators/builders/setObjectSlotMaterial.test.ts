// #645 P4 — the agent can re-point ONE object's slot, and is REFUSED the write that would
// have changed nothing.
//
// The capability landed with no surface reaching it: `ObjectValue.slotOverrides` existed,
// the derivation read it, and nothing could ask for one. These rows are that surface being
// exercised end to end — plan, gates, ops, and the resolved table the renderer would draw.
//
// ── THE ROW THAT MATTERS MOST IS THE REFUSAL ─────────────────────────────────────────
//
// `objectSlotsOf` maps overrides over the DATA's table, so an out-of-range index resolves
// to nothing. It has to: the resolution runs on the render road and cannot throw. So the
// write would land in params, change no pixel, and report no error — the silently-dropped
// authoring failure this whole area has been paying for. The refusal has to live at the
// authoring surface because it cannot live at the resolution, and that obligation was
// written down when the resolution shipped.
//
// REF: src/app/materialAssignment.ts (`objectSlotsOf` — why it cannot refuse);
//      src/nodes/objectSlotTable.gate.test.ts (the fuse chain and the census);
//      src/agent/mutators/builders/setMaterialColor.ts (the data-side sibling); issue #645.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../../core/dag';
import type { Op } from '../../../core/dag/types';
import { registerAllNodes } from '../../../nodes/registerAll';
import { makeSplitCube } from '../../../test-utils/splitCube';
import {
  setObjectSlotMaterialMutator,
  type SetObjectSlotMaterialSpec,
} from './setObjectSlotMaterial';
import { validatePlan } from '../validate';

function plan(state: DagState, spec: SetObjectSlotMaterialSpec) {
  return validatePlan(setObjectSlotMaterialMutator, spec, state, 'x');
}

/**
 * Apply, and ASSERT THE WRITE WAS NOT SILENTLY STRIPPED. `applyOp` surfaces a `reportable`
 * when an op is ACCEPTED but changed nothing because the target did not own the param — a
 * non-strict schema drops the key, `safeParse` succeeds, and the write no-ops (#423).
 *
 * That is the exact failure mode a new param invites: if `slotOverrides` were not schema'd
 * on `ObjectNode`, every row below would still pass on the plan and quietly assert nothing.
 * So the flag is checked here rather than trusted.
 */
function applyAll(state: DagState, ops: readonly Op[]): DagState {
  return ops.reduce<DagState>((s, op) => {
    const res = applyOp(s, op);
    expect(res.reportable).toBeUndefined();
    return res.next;
  }, state);
}

describe('#645 P4 — setObjectSlotMaterial', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('writes the override onto the OBJECT, never the data node it shares', () => {
    const { state, objectId, dataId } = makeSplitCube(emptyDagState(), { objectId: 'n_cube' });
    const p = plan(state, { targetSelectors: [objectId], slotIndex: 0, color: '#00ff00' });
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error(p.reason);

    expect(p.ops).toHaveLength(1);
    const op = p.ops[0] as { type: string; nodeId: string; paramPath: string };
    expect(op.type).toBe('setParam');
    // 🔑 THE OBJECT. Writing to the data node is the mechanism this exists to avoid — it
    // would change the material every other object reading that mesh sees.
    expect(op.nodeId).toBe(objectId);
    expect(op.nodeId).not.toBe(dataId);
    expect(op.paramPath).toBe('slotOverrides.0');
  });

  it('the applied override reaches the params, and the data node is untouched', () => {
    const { state, objectId, dataId } = makeSplitCube(emptyDagState(), { objectId: 'n_cube' });
    const before = JSON.stringify(state.nodes[dataId].params);

    const p = plan(state, { targetSelectors: [objectId], slotIndex: 0, color: '#00ff00' });
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error(p.reason);
    const next = applyAll(state, p.ops);

    const params = next.nodes[objectId].params as {
      slotOverrides?: Record<string, { base: { color: string } }>;
    };
    expect(Object.keys(params.slotOverrides ?? {})).toEqual(['0']);
    expect(params.slotOverrides?.['0'].base.color).toBe('#00ff00');

    // 🔴 BY BYTES, not by inspection. "The shared datablock is never written" is the row
    // the whole mechanism turns on, and a write that merely looked equivalent would still
    // have reached every other object reading this mesh.
    expect(JSON.stringify(next.nodes[dataId].params)).toBe(before);
  });

  it('🔴 REFUSES an out-of-range slot, and names the count', () => {
    const { state, objectId } = makeSplitCube(emptyDagState(), { objectId: 'n_cube' });

    // A plain cube declares ONE slot, so 1 is the first index that does not exist. The
    // resolution would map this over a 1-entry table and drop it silently.
    const p = plan(state, { targetSelectors: [objectId], slotIndex: 7, color: '#00ff00' });
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error('expected a refusal');
    expect(p.reason).toMatch(/1 material slot/);
    expect(p.reason).toContain('slot 7 does not exist');

    // 🔑 THE CONTROL, without which the refusal proves nothing: the SAME target and the
    // same colour at an index that does exist is accepted. So the gate is about the range,
    // not about the fixture being unusable.
    const ok = plan(state, { targetSelectors: [objectId], slotIndex: 0, color: '#00ff00' });
    expect(ok.ok).toBe(true);
  });

  it('refuses the DATA node as a target, because the override is object-level', () => {
    const { state, dataId } = makeSplitCube(emptyDagState(), { objectId: 'n_cube' });
    const p = plan(state, { targetSelectors: [dataId], slotIndex: 0, color: '#00ff00' });
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error('expected a refusal');
    expect(p.reason).toMatch(/OBJECT/);
  });

  it('two Objects over ONE data node end up wearing different materials', () => {
    // The whole point, exercised through the agent road rather than asserted on the
    // resolver directly: no operator was added to either branch, and the data node was
    // never written.
    const built = makeSplitCube(emptyDagState(), { objectId: 'n_left' });
    let state = built.state;
    const dataId = built.dataId;

    // A second Object reading the SAME data node.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_right',
      nodeType: 'Object',
      params: { position: [2, 0, 0] },
    } as Op).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: 'n_right', socket: 'data' },
    } as Op).next;

    const p = plan(state, { targetSelectors: ['n_right'], slotIndex: 0, color: '#00ff00' });
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error(p.reason);
    state = applyAll(state, p.ops);

    const left = state.nodes[built.objectId].params as { slotOverrides?: object };
    const right = state.nodes['n_right'].params as {
      slotOverrides?: Record<string, { base: { color: string } }>;
    };

    expect(left.slotOverrides).toBeUndefined();
    expect(right.slotOverrides?.['0'].base.color).toBe('#00ff00');
  });
});
