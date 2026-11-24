// #1718 — whether a workflow's pictures are made from what it would make now, and what a
// regenerate runs: through the graph, so a still's edit reaches the shot it feeds by its wire.

import { beforeEach, describe, expect, it } from 'vitest';
import { writeBasherControllerValues } from '../core/comfy/basherControllers';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { registerAllNodes } from './registerAll';
import { FIXTURE_META, STILL_FILE, stillAndShots } from '../test-utils/stillAndShots';
import { regenerateOrder, workflowMadeState, workflowSourceHash } from './comfyWorkflowMade';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** Record every workflow as made from what it would make now, as a finished run does. */
function allMade(s: DagState): DagState {
  for (const id of ['sw', 'shot1', 'shot2']) {
    s = applyOp(s, {
      type: 'setParam',
      nodeId: id,
      paramPath: 'madeFrom',
      value: workflowSourceHash(s, id),
    }).next;
  }
  return s;
}

/** Edit the still workflow's prompt, as the Generated tab's prompt box does (un-keyed). */
function withStillPrompt(s: DagState, text: string): DagState {
  const apiJson = writeBasherControllerValues(STILL_FILE, { '2': [text] });
  return applyOp(s, {
    type: 'setParam',
    nodeId: 'sw',
    paramPath: 'graph',
    value: { apiJson, meta: FIXTURE_META },
  }).next;
}

describe('#1718 — a workflow knows whether its pictures are current', () => {
  it('a workflow that has never run is unmade, and current once its run is recorded', () => {
    const s = stillAndShots();
    expect(workflowMadeState(s, 'shot1')).toBe('unmade');
    expect(workflowMadeState(allMade(s), 'shot1')).toBe('current');
  });

  it("changing the still's prompt marks the still and the shot it feeds stale, not the other shot", () => {
    const s = withStillPrompt(allMade(stillAndShots()), 'a castle at dawn');
    expect(workflowMadeState(s, 'sw')).toBe('stale');
    expect(workflowMadeState(s, 'shot1')).toBe('stale');
    expect(workflowMadeState(s, 'shot2')).toBe('current');
  });

  it('a shot whose still is not wired is not touched by the still', () => {
    const s = withStillPrompt(allMade(stillAndShots({ wired: false })), 'a castle at dawn');
    expect(workflowMadeState(s, 'shot1')).toBe('current');
  });

  it('a workflow with no file cannot run', () => {
    const s = applyOp(stillAndShots(), {
      type: 'setParam',
      nodeId: 'shot2',
      paramPath: 'graph',
      value: null,
    }).next;
    expect(workflowMadeState(s, 'shot2')).toBe('cannot-run');
  });
});

describe('#1718 — what regenerating a shot runs', () => {
  it('the stale still first, then the shot, each once', () => {
    const s = withStillPrompt(allMade(stillAndShots()), 'a castle at dawn');
    expect(regenerateOrder(s, 'shot1')).toEqual(['sw', 'shot1']);
  });

  it('a current still is not run again; the shot always is', () => {
    expect(regenerateOrder(allMade(stillAndShots()), 'shot1')).toEqual(['shot1']);
  });

  it('a shot with no still runs alone', () => {
    const s = withStillPrompt(allMade(stillAndShots()), 'a castle at dawn');
    expect(regenerateOrder(s, 'shot2')).toEqual(['shot2']);
  });
});
