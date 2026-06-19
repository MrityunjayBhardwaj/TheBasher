// studioLightRig — the pure read side of the 2D Light-Studio panel (#206).
// Asserts: only Track-To-aimed AreaLights enumerate (a free fill light is
// omitted); the entry carries position + name + tex; the rig centre derives from
// the lights' shared Track-To aim (point + node-ref), defaulting to origin.
//
// REF: src/app/studioLightRig.ts; vyapti V60; epic #201.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { enumerateStudioLights, resolveRigTarget } from './studioLightRig';

type Vec3 = [number, number, number];

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

/** Add an AreaLight `lightId` at `pos`; optionally aim it via a Track-To at the
 *  fixed point `aimPoint`, with an optional `tex` + display name. */
function addAreaLight(
  state: DagState,
  lightId: string,
  pos: Vec3,
  opts: { aimPoint?: Vec3; tex?: string; name?: string } = {},
): DagState {
  let next = applyOp(state, {
    type: 'addNode',
    nodeId: lightId,
    nodeType: 'AreaLight',
    params: {
      position: pos,
      ...(opts.tex ? { tex: opts.tex } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    },
  }).next;
  if (opts.aimPoint) {
    next = applyOp(next, {
      type: 'addNode',
      nodeId: `${lightId}_tt`,
      nodeType: 'TrackTo',
      params: {
        target: lightId,
        aimNode: '',
        aimPoint: opts.aimPoint,
        up: [0, 1, 0],
        mute: false,
      },
    }).next;
  }
  return next;
}

describe('enumerateStudioLights', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it('lists only AreaLights aimed by a Track-To (a free area light is omitted)', () => {
    let state = buildDefaultDagState();
    state = addAreaLight(state, 'n_rig', [0, 5, 0], { aimPoint: [0, 0, 0] });
    state = addAreaLight(state, 'n_free', [3, 0, 0]); // no Track-To → not on the rig

    const lights = enumerateStudioLights(state.nodes);
    expect(lights.map((l) => l.nodeId)).toEqual(['n_rig']);
    // AreaLight has no `name` param, so nodeDisplayName falls back to the id
    // (meta.name is set on rename — V34 single identity).
    expect(lights[0].name).toBe('n_rig');
    expect(lights[0].position).toEqual([0, 5, 0]);
  });

  it('carries the optional emitter tex through', () => {
    let state = buildDefaultDagState();
    state = addAreaLight(state, 'n_rig', [0, 3, 0], { aimPoint: [0, 0, 0], tex: 'env-hdri/abc' });
    const [light] = enumerateStudioLights(state.nodes);
    expect(light.tex).toBe('env-hdri/abc');
  });

  it('is empty when no area light is rig-aimed', () => {
    const state = buildDefaultDagState();
    expect(enumerateStudioLights(state.nodes)).toEqual([]);
  });
});

describe('resolveRigTarget', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it('derives the centre from the first rig light’s fixed aim point', () => {
    let state = buildDefaultDagState();
    state = addAreaLight(state, 'n_rig', [0, 5, 0], { aimPoint: [1, 2, 3] });
    expect(resolveRigTarget(state, ctxAt(0))).toEqual([1, 2, 3]);
  });

  it('defaults to the world origin when there are no rig lights', () => {
    const state = buildDefaultDagState();
    expect(resolveRigTarget(state, ctxAt(0))).toEqual([0, 0, 0]);
  });
});
