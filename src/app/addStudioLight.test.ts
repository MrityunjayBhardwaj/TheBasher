// addStudioLight — the "+ Light" Op-chain builder (#206). Asserts the chain adds
// an AreaLight wired into scene.lights PLUS a Track-To aiming it at the rig
// centre, so the new light enumerates as a rig light and faces the subject.
//
// REF: src/app/addStudioLight.ts; src/app/studioLightRig.ts; vyapti V60.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildAddStudioLightOps } from './addStudioLight';
import { enumerateStudioLights } from './studioLightRig';

describe('buildAddStudioLightOps', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it('adds a Track-To-aimed AreaLight that enumerates as a rig light on the sphere', () => {
    const state = buildDefaultDagState();
    const result = buildAddStudioLightOps(state, [0, 0, 0]);
    expect(result).not.toBeNull();

    let next = state;
    for (const op of result!.ops) next = applyOp(next, op).next;

    const lights = enumerateStudioLights(next.nodes);
    expect(lights.map((l) => l.nodeId)).toEqual([result!.lightId]);
    // Spawned at radius 6 from the rig centre (the placement core's output).
    const r = Math.hypot(...lights[0].position);
    expect(r).toBeCloseTo(6, 5);
    // No emitter texture yet — a fresh light is a plain area light until tex is set.
    expect(lights[0].tex).toBeUndefined();
  });

  it('returns null when the scene aggregator is missing (corrupt project)', () => {
    const state = buildDefaultDagState();
    const broken = { ...state, outputs: { ...state.outputs, scene: undefined } };
    expect(buildAddStudioLightOps(broken, [0, 0, 0])).toBeNull();
  });
});
