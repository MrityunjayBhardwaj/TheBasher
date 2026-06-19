// LightProfileSelect — the profile switch (epic #201, slice #208 increment 2).
// Verifies it picks the live rig by name (the ClipSelect pattern) and surfaces
// null-on-miss so a gone profile is visible, not silently the first rig.

import { describe, expect, it } from 'vitest';
import { LightProfileSelectNode, LightProfileSelectParams } from './LightProfileSelect';
import type { LightRigValue } from './types';

function rig(name: string): LightRigValue {
  return { kind: 'LightRig', name, center: [0, 0, 0], radius: 6, lights: [] };
}

describe('LightProfileSelect node (#208)', () => {
  const rigs = [rig('Key setup'), rig('Rim setup')];

  it('picks the rig whose name matches selectedProfile', () => {
    const params = LightProfileSelectParams.parse({ selectedProfile: 'Rim setup' });
    const value = LightProfileSelectNode.evaluate(params, { rigs });
    expect(value?.name).toBe('Rim setup');
  });

  it('returns null when no rig name matches (a gone profile is visible, not the first)', () => {
    const params = LightProfileSelectParams.parse({ selectedProfile: 'Deleted' });
    expect(LightProfileSelectNode.evaluate(params, { rigs })).toBeNull();
  });

  it('returns null for the empty default (no profile selected yet)', () => {
    const params = LightProfileSelectParams.parse({});
    expect(LightProfileSelectNode.evaluate(params, { rigs })).toBeNull();
  });

  it('tolerates a single (non-array) rig binding', () => {
    const params = LightProfileSelectParams.parse({ selectedProfile: 'Key setup' });
    const value = LightProfileSelectNode.evaluate(params, { rigs: rig('Key setup') });
    expect(value?.name).toBe('Key setup');
  });
});
