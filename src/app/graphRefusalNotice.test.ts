// #1586 — an edit the graph refuses says why, on screen.
//
// Three things are pinned. What is shown: the graph's own words, without the operation name it
// opens with, and a schema failure as a sentence rather than as JSON. What is NOT shown: an
// error that is not the graph refusing an edit. And the doors: every method of the store that
// applies operations throws, when it refuses, the kind of error the notice recognises; the
// methods are read off the store, so one added later has to be named here.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, validateOp } from '../core/dag';
import { GraphRefusal, OpError } from '../core/dag/ops';
import type { DagState } from '../core/dag/state';
import { emptyDagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { graphRefusalText, installGraphRefusalNotices } from './graphRefusalNotice';
import { useNotificationStore } from './stores/notificationStore';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useDagStore.getState().reset();
  useNotificationStore.getState().clear();
});

const add = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params,
});
const wire = (from: string, to: string, socket: string): Op => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket },
});
const apply = (ops: readonly Op[], from: DagState = emptyDagState()): DagState =>
  ops.reduce((s, op) => applyOp(s, validateOp(op)).next, from);

/** What `run` throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  throw new Error('nothing was thrown');
}

/** A Solver whose sub-network holds a Lag fed by a leaf naming an input the Solver lacks. */
const LAG_IN_SOLVER: readonly Op[] = [
  add('leaf', 'BodyInput', { input: 'prve' }),
  add('lag', 'Lag'),
  add('mix', 'Math', { op: 'add' }),
  wire('leaf', 'lag', 'in'),
  wire('lag', 'mix', 'a'),
  add('solver', 'Solver'),
  wire('mix', 'solver', 'body'),
];
const PICK_PREV: Op = { type: 'setParam', nodeId: 'leaf', paramPath: 'input', value: 'prev' };

describe('#1586 — what is shown for a refusal', () => {
  it('the graph`s own words, without the operation name they open with', () => {
    const error = thrownBy(() => applyOp(apply(LAG_IN_SOLVER), PICK_PREV));
    expect(error).toBeInstanceOf(OpError);
    expect((error as Error).message).toMatch(/^setParam: Lag "lag" is inside the sub-network/);
    const text = graphRefusalText(error);
    expect(text).toMatch(/^Lag "lag" is inside the sub-network of Solver "solver"/);
    // What to do instead, which is the point of showing it, survives the length cap.
    expect(text).toMatch(/Build the step into "solver"'s own sub-network instead/);
  });

  it('a loop', () => {
    const state = apply([add('a', 'Math'), add('b', 'Math'), wire('a', 'b', 'a')]);
    expect(graphRefusalText(thrownBy(() => applyOp(state, wire('b', 'a', 'a'))))).toBe(
      'would create a cycle (b → a)',
    );
  });

  it('a value the schema refuses, as a sentence and not as JSON', () => {
    const state = apply([add('m', 'Math')]);
    const error = thrownBy(() =>
      applyOp(state, { type: 'setParam', nodeId: 'm', paramPath: 'op', value: 'no such op' }),
    );
    expect((error as Error).message).toContain('params failed schema for Math: [');
    const text = graphRefusalText(error)!;
    expect(text).toMatch(/^Math op can't take that value: Invalid enum value\./);
    expect(text).not.toContain('{');
    expect(text).not.toContain('\n');
  });

  it('a removal that would leave a reference pointing at nothing', () => {
    const store = useDagStore.getState();
    store.dispatchAtomic([
      add('t', 'Math'),
      add('drv', 'ParamDriver', { target: 't', paramPath: 'op' }),
    ]);
    const error = thrownBy(() => store.dispatch({ type: 'removeNode', nodeId: 't' }));
    expect(error).toBeInstanceOf(GraphRefusal);
    expect(graphRefusalText(error)).toBe(
      'node "drv" would be left referencing removed node "t". Clear or remove the referrer in the same batch.',
    );
  });

  it('a very long refusal is cut, with a mark that it was', () => {
    const text = graphRefusalText(new GraphRefusal(`connect: ${'x'.repeat(900)}`))!;
    expect(text).toHaveLength(400);
    expect(text.endsWith('…')).toBe(true);
  });

  it('nothing for an error that is not the graph refusing an edit', () => {
    expect(graphRefusalText(new Error('connect: looks like one, is not'))).toBeNull();
    expect(graphRefusalText(new TypeError('x is not a function'))).toBeNull();
    expect(graphRefusalText('connect: a string')).toBeNull();
    expect(graphRefusalText(undefined)).toBeNull();
    // A malformed operation is a bug in the caller, not a refusal of an edit.
    expect(graphRefusalText(thrownBy(() => validateOp({ type: 'nope' })))).toBeNull();
  });
});

describe('#1586 — every door of the store refuses in the way the notice recognises', () => {
  /** A store holding `a → b`, with one undoable step that added `late`. */
  function seeded(): void {
    const store = useDagStore.getState();
    store.dispatchAtomic([add('a', 'Math'), add('b', 'Math'), wire('a', 'b', 'a')]);
    store.dispatch(add('late', 'Math'));
  }
  const LOOP = wire('b', 'a', 'a');

  /** Every function the store exposes: how to make it refuse, or why it cannot. */
  const DOORS: Record<string, (() => unknown) | 'applies no operation'> = {
    dispatch: () => useDagStore.getState().dispatch(LOOP),
    dispatchBatch: () => useDagStore.getState().dispatchBatch([add('ok', 'Math'), LOOP]),
    dispatchAtomic: () => useDagStore.getState().dispatchAtomic([add('ok', 'Math'), LOOP]),
    undo: () => {
      // The step to undo added `late`; something has come to consume it behind the log's back.
      const state = useDagStore.getState().state;
      useDagStore.setState({ state: apply([wire('late', 'b', 'b')], state) });
      return useDagStore.getState().undo();
    },
    redo: () => {
      useDagStore.getState().undo();
      const state = useDagStore.getState().state;
      useDagStore.setState({ state: apply([add('late', 'Math')], state) });
      return useDagStore.getState().redo();
    },
    hydrate: 'applies no operation',
    beginInteraction: 'applies no operation',
    endInteraction: 'applies no operation',
    reset: 'applies no operation',
  };

  it('the doors are the store`s own functions, all of them', () => {
    const store = useDagStore.getState() as unknown as Record<string, unknown>;
    const functions = Object.keys(store).filter((key) => typeof store[key] === 'function');
    expect(functions.sort()).toEqual(Object.keys(DOORS).sort());
  });

  for (const [door, refuse] of Object.entries(DOORS)) {
    if (refuse === 'applies no operation') continue;
    it(`${door}: a refused edit throws a refusal with something to show`, () => {
      seeded();
      const before = useDagStore.getState().state;
      const error = thrownBy(refuse);
      expect(error).toBeInstanceOf(GraphRefusal);
      expect(graphRefusalText(error)).not.toBeNull();
      // undo and redo were set up by replacing the state; the others must leave it alone.
      if (door.startsWith('dispatch')) expect(useDagStore.getState().state).toBe(before);
    });
  }
});

describe('#1586 — an uncaught refusal becomes a notice', () => {
  const toasts = () => useNotificationStore.getState().toasts;
  /** An event as the window reports an uncaught error or an unhandled rejection. */
  const report = (type: 'error' | 'unhandledrejection', thrown: unknown): Event =>
    Object.assign(new Event(type), type === 'error' ? { error: thrown } : { reason: thrown });
  const refusal = (): unknown => thrownBy(() => applyOp(apply(LAG_IN_SOLVER), PICK_PREV));

  it('an uncaught refusal is shown as an error, once however often it is reported', () => {
    const source = new EventTarget();
    installGraphRefusalNotices(source as never);
    const thrown = refusal();
    // React's development mode reports one handler error twice.
    source.dispatchEvent(report('error', thrown));
    source.dispatchEvent(report('error', thrown));
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].severity).toBe('error');
    expect(toasts()[0].message).toMatch(/^Lag "lag" is inside the sub-network of Solver "solver"/);
  });

  it('a refusal from an async handler is shown too', () => {
    const source = new EventTarget();
    installGraphRefusalNotices(source as never);
    source.dispatchEvent(report('unhandledrejection', refusal()));
    expect(toasts().map((t) => t.severity)).toEqual(['error']);
  });

  it('any other uncaught error shows nothing', () => {
    const source = new EventTarget();
    installGraphRefusalNotices(source as never);
    source.dispatchEvent(report('error', new TypeError('x is not a function')));
    source.dispatchEvent(report('unhandledrejection', new Error('network down')));
    source.dispatchEvent(report('error', undefined));
    expect(toasts()).toEqual([]);
  });

  it('stops when told to', () => {
    const source = new EventTarget();
    const stop = installGraphRefusalNotices(source as never);
    stop();
    source.dispatchEvent(report('error', refusal()));
    expect(toasts()).toEqual([]);
  });
});
