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
// mechanism — re-evaluating a node with a STABLE params ref does not re-hash at
// all, while a FRESH-but-equal ref re-hashes every time.
//
// The mechanism half used to be a wall-clock ratio and is now a CALL COUNT (#707).
// The reason is in that row's own comment: a duration in the fast tier cannot tell
// a regression from a busy runner, and the sibling instrument with that same shape
// turned `main` red on a tree byte-identical to one that had just passed.
//
// REF: src/core/dag/evaluator.ts (hashParams + paramsHashMemo), src/core/dag/hash.ts,
//      src/nodes/GltfAsset.ts (the heavy nodeNameMap/childHierarchy/skins params),
//      [[H48]] 6th occ, [[V42]], [[B13]], dharana B-gizmo. Branch ux-overhall.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluate } from './evaluator';
import * as hash from './hash';
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

  it('mechanism — a STABLE params ref does not re-hash, a FRESH-equal one does every time', () => {
    // ── WHY THIS ROW COUNTS A CALL AND NOT A DURATION (#707) ────────────────────────────
    //
    // It used to assert `stableMs * 5 < freshMs` — a wall-clock ratio, in the one tier that
    // is trusted to be deterministic and which, unlike the e2e gate, has neither a baseline
    // that absorbs a flake nor a protocol for reading its verdict. The sibling instrument in
    // `modifierAttributeTiling.gate.test.ts` had exactly this shape, with a margin described
    // in its own comment as deliberately vast, and it still turned `main` red twice — once
    // on a tree BYTE-IDENTICAL to one that had passed the same job ninety minutes earlier.
    //
    // The margin is not what makes a timing assertion safe. Two populations measured in one
    // run cancel a slow MACHINE; they do not cancel a PAUSE, and whichever arm is unlucky
    // absorbs the whole of it. This row was additionally asymmetric in a way that erodes the
    // margin from the other side: the fresh arm rebuilt a 4000-entry params object INSIDE
    // the timed loop, so it was partly timing object construction rather than hashing.
    //
    // What the row actually claims is that the memo was CONSULTED, and `hashValue` is the
    // work `hashParams` skips on a hit (`evaluator.ts` — the WeakMap read returns above it).
    // So the claim is a call count, exact and clockless. `hashValue` is also called once per
    // evaluate for the input hashes, so calls are attributed to the PARAMS by their argument
    // — `big` is the heavy node's only param and nothing else hashed here carries it. The
    // attribution was measured, not assumed: a cold evaluate reads 1 params call out of 2
    // total, and the stable arm below reads 0 out of 20.
    //
    // Both literals were OBSERVED before being written:
    //
    //   STABLE — one params object, re-evaluated. 0 hashes: the memo hits every time.
    //   FRESH  — a new equal-content params object per call. 20 hashes: it must miss, every
    //            time, which is the pre-fix behaviour this memo exists to remove.
    //
    // N drops from 4000 to the 700 the file header and the correctness row above both use —
    // the real GltfAsset scale. The old figure existed so hashing would dominate a clock,
    // and nothing here is measured against a clock any more.
    const N = 700;
    const ITERS = 20;

    // `hashValue` is spied through the NAMESPACE, which is the binding `evaluator.ts` calls
    // through once vitest has transformed it — confirmed by the cold read below registering,
    // rather than assumed from the tooling.
    const hashes = vi.spyOn(hash, 'hashValue');
    const paramsHashes = () =>
      hashes.mock.calls.filter(
        (call) => typeof call[0] === 'object' && call[0] !== null && 'big' in call[0],
      ).length;
    try {
      // COLD — the first evaluate of a params object must hash it. Asserted rather than just
      // warmed, because a stable arm reading 0 is only evidence of a memo if the uncached
      // road reads 1; without this, a `hashParams` that never hashed at all would pass.
      const stable = stateWith(heavyParams(N));
      hashes.mockClear();
      evaluate(stable, 'h');
      expect(paramsHashes(), 'a cold evaluate did not hash its params at all').toBe(1);

      // STABLE — the real structural-sharing case (V42): setParam replaces the edited node's
      // params and shares every other node's by reference, so an unchanged node re-evaluates
      // against the identical object.
      hashes.mockClear();
      for (let i = 0; i < ITERS; i++) evaluate(stable, 'h');
      expect(
        paramsHashes(),
        `${ITERS} re-evaluates of an unchanged params ref re-hashed ` +
          `${paramsHashes()} times — the params-hash memo is not being consulted`,
      ).toBe(0);

      // FRESH — equal content, new object each call. The memo is keyed by IDENTITY, so this
      // must miss every time. Stated as the identity semantics rather than sold as a unique
      // detector: perturbed to collapse every params object onto one memo entry, the
      // correctness row above and the cold read below BOTH red first, so this arm is a
      // statement of what identity-keying means and not the only thing standing behind it.
      hashes.mockClear();
      for (let i = 0; i < ITERS; i++) evaluate(stateWith(heavyParams(N)), 'h');
      expect(
        paramsHashes(),
        `${ITERS} evaluates over fresh-but-equal params hashed ${paramsHashes()} times — ` +
          `expected one per distinct object`,
      ).toBe(ITERS);
    } finally {
      hashes.mockRestore();
    }
  });
});
