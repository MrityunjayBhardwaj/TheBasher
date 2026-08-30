// The bridge chooser — #807.
//
// Every case here is a rig PAIR, because a map's fit is a property of two name
// sets and never of one. A test that fed only source names could pass while the
// chosen map wrote to bones the character does not have.

import { describe, it, expect } from 'vitest';
import { chooseBoneNameMap } from './chooseBoneNameMap';
import { getBoneNameMapPreset } from './boneNameMaps';

/** The SOMA names a Kimodo-generated BVH arrives with (the preset's own keys). */
const SOMA_SOURCE = Object.keys(getBoneNameMapPreset('somaToMixamo')!.map);
/** The Mixamo names a service-rigged character carries (the preset's own values). */
const MIXAMO_TARGET = Object.values(getBoneNameMapPreset('somaToMixamo')!.map);
/** The Rigify names that preset targets. */
const RIGIFY_TARGET = Object.values(getBoneNameMapPreset('mixamoToRigify')!.map);

describe('chooseBoneNameMap', () => {
  it('bridges generated SOMA motion onto a Mixamo-named character', () => {
    const choice = chooseBoneNameMap(SOMA_SOURCE, MIXAMO_TARGET);
    expect(choice).not.toBeNull();
    expect(choice!.presetId).toBe('somaToMixamo');
    expect(choice!.customMap).toBeNull();
    // Every SOMA bone lands — this pair is the one the preset was authored for.
    expect(choice!.mapped).toBe(choice!.total);
  });

  it('chooses the shared-name map when both rigs already speak one convention', () => {
    // A Mixamo .fbx dropped onto a service-rigged character. NO preset maps
    // mixamorig_* onto mixamorig_*, so a preset-only chooser would refuse a pair
    // that needs no translation at all.
    const choice = chooseBoneNameMap(MIXAMO_TARGET, MIXAMO_TARGET);
    expect(choice).not.toBeNull();
    expect(choice!.presetId).toBeNull();
    expect(choice!.customMap).not.toBeNull();
    expect(choice!.mapped).toBe(choice!.total);
    // The map is name → same name, not name → something plausible.
    for (const [from, to] of Object.entries(choice!.customMap!)) expect(to).toBe(from);
  });

  it('picks the preset that fits the target, not the one that fits the source', () => {
    // Mixamo-named motion, and the SAME source, offered two different characters.
    // The source alone cannot decide this: three presets take mixamorig_ keys.
    const ontoRigify = chooseBoneNameMap(MIXAMO_TARGET, RIGIFY_TARGET);
    expect(ontoRigify?.presetId).toBe('mixamoToRigify');

    const gltfTarget = Object.values(getBoneNameMapPreset('mixamoToGltf')!.map);
    const ontoGltf = chooseBoneNameMap(MIXAMO_TARGET, gltfTarget);
    expect(ontoGltf?.presetId).toBe('mixamoToGltf');
  });

  it('refuses when no candidate lands a single bone', () => {
    expect(chooseBoneNameMap(SOMA_SOURCE, ['wheel_fl', 'wheel_fr', 'chassis'])).toBeNull();
  });

  it('refuses an empty rig on either side rather than returning a zero-scoring map', () => {
    expect(chooseBoneNameMap([], MIXAMO_TARGET)).toBeNull();
    expect(chooseBoneNameMap(SOMA_SOURCE, [])).toBeNull();
  });

  it('counts bones that LAND, not entries the map declares', () => {
    // One shared bone out of a full SOMA rig. A chooser scoring map SIZE would
    // report 22; the honest reading is 1, and the caller needs the difference to
    // tell a real bridge from a coincidence.
    const choice = chooseBoneNameMap(SOMA_SOURCE, ['mixamorig_Hips']);
    expect(choice).not.toBeNull();
    expect(choice!.mapped).toBe(1);
    expect(choice!.total).toBe(SOMA_SOURCE.length);
  });

  it('is deterministic — the same pair chooses the same bridge every time', () => {
    const a = chooseBoneNameMap(SOMA_SOURCE, MIXAMO_TARGET);
    const b = chooseBoneNameMap(SOMA_SOURCE, MIXAMO_TARGET);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('ignores empty bone names on both sides', () => {
    // A skeleton can carry an unnamed bone; an empty name must never become a
    // map key, because it would match every other empty name.
    const choice = chooseBoneNameMap(['', ...SOMA_SOURCE], ['', ...MIXAMO_TARGET]);
    expect(choice!.total).toBe(SOMA_SOURCE.length);
    expect(choice!.presetId).toBe('somaToMixamo');
  });
});
