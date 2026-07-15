// studioProfiles — the profile reader + Op-builders (#208 increment 3). Asserts the
// BLS-grounded behaviour on Basher's substrate: "+ Profile" creates a rig + wires a
// LightProfileSelect → scene (and adopts legacy free studio lights on the FIRST
// profile); switching is one setParam; deleting removes the rig + its light subtree.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import {
  buildAddProfileOps,
  buildDeleteProfileOps,
  buildSelectProfileOp,
  enumerateProfiles,
} from './studioProfiles';
import { buildAddStudioLightOps } from './addStudioLight';
import { resolveActiveRigNode, resolveRigLightSources } from './resolveRigLightSources';

function apply(state: DagState, ops: Op[]): DagState {
  let next = state;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

describe('studioProfiles (#208)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it('the first "+ Profile" creates a rig + select wired to the scene and activates it', () => {
    const state = buildDefaultDagState();
    const result = buildAddProfileOps(state, 'Key', [0, 0, 0]);
    expect(result).not.toBeNull();
    const next = apply(state, result!.ops);

    const profiles = enumerateProfiles(next);
    expect(profiles.map((p) => p.name)).toEqual(['Key']);
    expect(profiles[0].active).toBe(true);
    expect(resolveActiveRigNode(next)).toBe(result!.rigId);
  });

  it('the first profile ADOPTS legacy free studio lights (scene.lights → rig.lights)', () => {
    // A pre-profile studio light wired directly into scene.lights (the #205–#207 path).
    let state = buildDefaultDagState();
    const add = buildAddStudioLightOps(state, [0, 0, 0]); // no rig → legacy scene.lights
    state = apply(state, add!.ops);
    const sceneId = state.outputs.scene!.node;
    const sceneLightsBefore = (state.nodes[sceneId].inputs.lights as { node: string }[]).map(
      (r) => r.node,
    );
    expect(sceneLightsBefore).toContain(add!.lightId);

    // First profile adopts it.
    const prof = buildAddProfileOps(state, 'Key', [0, 0, 0]);
    state = apply(state, prof!.ops);

    // The light is now under the rig, NOT on scene.lights.
    expect(resolveRigLightSources(state)).toContain(add!.lightId);
    const sceneLightsAfter = (state.nodes[sceneId].inputs.lights as { node: string }[]).map(
      (r) => r.node,
    );
    expect(sceneLightsAfter).not.toContain(add!.lightId);
  });

  it('a second profile reuses the existing select and switching is one setParam', () => {
    let state = buildDefaultDagState();
    state = apply(state, buildAddProfileOps(state, 'Key', [0, 0, 0])!.ops);
    state = apply(state, buildAddProfileOps(state, 'Rim', [0, 0, 0])!.ops);

    // Exactly ONE select node exists (reused), and "Rim" (the latest) is live.
    const selectNodes = Object.values(state.nodes).filter((n) => n.type === 'LightProfileSelect');
    expect(selectNodes).toHaveLength(1);
    expect(enumerateProfiles(state).find((p) => p.active)?.name).toBe('Rim');

    // Switch back to Key with one Op.
    const op = buildSelectProfileOp(state, 'Key');
    expect(op).not.toBeNull();
    state = apply(state, [op!]);
    expect(enumerateProfiles(state).find((p) => p.active)?.name).toBe('Key');
  });

  it('deleting a profile removes its rig + lights, and re-points the select to a survivor', () => {
    let state = buildDefaultDagState();
    const key = buildAddProfileOps(state, 'Key', [0, 0, 0])!;
    state = apply(state, key.ops);
    // Add a light into Key (active rig).
    const light = buildAddStudioLightOps(state, [0, 0, 0], resolveActiveRigNode(state));
    state = apply(state, light!.ops);
    state = apply(state, buildAddProfileOps(state, 'Rim', [0, 0, 0])!.ops);

    // Delete Key.
    const ops = buildDeleteProfileOps(state, key.rigId);
    expect(ops).not.toBeNull();
    state = apply(state, ops!);

    const profiles = enumerateProfiles(state);
    expect(profiles.map((p) => p.name)).toEqual(['Rim']);
    // Key's rig and its light are gone.
    expect(state.nodes[key.rigId]).toBeUndefined();
    expect(state.nodes[light!.lightId]).toBeUndefined();
  });

  // #339 — deleting a profile must take the light's WHOLE pose stack, of EVERY band, not
  // just its aim. The rig light already carries a Track-To; give it a Follow-Path too and
  // both constraint nodes must go. Left behind, the Follow-Path is an ORPHAN pointing at a
  // deleted light — #317's bug, which its own comment predicted would return "once
  // Follow-Path lands". It did: narrowing the shared enumeration to the aim band (#339)
  // re-opened it, and only this test says so.
  it('deleting a profile removes EVERY band of its lights’ constraints — no orphan', () => {
    let state = buildDefaultDagState();
    const key = buildAddProfileOps(state, 'Key', [0, 0, 0])!;
    state = apply(state, key.ops);
    const light = buildAddStudioLightOps(state, [0, 0, 0], resolveActiveRigNode(state));
    state = apply(state, light!.ops);

    // The rig light gains a second constraint on the OTHER band.
    state = apply(state, [
      {
        type: 'addNode',
        nodeId: 'n_fp_light',
        nodeType: 'FollowPath',
        params: { target: light!.lightId, curve: '', order: 1 },
      },
    ]);
    expect(state.nodes['n_fp_light']).toBeDefined();

    state = apply(state, buildDeleteProfileOps(state, key.rigId)!);

    expect(state.nodes[light!.lightId]).toBeUndefined();
    expect(
      state.nodes['n_fp_light'],
      'the Follow-Path must not outlive the light it targets',
    ).toBeUndefined();
  });

  it('de-dupes a colliding "+ Profile" name (count renumber after a delete)', () => {
    let state = buildDefaultDagState();
    // [Profile 1, Profile 2], then delete Profile 1 → count is 1 again.
    const p1 = buildAddProfileOps(state, 'Profile 1', [0, 0, 0])!;
    state = apply(state, p1.ops);
    state = apply(state, buildAddProfileOps(state, 'Profile 2', [0, 0, 0])!.ops);
    state = apply(state, buildDeleteProfileOps(state, p1.rigId)!);
    // The panel would mint "Profile 2" again (length 1 + 1) → must NOT collide.
    const next = buildAddProfileOps(state, 'Profile 2', [0, 0, 0])!;
    state = apply(state, next.ops);
    const names = enumerateProfiles(state)
      .map((p) => p.name)
      .sort();
    expect(names).toEqual(['Profile 2', 'Profile 2 (2)']);
  });

  it('returns null when the scene aggregator is missing', () => {
    const state = buildDefaultDagState();
    const broken = { ...state, outputs: { ...state.outputs, scene: undefined } };
    expect(buildAddProfileOps(broken, 'Key', [0, 0, 0])).toBeNull();
  });
});
