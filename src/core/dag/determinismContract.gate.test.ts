// The determinism contract, gated (#576, epic #575).
//
// WHY A GATE AND NOT A DOC. The contract used to live in three shapes — a comment on
// TimeSource, an ESLint rule over `src/nodes/**`, and a `pure: boolean` nothing verified
// — and the one-line version people quote (*same (inputs, params, time) → same output*)
// is FALSE, because two lanes do not satisfy it and are not meant to. A sentence that is
// false in two of three cases gets quoted as description and then relied on. So the three
// clauses are stated at the declaration, and these tests make each one checkable.
//
// What each test here buys:
//   1. LANE CENSUS — the three clauses only mean something if every node is in a known
//      lane. An exact set means adding an impure or stateful node is a deliberate act
//      with a visible diff, never a quiet one.
//   2. CONTEXT SURFACE — `EvalCtx` is the one channel through which a nondeterministic
//      term could reach a pure evaluator without touching params or inputs. Pinning its
//      field set exactly is what makes clause 1's tuple closed rather than aspirational.

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listNodeTypes, requireNodeType } from './registry';
import { registerAllNodes } from '../../nodes/registerAll';
import { stripComments } from '../../test-utils/sourceScan';

/** Clause 2 — deterministic given a seed and an interval, NOT point-in-time. */
const STATEFUL = ['Lag', 'Solver'] as const;

/** Every node that is not `pure: true`. Clause 1 does not apply to these. */
const IMPURE = [
  'ComfyUIWorkflow',
  'Lag',
  'RenderJob',
  'Solver',
  'TimeSource',
  'VideoStitch',
] as const;

describe('#576 — the determinism contract is exact', () => {
  beforeAll(() => registerAllNodes());

  it('LANE CENSUS: the impure set is exactly the declared one', () => {
    const actual = listNodeTypes()
      .filter((t) => !requireNodeType(t).pure)
      .sort();
    // EXACT, not a superset: a new `pure: false` node must be added here on purpose,
    // and a node that quietly loses `pure: true` reds immediately.
    expect(actual).toEqual([...IMPURE].sort());
  });

  it('LANE CENSUS: the stateful set is exactly the declared one, and is a subset of impure', () => {
    const actual = listNodeTypes()
      .filter((t) => requireNodeType(t).stateful === true)
      .sort();
    expect(actual).toEqual([...STATEFUL].sort());
    // A stateful node cannot claim purity — clause 2 exists precisely because these
    // are not point-in-time reproducible.
    for (const t of actual) expect(requireNodeType(t).pure).toBe(false);
  });

  it('LANE CENSUS: the corpus is non-empty and mostly pure (guards a vacuous pass)', () => {
    const all = listNodeTypes();
    const pure = all.filter((t) => requireNodeType(t).pure);
    // If the registry ever fails to seed, every filter above returns [] and two of the
    // three tests pass for free. This is the presence control.
    expect(all.length).toBeGreaterThan(20);
    expect(pure.length).toBeGreaterThan(all.length - IMPURE.length - 1);
  });

  it('CONTEXT SURFACE: EvalCtx exposes exactly { time }', () => {
    const src = stripComments(readFileSync(path.resolve(__dirname, 'types.ts'), 'utf-8'));
    const m = src.match(/export interface EvalCtx\s*\{([\s\S]*?)\n\}/);
    expect(m, 'EvalCtx declaration not found in types.ts').toBeTruthy();

    // Field names at the top level of the interface body. `time`'s inline object type
    // contributes nested keys, so only lines at the declaration's own indent count.
    const fields = (m![1].match(/^\s{2}(\w+)\??\s*:/gm) ?? []).map((s) =>
      s.trim().replace(/\??\s*:$/, ''),
    );

    // Clause 1's tuple is (inputs, params, time). `inputs` and `params` are arguments
    // to evaluate; `time` is the only ctx term. Anything else here is a term OUTSIDE
    // the tuple that a pure evaluator could read — which is the violation.
    expect(fields).toEqual(['time']);
  });
});
