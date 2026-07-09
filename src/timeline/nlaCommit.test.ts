// nlaCommit funnel tests (epic #283 Phase 5, inc 5C — the R4 mitigation).
//
// The contract under test: {ok:false} → EXACTLY ONE error toast carrying the
// reason verbatim; {ok:true} → no toast; the result is RETURNED either way
// (so the 5D popover can also show the reason inline). The raw road
// (`commitNlaSetParam`) normalizes dispatchAtomic's THROW into the same
// {ok:false, reason} + toast shape and really writes the param on success.
//
// The mutator road is mocked at the dispatchMutator seam (the five gates have
// their own suite); the raw road runs against the REAL dag store + node
// registry (the throw-on-invalid behavior is the thing being normalized).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { useDagStore } from '../core/dag/store';
import { useNotificationStore } from '../app/stores/notificationStore';
import { dispatchMutatorFromUI } from '../app/animate/dispatchMutator';
import { commitNla, commitNlaSetParam } from './nlaCommit';

vi.mock('../app/animate/dispatchMutator', () => ({
  dispatchMutatorFromUI: vi.fn(),
}));
const mockedDispatch = vi.mocked(dispatchMutatorFromUI);

beforeEach(() => {
  vi.clearAllMocks();
  useNotificationStore.setState({ toasts: [], nextId: 1 });
});

describe('commitNla (the mutator road)', () => {
  it('{ok:true} → no toast, result returned', () => {
    mockedDispatch.mockReturnValue({ ok: true });
    const res = commitNla('mutator.nla.setStripTiming', { stripId: 's1', start: 1 }, 'Move strip');
    expect(res).toEqual({ ok: true });
    expect(mockedDispatch).toHaveBeenCalledWith(
      'mutator.nla.setStripTiming',
      { stripId: 's1', start: 1 },
      'Move strip',
    );
    expect(useNotificationStore.getState().toasts).toHaveLength(0);
  });

  it('{ok:false} → exactly one error toast with the reason verbatim; result returned', () => {
    mockedDispatch.mockReturnValue({ ok: false, reason: 'stripId "gone" not in DAG.' });
    const res = commitNla('mutator.nla.setStripTiming', { stripId: 'gone', start: 1 }, 'Move');
    expect(res).toEqual({ ok: false, reason: 'stripId "gone" not in DAG.' });
    const { toasts } = useNotificationStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('error');
    expect(toasts[0].message).toBe('stripId "gone" not in DAG.');
  });
});

describe('commitNlaSetParam (the sanctioned raw road)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it('writes the param atomically and returns {ok:true} with no toast', () => {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'strip1',
      nodeType: 'Strip',
      params: { name: 'walk', action: 'act1', target: 'n_box' },
    }).next;
    useDagStore.getState().hydrate(s);

    const res = commitNlaSetParam('strip1', 'muted', true, 'toggle strip mute');
    expect(res).toEqual({ ok: true });
    expect((useDagStore.getState().state.nodes.strip1.params as { muted?: boolean }).muted).toBe(
      true,
    );
    expect(useNotificationStore.getState().toasts).toHaveLength(0);
  });

  it('normalizes the dispatchAtomic THROW into {ok:false, reason} + one error toast', () => {
    useDagStore.getState().hydrate(emptyDagState());
    const res = commitNlaSetParam('no_such_node', 'muted', true, 'toggle strip mute');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
    const { toasts } = useNotificationStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('error');
  });
});
