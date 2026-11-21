// #1953 — the view flag: which nodes carry one, and what the viewport draws while one is set.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { applyOps } from '../core/dag/ops';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { buildAddModifierOps } from './operatorStack';
import { hiddenNodes } from './collections';
import { renderVisibilityStamps } from './renderVisibility';
import { pickTargetOf, viewedObjectOf, viewedState, viewFlagOf, VIEWING_SUFFIX } from './viewFlag';

beforeAll(() => registerAllNodes());

/** The default scene with an Array (count 4) on the box: BoxData → Array → Object. */
function withArray(): { state: DagState; arrayId: string } {
  const base = buildDefaultDagState();
  const add = buildAddModifierOps(base, 'n_box_data', 'ArrayModifier', { count: 4 }, 'arr');
  if (!add) throw new Error('could not add an Array');
  return { state: applyOps(base, add.ops).next, arrayId: add.modifierId };
}

/** What the object draws, as the evaluator hands it over: its data's kind and, for modified
 *  geometry, the outermost operation (an `array` descriptor carries its count). */
function drawn(state: DagState, objectId: string): string {
  const data = (evaluate(state, objectId).value as { data?: Record<string, unknown> }).data;
  if (!data) throw new Error(`${objectId} draws no data`);
  const d = (data.geometry as { descriptor?: { kind: string; count?: number } } | undefined)
    ?.descriptor;
  return d
    ? `${String(data.kind)}:${d.kind}${d.count !== undefined ? `×${d.count}` : ''}`
    : String(data.kind);
}

describe('viewFlagOf — #1953 which nodes carry a flag', () => {
  it('an object end is its final result; a step on its data lane is a step', () => {
    const { state, arrayId } = withArray();
    expect(viewFlagOf(state, 'n_box')).toBe('final');
    expect(viewFlagOf(state, arrayId)).toBe('step');
    expect(viewFlagOf(state, 'n_box_data')).toBe('step');
  });

  it('a constraint, the scene, the render output and the clock carry none', () => {
    const s = buildDefaultDagState();
    for (const id of ['n_light_aim', 'n_light_own_world', 'n_scene', 'n_render', 'n_time'])
      expect(viewFlagOf(s, id), id).toBeNull();
    expect(viewFlagOf(s, 'missing')).toBeNull();
  });
});

describe('viewedState — what the viewport draws while a node is flagged', () => {
  it('nothing flagged, or the object end: the same graph object', () => {
    const { state } = withArray();
    expect(viewedState(state, null)).toBe(state);
    expect(viewedState(state, 'n_box')).toBe(state);
    expect(viewedState(state, 'n_light_aim')).toBe(state);
  });

  it('a step: the viewport draws a stand-in wearing it; the object keeps its finished result', () => {
    const { state, arrayId } = withArray();
    const before = JSON.stringify(state.nodes);
    expect(viewedObjectOf(state, 'n_box_data')).toBe('n_box');
    expect(drawn(state, 'n_box')).toBe('ModifiedData:array×4');
    const viewed = viewedState(state, 'n_box_data');
    const standIn = `n_box${VIEWING_SUFFIX}`;
    // The stand-in wears the plain box, not the four the Array makes.
    expect(drawn(viewed, standIn)).toBe('MeshData:box');
    // #1955 — the object itself still wears the finished result.
    expect(drawn(viewed, 'n_box')).toBe('ModifiedData:array×4');
    // Viewing the Array itself is the final result (nothing sits above it): a stand-in again.
    expect(drawn(viewedState(state, arrayId), `n_box${VIEWING_SUFFIX}`)).toBe(
      'ModifiedData:array×4',
    );
    expect(JSON.stringify(state.nodes)).toBe(before);
  });

  it('#1955 — the flag is visibility: the object renders, the stand-in only shows in the viewport', () => {
    const { state } = withArray();
    const viewed = viewedState(state, 'n_box_data');
    const standIn = `n_box${VIEWING_SUFFIX}`;
    const stamps = renderVisibilityStamps(
      hiddenNodes(viewed, 'viewport'),
      hiddenNodes(viewed, 'render'),
    );
    expect(stamps.get('n_box')).toBe('render-only');
    expect(stamps.get(standIn)).toBe('viewport-only');
    // Drawn where the object is drawn: the scene lists it beside the object.
    const kids = viewed.nodes.n_scene.inputs.children as { node: string }[];
    expect(kids.map((k) => k.node)).toContain(standIn);
    expect(kids.map((k) => k.node)).toContain('n_box');
    // Nothing flagged: no stamps at all.
    expect(
      renderVisibilityStamps(hiddenNodes(state, 'viewport'), hiddenNodes(state, 'render')).size,
    ).toBe(0);
  });

  it('a pick on the stand-in selects its object', () => {
    expect(pickTargetOf(`n_box${VIEWING_SUFFIX}`)).toBe('n_box');
    expect(pickTargetOf('n_box')).toBe('n_box');
  });
});
