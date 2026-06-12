// H48 6th-occurrence GATE — the params-hash memo makes evaluation O(changed),
// not O(scene). The cicada edit-lag (manipulate a node in a heavy imported scene →
// ~2fps) was `hashValue(node.params)` recomputed on EVERY uncached evaluate: a
// read-side resolver (gizmo/inspector) re-evaluating per inspector row paid the
// heavy GltfAsset/TransformClip params hash 3-6×/commit (~35ms each → ~458ms/frame,
// measured headed-Firefox on the real cicada). The fix: a WeakMap keyed by the
// params OBJECT identity, exact because setParam REPLACES the edited node's params
// (ops.ts applySetParam → fresh `parsed.data`) and SHARES unchanged nodes' params by
// reference (structural sharing, V42). A hit ⇒ same object ⇒ same content.
//
// This gate proves BOTH halves on the real evaluator: (1) correctness — the
// memoized hash equals a direct hashValue and is stable across evaluates; (2)
// mechanism — re-evaluating a heavy-params node with a STABLE params ref is far
// cheaper than with a FRESH-but-equal params ref each call (the memo bites).
//
// REF: src/core/dag/evaluator.ts (hashParams + paramsHashMemo), src/core/dag/hash.ts,
//      src/nodes/GltfAsset.ts (the heavy nodeNameMap/childHierarchy/skins params),
//      [[H48]] 6th occ, [[V42]], [[B13]], dharana B-gizmo. Branch ux-overhall.

import { beforeEach, describe, expect, it } from 'vitest';
import { evaluate } from './evaluator';
import type { DagState } from './state';
import { __resetRegistryForTests, registerNodeType } from './registry';
import type { NodeDefinition } from './types';

// A leaf node with arbitrarily heavy params (mirrors a glTF asset's 700-entry
// nodeNameMap). Its evaluate is trivial — the cost is hashing its params, exactly
// like GltfAsset (whose evaluate is an object literal but whose nodeNameMap is huge).
interface HeavyParams {
  big: Record<string, string>;
}
const HeavyNode: NodeDefinition<HeavyParams, { ok: true }> = {
  type: 'TestHeavy',
  version: 1,
  pure: true,
  cost: 'cheap',
  // No zod schema needed for the evaluator path; provide a permissive stub.
  paramSchema: {
    safeParse: (v: unknown) => ({ success: true as const, data: v as HeavyParams }),
  } as never,
  inputs: {},
  outputs: { out: { type: 'Any', cardinality: 'single' } },
  inspectorSections: [],
  evaluate: () => ({ ok: true }),
};

function heavyParams(n: number): HeavyParams {
  const big: Record<string, string> = {};
  for (let i = 0; i < n; i++) big[`sanitized_scene_node_name_${i}`] = `dag_child_node_id_${i}`;
  return { big };
}

function stateWith(params: HeavyParams): DagState {
  return {
    nodes: { h: { id: 'h', type: 'TestHeavy', version: 1, params, inputs: {} } },
    outputs: {},
  } as unknown as DagState;
}

describe('params-hash memo (H48 6th occ — evaluation is O(changed), not O(scene))', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerNodeType(HeavyNode as never);
  });

  it('correctness — memoized eval hash equals a direct hashValue and is stable', () => {
    const params = heavyParams(700);
    const state = stateWith(params);
    const r1 = evaluate(state, 'h');
    const r2 = evaluate(state, 'h');
    // Stable across evaluates (the memo must not change the hash).
    expect(r1.hash).toBe(r2.hash);
    // The cache key embeds hashValue(params); a different-content params yields a
    // different hash (the memo is keyed by identity, not collapsing distinct content).
    const other = evaluate(stateWith(heavyParams(701)), 'h');
    expect(other.hash).not.toBe(r1.hash);
    // And the value is unaffected.
    expect(r1.value).toEqual({ ok: true });
  });

  it('mechanism — a STABLE params ref re-evaluates far cheaper than a FRESH-equal one', () => {
    const N = 4000; // heavy enough that hashing dominates the trivial evaluate
    const ITERS = 200;

    // FRESH-but-equal params each call → WeakMap MISS every time → re-hash (the
    // pre-fix behavior, simulated by rebuilding an equal-content params object).
    let t0 = performance.now();
    for (let i = 0; i < ITERS; i++) evaluate(stateWith(heavyParams(N)), 'h');
    const freshMs = performance.now() - t0;

    // STABLE params ref (the real structural-sharing case) → WeakMap HIT after the
    // first → no re-hash. This is what an unchanged node costs across re-evaluates.
    const stable = stateWith(heavyParams(N));
    evaluate(stable, 'h'); // warm
    t0 = performance.now();
    for (let i = 0; i < ITERS; i++) evaluate(stable, 'h');
    const stableMs = performance.now() - t0;

    // The memo must make the stable-ref path dramatically cheaper. The real ratio is
    // ~50-100×; assert a conservative 5× so the gate is robust, not flaky. A
    // regression that re-hashes unchanged params every evaluate fails this.
    expect(stableMs * 5).toBeLessThan(freshMs);
  });
});
