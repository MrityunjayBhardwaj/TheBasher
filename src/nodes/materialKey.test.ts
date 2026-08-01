// #536 S1 — the gate: identity is minted by graph evaluation.
//
// The claim that matters is "two objects that resolve to the same material carry the same
// key, and two that do not, do not" — and the point of putting it HERE rather than in a
// browser is that it is a property of the evaluator, not of the renderer. Before this,
// the only witness to material sharing was a `THREE.Material` uuid read off a live scene
// (`p530-material-instance-sharing.spec.ts`), which could only be asked after a render.
//
// ── WHAT WOULD MAKE THIS GATE VACUOUS, AND WHAT STOPS IT ────────────────────────────
//
// A key function that returned a CONSTANT would pass every "same key" assertion here for
// free, so every sharing claim is paired with a separating one over the same fixture.
// That pairing is the whole guard: sameness alone is satisfied by a broken key, and
// difference alone is satisfied by a key that never dedups anything.

import { describe, expect, it } from 'vitest';
import { applyOp, emptyDagState } from '../core/dag';
import { registerAllNodes } from './registerAll';
import { evaluate } from '../core/dag/evaluator';
import { hydrateInlineMaterial } from './materialSchema';
import { materialKeyOf } from './materialKey';
import type { DagState } from '../core/dag/types';
import type { MeshDataValue } from './types';

registerAllNodes();

interface Op {
  type: string;
  [k: string]: unknown;
}

const SHARED = '#c81e5a';
const OTHER = '#1e9ac8';

function build(ops: Op[]): DagState {
  let state = emptyDagState();
  for (const op of ops) state = applyOp(state, op as never).next;
  return state;
}

const box = (id: string, color: string): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'BoxData',
  params: { size: [1, 1, 1], material: { name: id, base: { color } } },
});

const material = (id: string, color: string): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'Material',
  params: { material: { name: id, base: { color } } },
});

const link = (from: string, to: string): Op => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket: 'material' },
});

const keyOfNode = (state: DagState, id: string) =>
  (evaluate(state, id).value as MeshDataValue).materialKey;

describe('#536 S1 — a material key minted by evaluation', () => {
  it('two data nodes linked to ONE Material node evaluate to the SAME key', () => {
    // Each box authors a DIFFERENT colour of its own, so a shared key is a fact about the
    // link superseding the param rather than about the fixture being uniform.
    const state = build([
      material('m', SHARED),
      box('d1', OTHER),
      box('d2', '#111111'),
      link('m', 'd1'),
      link('m', 'd2'),
    ]);

    expect(keyOfNode(state, 'd1')).toBe(keyOfNode(state, 'd2'));
    // ...and the key is not a constant: the same fixture with one box UNLINKED separates.
    const unlinked = build([material('m', SHARED), box('d1', OTHER), box('d2', '#111111')]);
    expect(keyOfNode(unlinked, 'd1')).not.toBe(keyOfNode(unlinked, 'd2'));
  });

  it('the DERIVED share too: two unlinked nodes with identical material key the same', () => {
    // Nobody connected these. They share because their content is equal — which is the
    // registry dedup that #530 shipped, now decided in the evaluator instead.
    // Note the two share DESPITE carrying different material NAMES (the `box` helper
    // labels each by node id). That is deliberate: `name` is a display label the builder
    // never applies, so keying on it would separate two materials that render identically
    // — a silently lost dedup, since nothing on screen would look wrong.
    const state = build([box('a', SHARED), box('b', SHARED), box('c', OTHER)]);
    expect(keyOfNode(state, 'a')).toBe(keyOfNode(state, 'b'));
    expect(keyOfNode(state, 'a')).not.toBe(keyOfNode(state, 'c'));
  });

  it('editing the shared Material moves BOTH keys — the authored share is a real link', () => {
    const before = build([material('m', SHARED), box('d1', OTHER), link('m', 'd1')]);
    const after = applyOp(before, {
      type: 'setParam',
      nodeId: 'm',
      paramPath: 'material.base.color',
      value: '#00ff44',
    } as never).next;

    expect(keyOfNode(after, 'd1')).not.toBe(keyOfNode(before, 'd1'));
  });

  it('a linked node ignores its OWN param — editing it does not move the key', () => {
    // The socket supersedes the param wholesale (#394 D3). If the key were minted BEFORE
    // the fold it would move here, which is the specific error this test exists to catch.
    const before = build([material('m', SHARED), box('d1', OTHER), link('m', 'd1')]);
    const after = applyOp(before, {
      type: 'setParam',
      nodeId: 'd1',
      paramPath: 'material.base.color',
      value: '#00ff44',
    } as never).next;

    expect(keyOfNode(after, 'd1')).toBe(keyOfNode(before, 'd1'));
    // Guard: that setParam really did land, so this is not passing on a no-op.
    expect(
      (after.nodes['d1'].params as { material: { base: { color: string } } }).material.base.color,
    ).toBe('#00ff44');
  });

  it('the key covers EVERY leaf, including ones no test names — the anti-drift property', () => {
    // The reason for a generic walk over an explicit field template: a field added to the
    // IR must join the key without anyone remembering. Perturbing a deep, rarely-touched
    // lobe is the closest a test can get to "a field nobody thought about".
    const base = hydrateInlineMaterial({ name: 'x', base: { color: SHARED } });
    for (const patch of [
      { coat: { ...base.coat, roughness: base.coat.roughness + 0.25 } },
      { transmission: { weight: 0.5 } },
      { emission: { ...base.emission, luminance: 12 } },
      { geometry: { ...base.geometry, opacity: 0.3 } },
    ]) {
      expect(materialKeyOf({ ...base, ...patch })).not.toBe(materialKeyOf(base));
    }
  });

  it('a NAME change does not move the key, but every rendering lobe does', () => {
    // Both directions, because either alone is passed by a broken key: excluding too much
    // would make the key blind to a real difference, excluding nothing would separate
    // identical-looking materials.
    const base = hydrateInlineMaterial({ name: 'first', base: { color: SHARED } });
    const renamed = hydrateInlineMaterial({ name: 'second', base: { color: SHARED } });
    expect(materialKeyOf(renamed)).toBe(materialKeyOf(base));
    const recoloured = hydrateInlineMaterial({ name: 'first', base: { color: OTHER } });
    expect(materialKeyOf(recoloured)).not.toBe(materialKeyOf(base));
  });

  it('is stable across independently hydrated but equal specs (the dropped sort)', () => {
    // `materialKey.ts` drops the per-level sort that `materialRegistry.keyOf` does, on the
    // grounds that every IR comes out of one hydrate seam so key ORDER is deterministic.
    // That is an assumption about the seam, so it is pinned here rather than trusted: if
    // hydration ever becomes order-unstable, this reds instead of silently losing dedup.
    const a = hydrateInlineMaterial({ name: 'x', base: { color: SHARED } });
    const b = hydrateInlineMaterial({ base: { color: SHARED }, name: 'x' });
    expect(materialKeyOf(a)).toBe(materialKeyOf(b));
    expect(Object.keys(a)).toEqual(Object.keys(b));
  });

  it('null material ⇒ null key — the two fields agree, always', () => {
    // Nothing produces a null-material MeshData today, so this pins the CONTRACT rather
    // than an observed case: a consumer must never see a key without a material.
    const state = build([box('a', SHARED)]);
    const v = evaluate(state, 'a').value as MeshDataValue;
    expect(v.material === null).toBe(v.materialKey === null);
  });
});
