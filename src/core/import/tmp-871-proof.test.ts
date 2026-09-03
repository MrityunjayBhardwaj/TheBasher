// PROOF by inverse edit: de-tilt the emitted root track by the rotation that
// takes R·up back to up. If the ramp goes to ~0, R's tilt IS the drift.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { specToThreeSkeleton } from './threeAdapter';
import { solveRestAlignment } from './restAlignment';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const DEG = 180 / Math.PI;
const UP = new Vector3(0, 1, 0);

describe('PROOF — de-tilting the root track removes the drift', () => {
  it('walk / run / jump', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
    const { bones: targetBoneObjs } = specToThreeSkeleton(target.bones);
    const targetToSource: Record<string, string> = {};
    for (const [s, t] of Object.entries(preset.map)) targetToSource[t] = s;

    for (const name of ['walk', 'run', 'jump']) {
      const soma = parseBvh(readFileSync(resolve(__dirname, `../../../public/assets/motion/${name}.bvh`), 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
      const { bones: sourceBoneObjs } = specToThreeSkeleton(soma.skeletonParams.bones);
      const R = solveRestAlignment(sourceBoneObjs, targetBoneObjs, targetToSource)!;
      // U: minimal rotation taking R·up back to up — R's "tilt of the vertical"
      const U = new Quaternion().setFromUnitVectors(UP.clone().applyQuaternion(R.rotation), UP);
      const out = retargetClip({
        sourceBones: soma.skeletonParams.bones,
        sourceClip: { name: soma.clipParams.name, duration: soma.clipParams.duration, keyframes: soma.clipParams.keyframes },
        targetBones: target.bones, nameMap: preset.map,
      });
      const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const byTime = new Map<number, Map<number, (typeof out.clipParams.keyframes)[number]>>();
      for (const k of out.clipParams.keyframes) {
        if (!byTime.has(k.time)) byTime.set(k.time, new Map());
        byTime.get(k.time)!.set(k.bone, k);
      }
      const world = (detilt: boolean) => times.map((t) => {
        const frame = byTime.get(t)!;
        const mats: Matrix4[] = [];
        target.bones.forEach((b, i) => {
          const k = frame.get(i);
          const p = new Vector3(...(k?.position ?? b.position));
          const q = new Quaternion().setFromEuler(new Euler(...(k?.rotation ?? b.rotation), 'XYZ'));
          mats[i] = b.parent >= 0
            ? new Matrix4().multiplyMatrices(mats[b.parent], new Matrix4().compose(p, q, new Vector3(1, 1, 1)))
            : new Matrix4().compose(p, q, new Vector3(1, 1, 1));
        });
        const v = new Vector3().setFromMatrixPosition(mats[1]);
        return detilt ? v.applyQuaternion(U) : v;
      });
      const report = (pts: Vector3[]) => {
        const travel = Math.hypot(pts.at(-1)!.x - pts[0].x, pts.at(-1)!.z - pts[0].z);
        const rise = pts.at(-1)!.y - pts[0].y;
        return `rise=${rise.toFixed(4)}m over ${travel.toFixed(3)}m => ${(Math.atan2(rise, travel) * DEG).toFixed(2)}°`;
      };
      console.log(`${name.padEnd(5)} R·up tilt=${(UP.clone().applyQuaternion(R.rotation).angleTo(UP) * DEG).toFixed(2)}°`);
      console.log(`      as shipped : ${report(world(false))}`);
      console.log(`      de-tilted  : ${report(world(true))}`);
    }
  });
});
