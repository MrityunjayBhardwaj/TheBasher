// projectGltfSkeleton unit tests — Phase 7.11 Wave C (issue #100, C1).
//
// Pins:
//   - Index discipline (the #1 bug site): BoneSpec[] in skin.joints[] order;
//     parent index read from the captured parentJointIndex; IBM attached to the
//     right bone; IBM OMITTED when the skin has none.
//   - The DEGREES → RADIANS convention (the Wave C/D correctness trap, H46/H20):
//     `bindTRS.rotation` is DEGREES (Wave A capture), `BoneSpec.rotation` is
//     RADIANS (the BVH/FBX contract from bonesToSpec / specToThreeSkeleton).
//     A known bind rotation projects to the expected radians AND round-trips
//     through specToThreeSkeleton without a deg/rad scale error.
//
// REF: PLAN.md Wave C (C1); projectGltfSkeleton.ts; threeAdapter.ts (the
// radians contract); viewport/rotation.ts (units); CONTEXT D-02/D-03.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Euler, MathUtils, Quaternion } from 'three';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { parseGltfContainer, resolveBuffers, type GltfJson } from './glb';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { specToThreeSkeleton } from './threeAdapter';
import type { GltfSkinMetadata } from '../../nodes/types';

function fixtureBuffer(name: string): ArrayBuffer {
  const node = readFileSync(resolve(process.cwd(), `public/assets/${name}`));
  return node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength) as ArrayBuffer;
}

async function projectFixture(name: string): Promise<{
  json: GltfJson;
  skin: GltfSkinMetadata;
}> {
  const { json, bin } = parseGltfContainer(fixtureBuffer(name));
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, `assets/${name}`);
  const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
  // `buildSkinMetadata`'s SkinMetadata is structurally the value-side
  // GltfSkinMetadata the projector consumes (same shape flows through
  // GltfAssetValue.skins). The cast pins that correspondence at the test.
  return { json, skin: skin as unknown as GltfSkinMetadata };
}

describe('projectGltfSkeleton — pure projection (P7.11 C1)', () => {
  it('skinned-bar.glb: 2 bones in joints order, parent index read from capture', async () => {
    const { skin } = await projectFixture('skinned-bar.glb');
    const { bones } = projectGltfSkeleton(skin);
    expect(bones).toHaveLength(2);
    // joints = [1, 0] → Bone0 (root) then Bone1 (child of Bone0).
    expect(bones.map((b) => b.name)).toEqual(['Bone0', 'Bone1']);
    expect(bones[0].parent).toBe(-1);
    expect(bones[1].parent).toBe(0);
  });

  it('skinned-bar.glb: IBM attached to the right bone (index i, column-major)', async () => {
    const { skin } = await projectFixture('skinned-bar.glb');
    const { bones } = projectGltfSkeleton(skin);
    // Both bones carry their captured IBM (skin declares inverseBindMatrices).
    expect(bones[0].inverseBindMatrix).toHaveLength(16);
    expect(bones[1].inverseBindMatrix).toHaveLength(16);
    // The 2nd joint's IBM carries the -1 translation Y anchor (RESEARCH B2).
    expect(bones[1].inverseBindMatrix![13]).toBeCloseTo(-1, 5);
    // It is the SAME datum the capture produced, attached at the same index.
    expect(bones[1].inverseBindMatrix).toEqual(skin.inverseBindMatrices[1]);
  });

  it('many-bone-rig.glb: 64 bones, index == joints position, parent in joints space', async () => {
    const { skin } = await projectFixture('many-bone-rig.glb');
    const { bones } = projectGltfSkeleton(skin);
    expect(bones).toHaveLength(64);
    // BoneSpec index i corresponds to skin.joints[] position i (the spine).
    for (let i = 0; i < bones.length; i++) {
      expect(bones[i].name).toBe(skin.jointKeys[i]);
      expect(bones[i].parent).toBe(skin.parentJointIndex[i]);
    }
  });

  it('omits inverseBindMatrix when the skin declares no IBMs (clean equality)', () => {
    const noIbmSkin: GltfSkinMetadata = {
      jointKeys: ['Root', 'Tip'],
      bindTRS: [
        { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ],
      parentJointIndex: [-1, 0],
      inverseBindMatrices: [], // no IBMs
    };
    const { bones } = projectGltfSkeleton(noIbmSkin);
    expect(bones).toHaveLength(2);
    // The key must be ABSENT, not `undefined` — keeps value-equality clean.
    expect('inverseBindMatrix' in bones[0]).toBe(false);
    expect('inverseBindMatrix' in bones[1]).toBe(false);
  });

  it('carries scale through from bindTRS', async () => {
    const { skin } = await projectFixture('skinned-bar.glb');
    const { bones } = projectGltfSkeleton(skin);
    for (let i = 0; i < bones.length; i++) {
      expect(bones[i].scale).toEqual(skin.bindTRS[i].scale);
    }
  });

  describe('DEGREES → RADIANS convention (H46/H20 — the Wave C/D trap)', () => {
    // A skin whose bindTRS.rotation is in DEGREES (the Wave A capture
    // convention), with a known non-trivial rotation on the second joint.
    const degSkin: GltfSkinMetadata = {
      jointKeys: ['Root', 'Tip'],
      bindTRS: [
        { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { position: [0, 1, 0], rotation: [90, 0, 0], scale: [1, 1, 1] }, // 90° about X
      ],
      parentJointIndex: [-1, 0],
      inverseBindMatrices: [],
    };

    it('projects a DEGREES bind rotation to RADIANS BoneSpec rotation', () => {
      const { bones } = projectGltfSkeleton(degSkin);
      // 90 degrees → π/2 radians. If the projector forgot the conversion the
      // BoneSpec would carry 90 (radians) — a ~57× scale error.
      expect(bones[1].rotation[0]).toBeCloseTo(Math.PI / 2, 6);
      expect(bones[1].rotation[1]).toBeCloseTo(0, 6);
      expect(bones[1].rotation[2]).toBeCloseTo(0, 6);
      // Explicitly NOT the degrees value (falsification of the no-convert bug).
      expect(bones[1].rotation[0]).not.toBeCloseTo(90, 1);
    });

    it('round-trips through specToThreeSkeleton without a deg/rad scale error', () => {
      const { bones } = projectGltfSkeleton(degSkin);
      const { bones: threeBones } = specToThreeSkeleton(bones);
      // specToThreeSkeleton consumes BoneSpec.rotation as RADIANS
      // (new Euler(rot, 'XYZ')). The resulting Bone quaternion must equal the
      // quaternion for a 90°-about-X Euler — proving our radians output is
      // exactly what the existing BVH/FBX adapter expects (same contract).
      const expectedQ = new Quaternion().setFromEuler(
        new Euler(MathUtils.degToRad(90), 0, 0, 'XYZ'),
      );
      expect(threeBones[1].quaternion.x).toBeCloseTo(expectedQ.x, 6);
      expect(threeBones[1].quaternion.y).toBeCloseTo(expectedQ.y, 6);
      expect(threeBones[1].quaternion.z).toBeCloseTo(expectedQ.z, 6);
      expect(threeBones[1].quaternion.w).toBeCloseTo(expectedQ.w, 6);
    });
  });
});
