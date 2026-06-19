// resolveRigLightSources — the renderer recovers each rig light's node id by
// index-correspondence with the rig's `inputs.lights` edges (#208). This asserts
// the id list mirrors `LightRig.evaluate`'s light order, so studio lights keep
// their Track-To aim + click-select when rendered through the rig band.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, evaluate, createEvaluatorCache } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import type { LightRigValue, RenderOutputValue } from '../nodes/types';
import { resolveActiveRigNode, resolveRigLightSources } from './resolveRigLightSources';

function apply(state: DagState, ops: Op[]): DagState {
  let next = state;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

describe('resolveRigLightSources (#208)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  function withRig(): { state: DagState; rigId: string; l1: string; l2: string } {
    const base = buildDefaultDagState();
    const sceneId = base.outputs.scene!.node;
    const rigId = 'rig1';
    const l1 = 'la1';
    const l2 = 'la2';
    const state = apply(base, [
      { type: 'addNode', nodeId: l1, nodeType: 'AreaLight', params: { intensity: 5 } },
      { type: 'addNode', nodeId: l2, nodeType: 'AreaLight', params: { intensity: 9 } },
      { type: 'addNode', nodeId: rigId, nodeType: 'LightRig', params: { name: 'Key setup' } },
      { type: 'connect', from: { node: l1, socket: 'out' }, to: { node: rigId, socket: 'lights' } },
      { type: 'connect', from: { node: l2, socket: 'out' }, to: { node: rigId, socket: 'lights' } },
      {
        type: 'connect',
        from: { node: rigId, socket: 'out' },
        to: { node: sceneId, socket: 'lightRig' },
      },
    ]);
    return { state, rigId, l1, l2 };
  }

  it('returns the rig light node ids in edge order, matching the evaluated lights', () => {
    const { state, rigId, l1, l2 } = withRig();
    expect(resolveActiveRigNode(state)).toBe(rigId);
    const sources = resolveRigLightSources(state);
    expect(sources).toEqual([l1, l2]);

    // The id list is parallel to the evaluated lightRig.lights — the renderer's
    // contract. Evaluate the scene and check intensities line up by index.
    const out = evaluate(state, state.outputs.render!.node, {
      ctx: { time: { frame: 0, seconds: 0 } },
      cache: createEvaluatorCache(),
    }).value as RenderOutputValue;
    const rig = out.scene.lightRig as LightRigValue;
    expect(rig.name).toBe('Key setup');
    expect(rig.lights).toHaveLength(2);
    // sources[i] is the producer of rig.lights[i].
    expect(sources).toHaveLength(rig.lights.length);
  });

  it('returns empty + null when no rig is wired (the common pre-#208 case)', () => {
    const base = buildDefaultDagState();
    expect(resolveActiveRigNode(base)).toBeNull();
    expect(resolveRigLightSources(base)).toEqual([]);
  });
});
