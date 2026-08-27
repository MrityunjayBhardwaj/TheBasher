// The agent picks a bone-name preset by reading the mutator's description. That
// description used to spell three preset ids as a literal, and it was already one
// short when the glTF bar-rig bridge shipped — a preset nobody can read about is
// one the agent reaches only by guessing wrong and reading the rejection.
//
// Fixing the literal once would leave the same trap armed for the next preset, so
// the description derives its list from the catalogue and this asserts the two
// cannot drift apart. Registering a preset is what announces it.

import { describe, expect, it } from 'vitest';
import { retargetMutator } from './retarget';
import { listBoneNameMapPresets } from '../../../core/import/boneNameMaps';

describe('the retarget mutator describes every preset it will accept', () => {
  it('names each catalogued preset id', () => {
    const presets = listBoneNameMapPresets();
    expect(presets.length).toBeGreaterThan(0);
    for (const preset of presets) {
      expect(retargetMutator.description, `${preset.id} is unreachable by name`).toContain(
        preset.id,
      );
    }
  });

  it('names no preset the catalogue does not have', () => {
    // The other direction: a preset removed from the catalogue must stop being
    // advertised, or the agent is invited to pass an id that gets rejected.
    const known = new Set(listBoneNameMapPresets().map((p) => p.id));
    const advertised = retargetMutator.description.match(/\b(?:mixamo|soma)[A-Za-z0-9]+\b/g) ?? [];
    expect(advertised.length).toBeGreaterThan(0);
    for (const id of advertised) {
      expect(known, `description advertises unknown preset "${id}"`).toContain(id);
    }
  });

  it('the SOMA presets in particular are reachable — they are what A1 generates onto', () => {
    expect(retargetMutator.description).toContain('somaToMixamo');
    expect(retargetMutator.description).toContain('somaToGltf');
  });
});
