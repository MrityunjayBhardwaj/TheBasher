// #1569 — a body-input leaf's `input` is picked from what its owner declares, and a leaf that
// names nothing its owner has, or has no owner, says so in the inspector.
//
// The rows are what the inspector draws: the declared provider and lock off the schema, through
// `optionsSelectRows` — the same two calls `OptionsParamField` makes (src/app/NPanel.tsx).
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, getNodeType } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { emptyDagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { optionsLockOf, optionsOf, widgetOf } from '../nodes/paramWidget';
import { registerAllNodes } from '../nodes/registerAll';
import { optionsSelectRows } from './optionsSelectRows';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string): Op => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket },
});

/** A Solver whose body adds a mistyped leaf to a good one, and a leaf wired to nothing. */
function scene(): DagState {
  return apply(emptyDagState(), [
    node('typo', 'BodyInput', { input: 'prve' }),
    node('good', 'BodyInput', { input: 'input' }),
    node('m', 'Math', { op: 'add' }),
    wire('typo', 'm', 'a'),
    wire('good', 'm', 'b'),
    node('s', 'Solver'),
    wire('m', 's', 'body'),
    node('stray', 'BodyInput', { input: 'prev' }),
  ]);
}

const field = (type: string) =>
  (getNodeType(type)!.paramSchema as z.ZodObject<z.ZodRawShape>).shape.input;

/** What the inspector draws for `leaf`'s `input`: the lock's reason, or the picker's rows. */
function drawn(state: DagState, leaf: string) {
  const f = field(state.nodes[leaf].type);
  const locked = optionsLockOf(f)?.(state, leaf) ?? null;
  if (locked !== null) return { locked };
  const stored = (state.nodes[leaf].params as { input: string }).input;
  const none = f.safeParse('').success ? '— none —' : null;
  const model = optionsSelectRows(stored, optionsOf(f)!(state, leaf), none);
  return {
    stale: model.stale,
    rows: model.rows.map((r) => `${r.label}${r.disabled ? ' (disabled)' : ''}`),
  };
}

describe('#1569 — the body-input picker', () => {
  it('both leaf types draw `input` as a picker', () => {
    expect(['BodyInput', 'BodyInputVec'].map((t) => widgetOf(field(t)))).toEqual([
      'options',
      'options',
    ]);
  });

  it('offers exactly the inputs the owner declares for the leaf’s type, and no empty choice', () => {
    expect(drawn(scene(), 'good')).toEqual({ stale: false, rows: ['prev', 'input'] });
  });

  it('a name the owner does not declare is shown as not found, beside the real choices', () => {
    expect(drawn(scene(), 'typo')).toEqual({
      stale: true,
      rows: ['prve — not found (disabled)', 'prev', 'input'],
    });
  });

  it('a leaf in no sub-network says so instead of offering a list', () => {
    expect(drawn(scene(), 'stray')).toEqual({
      locked: 'not inside a sub-network, so nothing feeds it',
    });
  });

  it('picking a real input clears the notice', () => {
    const fixed = apply(scene(), [
      { type: 'setParam', nodeId: 'typo', paramPath: 'input', value: 'prev' },
    ]);
    expect(drawn(fixed, 'typo')).toEqual({ stale: false, rows: ['prev', 'input'] });
  });

  it('the picker does not change what `input` accepts: a project holding a bad name still loads', () => {
    const before = z.string().min(1).default('input');
    const cases: unknown[] = [undefined, '', 'prev', 'prve', 'a name nobody declares', 42, null];
    const verdict = (s: z.ZodTypeAny, v: unknown) => {
      const r = s.safeParse(v);
      return r.success ? { ok: true, value: r.data } : { ok: false };
    };
    expect({
      examined: cases.length,
      now: cases.map((v) => verdict(field('BodyInput'), v)),
    }).toEqual({ examined: 7, now: cases.map((v) => verdict(before, v)) });
  });
});
