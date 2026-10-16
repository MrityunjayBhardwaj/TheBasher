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

  // #1632 — the two bare-named rigs a character actually arrives with. Both share
  // enough names with SOMA (Hips, the arms, LeftLeg/LeftFoot…) that the identity map
  // scores 16 — and four of those sixteen are the WRONG bones: SOMA's LeftLeg is the
  // thigh, theirs is the shin. Measured in the app on a Meshy-rigged character before
  // the fix: identity won, the thighs were never driven.
  describe('bare-named Mixamo-style rigs (#1632)', () => {
    /** The full skeleton a Kimodo SOMA clip arrives with (78 bones, read from the app). */
    const SOMA_FULL = [
      'Root',
      'Hips',
      'Spine1',
      'Spine2',
      'Chest',
      'Neck1',
      'Neck2',
      'Head',
      'HeadEnd',
      'Jaw',
      'LeftEye',
      'RightEye',
      'LeftShoulder',
      'LeftArm',
      'LeftForeArm',
      'LeftHand',
      'LeftHandThumb1',
      'LeftHandIndex1',
      'RightShoulder',
      'RightArm',
      'RightForeArm',
      'RightHand',
      'RightHandThumb1',
      'RightHandIndex1',
      'LeftLeg',
      'LeftShin',
      'LeftFoot',
      'LeftToeBase',
      'LeftToeEnd',
      'RightLeg',
      'RightShin',
      'RightFoot',
      'RightToeBase',
      'RightToeEnd',
    ];
    /** Meshy's auto-rig (24 joints, read from a Meshy-rigged GLB in the app). */
    const MESHY = [
      'Hips',
      'Spine02',
      'Spine01',
      'Spine',
      'neck',
      'Head',
      'head_end',
      'headfront',
      'LeftShoulder',
      'LeftArm',
      'LeftForeArm',
      'LeftHand',
      'RightShoulder',
      'RightArm',
      'RightForeArm',
      'RightHand',
      'LeftUpLeg',
      'LeftLeg',
      'LeftFoot',
      'LeftToeBase',
      'RightUpLeg',
      'RightLeg',
      'RightFoot',
      'RightToeBase',
    ];
    /** Mixamo exported without the `mixamorig_` namespace. */
    const MIXAMO_BARE = [
      'Hips',
      'Spine',
      'Spine1',
      'Spine2',
      'Neck',
      'Head',
      'HeadTop_End',
      'LeftShoulder',
      'LeftArm',
      'LeftForeArm',
      'LeftHand',
      'RightShoulder',
      'RightArm',
      'RightForeArm',
      'RightHand',
      'LeftUpLeg',
      'LeftLeg',
      'LeftFoot',
      'LeftToeBase',
      'LeftToe_End',
      'RightUpLeg',
      'RightLeg',
      'RightFoot',
      'RightToeBase',
      'RightToe_End',
    ];
    /** Where a choice sends `name` — through the preset or the custom map. */
    const sends = (choice: ReturnType<typeof chooseBoneNameMap>, name: string) =>
      choice!.customMap?.[name] ?? getBoneNameMapPreset(choice!.presetId!)!.map[name];

    it('binds SOMA onto a Meshy rig thigh-to-thigh, spine by parentage', () => {
      const choice = chooseBoneNameMap(SOMA_FULL, MESHY);
      expect(choice!.presetId).toBe('somaToMeshy');
      expect(sends(choice, 'LeftLeg')).toBe('LeftUpLeg');
      expect(sends(choice, 'LeftShin')).toBe('LeftLeg');
      expect(sends(choice, 'RightLeg')).toBe('RightUpLeg');
      expect(sends(choice, 'Spine1')).toBe('Spine02');
      expect(sends(choice, 'Chest')).toBe('Spine');
      expect(sends(choice, 'Neck1')).toBe('neck');
    });

    it('binds SOMA onto bare Mixamo thigh-to-thigh', () => {
      const choice = chooseBoneNameMap(SOMA_FULL, MIXAMO_BARE);
      expect(choice!.presetId).toBe('somaToMixamoBare');
      expect(sends(choice, 'LeftLeg')).toBe('LeftUpLeg');
      expect(sends(choice, 'LeftShin')).toBe('LeftLeg');
      expect(sends(choice, 'Spine1')).toBe('Spine');
      expect(sends(choice, 'Neck1')).toBe('Neck');
    });

    it('every bridge lands every bone it declares on its own rig', () => {
      // A bridge naming a bone its rig lacks drops that bone silently. That neither bridge
      // wins on the OTHER's rig is the two cases above — they share most names, and a spine
      // mapped by the wrong convention would bend the torso at the wrong joint.
      for (const [rig, id] of [
        [MESHY, 'somaToMeshy'],
        [MIXAMO_BARE, 'somaToMixamoBare'],
      ] as const) {
        const map = getBoneNameMapPreset(id)!.map;
        for (const to of Object.values(map)) expect(rig, `${id} → ${to}`).toContain(to);
      }
    });
  });
});
