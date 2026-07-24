// studioProfileIO — JSON import/export round-trip (#208 increment 4). Asserts the
// BLS-grounded contract: compose a rig → JSON → import rebuilds an equivalent rig
// (lights in order, params preserved, tex carried), and name collisions are
// suffixed so the name-keyed select stays unambiguous.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
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
    __reseedAllNodesForTests();
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

  it('rejects a malformed file', () => {
    expect(() => parseProfilesFile({ nope: true })).toThrow();
    expect(() => parseProfilesFile({ format: PROFILES_FORMAT, version: 1 })).toThrow();
  });
});
