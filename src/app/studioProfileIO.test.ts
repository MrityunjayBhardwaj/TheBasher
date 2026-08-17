// studioProfileIO — JSON import/export round-trip (#208 increment 4). Asserts the
// BLS-grounded contract: compose a rig → JSON → import rebuilds an equivalent rig
// (lights in order, params preserved, tex carried), and name collisions are
// suffixed so the name-keyed select stays unambiguous.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildAddProfileOps } from './studioProfiles';
import { buildAddStudioLightOps } from './addStudioLight';
import { resolveActiveRigNode } from './resolveRigLightSources';
import { linkedDataNodeId } from './resolveDataParamOwner';
import {
  buildImportProfilesOps,
  composeProfile,
  composeProfilesFile,
  parseProfilesFile,
  PROFILES_FORMAT,
} from './studioProfileIO';

function apply(state: DagState, ops: Op[]): DagState {
  let next = state;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

/** A scene with one profile "Key" holding two lights (one textured). */
function sceneWithKeyProfile(): DagState {
  let state = buildDefaultDagState();
  state = apply(state, buildAddProfileOps(state, 'Key', [1, 0, 0])!.ops);
  const rigId = resolveActiveRigNode(state)!;
  state = apply(state, buildAddStudioLightOps(state, [1, 0, 0], rigId)!.ops);
  const l2 = buildAddStudioLightOps(state, [1, 0, 0], rigId)!;
  state = apply(state, l2.ops);
  // Texture the second light. #386 C3 — a studio light is now an Object posing an Area
  // LightData; `tex` lives on the LightData, so the raw setParam targets the DATA id (the
  // durable post-split pattern), exactly as the panel routes it through resolveDataParamOwner.
  const texTarget = linkedDataNodeId(state, l2.lightId) ?? l2.lightId;
  state = apply(state, [
    { type: 'setParam', nodeId: texTarget, paramPath: 'tex', value: 'env-hdri/abc' },
  ]);
  return state;
}

describe('studioProfileIO (#208)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('composes a rig into the portable JSON shape (name/center/radius + lights in order)', () => {
    const state = sceneWithKeyProfile();
    const rigId = resolveActiveRigNode(state)!;
    const json = composeProfile(state, rigId);
    expect(json).not.toBeNull();
    expect(json!.name).toBe('Key');
    expect(json!.center).toEqual([1, 0, 0]);
    expect(json!.lights).toHaveLength(2);
    expect(json!.lights[1].tex).toBe('env-hdri/abc');
  });

  it('round-trips: export → parse → import rebuilds an equivalent profile', () => {
    const state = sceneWithKeyProfile();
    const file = composeProfilesFile(state);
    expect(file.format).toBe(PROFILES_FORMAT);
    expect(file.profiles).toHaveLength(1);

    // Serialize + reparse (proves the JSON is valid + schema-conformant).
    const reparsed = parseProfilesFile(JSON.parse(JSON.stringify(file)));

    // Import into a FRESH scene.
    let fresh = buildDefaultDagState();
    const result = buildImportProfilesOps(fresh, reparsed);
    expect(result.activatedName).toBe('Key');
    fresh = apply(fresh, result.ops);

    // The rebuilt active rig matches the source (composed again → deep equal).
    const newRigId = resolveActiveRigNode(fresh)!;
    const rebuilt = composeProfile(fresh, newRigId);
    const source = composeProfile(state, resolveActiveRigNode(state)!);
    expect(rebuilt).toEqual(source);
  });

  it('suffixes a colliding imported name so the name-keyed select stays unambiguous', () => {
    let state = sceneWithKeyProfile(); // already has "Key"
    const file = composeProfilesFile(state); // a profile named "Key"
    const result = buildImportProfilesOps(state, file);
    expect(result.activatedName).toBe('Key (2)'); // de-duped against the existing "Key"
    state = apply(state, result.ops);
    const names = Object.values(state.nodes)
      .filter((n) => n.type === 'LightRig')
      .map((n) => (n.params as { name?: string }).name);
    expect(names).toContain('Key');
    expect(names).toContain('Key (2)');
  });

  // #625 — the composed profile is a PORTABLE snapshot, so none of its number
  // triples may be the live params array they were read from. Each field below is
  // seeded with a value that differs from the helper's fallback, so a copy that
  // silently degrades to the fallback fails this too (a `toEqual` + `not.toBe`
  // pair on a value equal to the fallback would pass vacuously).
  it('detaches every vec3 it emits from the live params arrays', () => {
    let state = sceneWithKeyProfile();
    const rigId = resolveActiveRigNode(state)!;
    const lightId = (state.nodes[rigId].inputs.lights as { node: string }[])[0].node;
    state = apply(state, [
      { type: 'setParam', nodeId: lightId, paramPath: 'rotation', value: [0.1, 0.2, 0.3] },
      { type: 'setParam', nodeId: lightId, paramPath: 'scale', value: [2, 3, 4] },
    ]);

    const lp = state.nodes[lightId].params as Record<string, [number, number, number]>;
    const rp = state.nodes[rigId].params as Record<string, [number, number, number]>;
    const json = composeProfile(state, rigId)!;

    // Read the authored value (not the fallback) ...
    expect(json.lights[0].position).toEqual(lp.position);
    expect(json.lights[0].rotation).toEqual([0.1, 0.2, 0.3]);
    expect(json.lights[0].scale).toEqual([2, 3, 4]);
    expect(json.center).toEqual([1, 0, 0]);
    // ... through a copy.
    expect(json.lights[0].position).not.toBe(lp.position);
    expect(json.lights[0].rotation).not.toBe(lp.rotation);
    expect(json.lights[0].scale).not.toBe(lp.scale);
    expect(json.center).not.toBe(rp.center);

    // Editing the emitted profile leaves the scene alone.
    json.lights[0].position[0] = 999;
    json.center[2] = -7;
    expect(lp.position[0]).not.toBe(999);
    expect(rp.center[2]).toBe(0);
  });

  it('rejects a malformed file', () => {
    expect(() => parseProfilesFile({ nope: true })).toThrow();
    expect(() => parseProfilesFile({ format: PROFILES_FORMAT, version: 1 })).toThrow();
  });
});
