// newComposition — verify the pure op-builder + unique-name helper, and the
// active-comp store setter. The createNewComposition orchestration (DAG dispatch
// + active-comp selection) is covered by live observation / e2e.

import { beforeEach, describe, expect, it } from 'vitest';
import { buildNewCompositionOps, uniqueCompositionName } from './newComposition';
import { useCompositionStore } from '../stores/compositionStore';

describe('buildNewCompositionOps', () => {
  it('builds a single addNode op for a Composition with the given name', () => {
    const ops = buildNewCompositionOps('comp_1', 'Composition 1');
    expect(ops).toEqual([
      {
        type: 'addNode',
        nodeId: 'comp_1',
        nodeType: 'Composition',
        params: { name: 'Composition 1' },
      },
    ]);
  });
});

describe('uniqueCompositionName', () => {
  it('returns "Composition 1" when none are used', () => {
    expect(uniqueCompositionName([])).toBe('Composition 1');
  });

  it('skips used names to the first free index', () => {
    expect(uniqueCompositionName(['Composition 1', 'Composition 2'])).toBe('Composition 3');
  });

  it('fills a gap rather than always appending', () => {
    expect(uniqueCompositionName(['Composition 1', 'Composition 3'])).toBe('Composition 2');
  });
});

describe('compositionStore', () => {
  beforeEach(() => {
    useCompositionStore.setState({ activeCompositionId: null });
  });

  it('defaults to no active composition', () => {
    expect(useCompositionStore.getState().activeCompositionId).toBeNull();
  });

  it('setActiveComposition updates and clears the active id', () => {
    useCompositionStore.getState().setActiveComposition('comp_1');
    expect(useCompositionStore.getState().activeCompositionId).toBe('comp_1');
    useCompositionStore.getState().setActiveComposition(null);
    expect(useCompositionStore.getState().activeCompositionId).toBeNull();
  });
});
