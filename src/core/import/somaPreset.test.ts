// SOMA — the skeleton phase A1's generator emits, and the two presets that carry
// it onto rigs we already support. See scripts/gen-soma-motion-fixture.mjs.
//
// The value here is not that the maps exist; it is that they are keyed on
// PARENTAGE rather than on names. SOMA and Mixamo both use the word "Leg" and
// mean different bones by it, so a map anyone would produce by matching names
// binds each thigh onto the corresponding shin — a rig that animates, looks
// wrong in a way nobody can name, and raises no error at any layer. These tests
// are written so that "tidying" the map back into name-identity goes red.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBvh } from './bvh';
import { retargetClip } from './retarget';
import { getBoneNameMapPreset } from './boneNameMaps';
import type { BoneSpec } from '../../nodes/types';

const somaBvh = () =>
  readFileSync(resolve(process.cwd(), 'public/fixtures/anim/soma-generated.bvh'), 'utf8');

const rigOf = (map: Readonly<Record<string, string>>): BoneSpec[] =>
  Object.values(map).map((name) => ({
    name,
    parent: -1,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  }));

describe("what the generator's BVH actually looks like", () => {
  // Both facts came out of kimodo/exports/bvh.py, and both are things a consumer
  // written against the skeleton definition alone would get wrong.
  it('carries a Root wrapper above Hips, so the joint count is one more than the skeleton', () => {
    const bones = parseBvh(somaBvh(), 'soma').skeletonParams.bones;
    expect(bones.map((b) => b.name).slice(0, 2)).toEqual(['Root', 'Hips']);
    expect(bones).toHaveLength(78); // 77 SOMA joints + the wrapper
  });

  it('parses even though its leaves carry no End Site block', () => {
    // The exporter strips them. Every other fixture in this repo has them, so
    // nothing else here can tell us whether the loader minds — and if it did,
    // A1's whole contract would break at this seam rather than somewhere
    // debuggable. It does not mind.
    expect(somaBvh()).not.toContain('End Site');
    const parsed = parseBvh(somaBvh(), 'soma');
    expect(parsed.clipParams.keyframes.length).toBeGreaterThan(0);
  });

  it('names joints bare — no namespace to sanitise away', () => {
    const names = parseBvh(somaBvh(), 'soma').skeletonParams.bones.map((b) => b.name);
    expect(names).toContain('Hips');
    expect(names.some((n) => n.includes('_') || n.includes(':'))).toBe(false);
  });
});

describe('the leg vocabulary trap', () => {
  // SOMA:   Hips → LeftLeg (thigh) → LeftShin → LeftFoot
  // Mixamo: Hips → LeftUpLeg (thigh) → LeftLeg (shin) → LeftFoot
  it('maps SOMA thigh to Mixamo thigh, NOT to the like-named Mixamo shin', () => {
    const map = getBoneNameMapPreset('somaToMixamo')!.map;
    expect(map.LeftLeg).toBe('mixamorig_LeftUpLeg');
    expect(map.LeftShin).toBe('mixamorig_LeftLeg');
    expect(map.RightLeg).toBe('mixamorig_RightUpLeg');
    expect(map.RightShin).toBe('mixamorig_RightLeg');
    // Stated as its own assertion because this is the shape the mistake takes.
    expect(map.LeftLeg).not.toBe('mixamorig_LeftLeg');
    expect(map.RightLeg).not.toBe('mixamorig_RightLeg');
  });

  it('maps SOMA thigh to thigh on the glTF humanoid target too', () => {
    const map = getBoneNameMapPreset('somaToGltf')!.map;
    expect(map.LeftLeg).toBe('thigh.L');
    expect(map.LeftShin).toBe('shin.L');
    expect(map.RightLeg).toBe('thigh.R');
    expect(map.RightShin).toBe('shin.R');
  });

  it('accounts for the spine and neck mismatch structurally', () => {
    // SOMA is Spine1 → Spine2 → Chest where Mixamo is Spine → Spine1 → Spine2,
    // so every spine row is off by one name and right by one position.
    const map = getBoneNameMapPreset('somaToMixamo')!.map;
    expect(map.Spine1).toBe('mixamorig_Spine');
    expect(map.Spine2).toBe('mixamorig_Spine1');
    expect(map.Chest).toBe('mixamorig_Spine2');
    // Two SOMA neck joints, one target neck. Neck1 takes it — same position in
    // the chain — and Neck2 is deliberately absent rather than colliding.
    expect(map.Neck1).toBe('mixamorig_Neck');
    expect(map.Neck2).toBeUndefined();
  });
});

describe('a generated SOMA clip drives a rig end to end', () => {
  for (const id of ['somaToMixamo', 'somaToGltf'] as const) {
    it(`binds every target bone through ${id}`, () => {
      const preset = getBoneNameMapPreset(id)!;
      const source = parseBvh(somaBvh(), 'soma');
      const result = retargetClip({
        sourceBones: source.skeletonParams.bones,
        sourceClip: source.clipParams,
        targetBones: rigOf(preset.map),
        nameMap: preset.map,
      });
      expect(result.unboundTargetBones).toEqual([]);
      expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
    });
  }

  it('leaves the joints no target rig has — fingers, jaw, eyes — reported, not silently dropped', () => {
    const preset = getBoneNameMapPreset('somaToMixamo')!;
    const source = parseBvh(somaBvh(), 'soma');
    const result = retargetClip({
      sourceBones: source.skeletonParams.bones,
      sourceClip: source.clipParams,
      targetBones: rigOf(preset.map),
      nameMap: preset.map,
    });
    // An honest answer beats a flattering one: SOMA carries finger chains and a
    // jaw that neither target vocabulary has, and the caller can see which.
    expect(result.unmappedSourceBones).toContain('Jaw');
    expect(result.unmappedSourceBones).toContain('LeftHandThumb1');
    expect(result.unmappedSourceBones).toContain('Root');
  });
});
