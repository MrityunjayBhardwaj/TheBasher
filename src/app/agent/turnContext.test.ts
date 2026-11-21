// #1705 — what each chip says, and what a turn sends from them. The chip on screen and the line
// the model receives come from these same functions, so they are tested once, here.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import { useSelectionStore } from '../stores/selectionStore';
import { useTimeStore } from '../stores/timeStore';
import { paneLabel, useAgentContextStore } from '../stores/agentContextStore';
import { currentTurnContext, filmShots, whatLabel, whenLabel } from './turnContext';

__resetRegistryForTests();
registerAllNodes();

beforeEach(() => {
  useDagStore.getState().hydrate(buildDefaultDagState());
  useSelectionStore.getState().select(null);
  useTimeStore.getState().setTime(0);
  useAgentContextStore.setState({ lastPane: null, subjects: {} });
  useAgentContextStore.getState().resetDismissed();
});

const state = () => useDagStore.getState().state;

describe('#1705 — the chips in words', () => {
  it('What names the selection, or says there is none', () => {
    expect(whatLabel(state(), new Set())).toBe('nothing selected');
    const one = whatLabel(state(), new Set(['n_box']));
    expect(one).not.toBe('nothing selected');
    expect(whatLabel(state(), new Set(['n_box', 'n_light']))).toBe(`${one} + 1 more`);
    // A selected id that is not in the scene is not named.
    expect(whatLabel(state(), new Set(['gone']))).toBe('nothing selected');
  });

  it('Where is the pane, with what it shows when it says', () => {
    expect(paneLabel(null, {})).toBeNull();
    expect(paneLabel('curves', {})).toBe('Curves');
    expect(paneLabel('curves', { curves: 'Box position' })).toBe('Curves · Box position');
    expect(paneLabel('nodes', { nodes: 'Hull' })).toBe('Nodes › Hull');
    // Another pane's subject is not borrowed.
    expect(paneLabel('shots', { curves: 'Box position' })).toBe('Shots');
  });

  it('When is the playhead to the hundredth, with its shot when a camera films one', () => {
    const label = whenLabel(filmShots(state()), 3.4);
    expect(label).toMatch(/3\.40 s$/);
    expect(label).toMatch(/^(Shot 1 · )?3\.40 s$/);
  });
});

describe('#1705 — what the next turn sends', () => {
  it('every chip, and the selection, when none is dismissed', () => {
    useSelectionStore.getState().select('n_box');
    useTimeStore.getState().setTime(1.5);
    useAgentContextStore.getState().markPane('curves');
    const { selectedNodeIds, context } = currentTurnContext();
    expect([...selectedNodeIds]).toEqual(['n_box']);
    expect(context.pane).toBe('Curves');
    expect(context.playhead).toMatch(/1\.50 s$/);
    expect(context.omitSelection).toBeUndefined();
  });

  it('a dismissed chip is left out, and a dismissed What sends no selection', () => {
    useSelectionStore.getState().select('n_box');
    useAgentContextStore.getState().markPane('nodes');
    const ctx = useAgentContextStore.getState();
    ctx.dismiss('where');
    ctx.dismiss('when');
    ctx.dismiss('what');
    const { selectedNodeIds, context } = currentTurnContext();
    expect(context).toEqual({ omitSelection: true });
    expect(selectedNodeIds.size).toBe(0);
    useAgentContextStore.getState().resetDismissed();
    expect(currentTurnContext().context.pane).toBe('Nodes');
  });

  it('no pane yet means no Where', () => {
    expect(currentTurnContext().context.pane).toBeUndefined();
  });
});
