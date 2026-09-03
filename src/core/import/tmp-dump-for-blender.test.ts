// Dump the retargeted result for replay in a foreign renderer.
// Orientation ONLY, as a world delta from each bone's own bind, because the two
// programs disagree about every bone's local frame but agree on how far a bone
// has turned in world. Positions come from Blender's own kinematics; only the
// root's travel crosses.
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { retargetClip } from './retarget';
import { getBoneNameMapPreset } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const RIG = resolve(process.cwd(), 'public/assets/tripo-rigged.glb');
const OUT = '/private/tmp/claude-501/-Users-mrityunjaybhardwaj-Documents-projects-basher-ai/c4498c5a-50b8-4a2a-9a8a-6a9415d0ec19/scratchpad';

const worldRot = (b: Bone): Quaternion => {
  const p = new Vector3();
  const r = new Quaternion();
  const s = new Vector3();
  b.matrixWorld.decompose(p, r, s);
  return r;
};

describe('dump for Blender', () => {
  it('writes world deltas from bind for both rests', async () => {
    const buf = readFileSync(RIG);
    const { json, bin } = parseGltfContainer(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'standin');
    const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skin as unknown as GltfSkinMetadata).bones;
    const preset = getBoneNameMapPreset('somaToMixamo')!;

    const { bones: bind } = specToThreeSkeleton(target);
    bind[0].updateMatrixWorld(true);
    const bindRot = new Map<string, Quaternion>();
    for (const b of bind) bindRot.set(b.name, worldRot(b));

    for (const [tag, file] of [
      ['degenerate', resolve(process.cwd(), 'public/assets/kimodo-walk.bvh')],
      ['anatomical', OUT + '/kimodo-walk-tpose.bvh'],
    ] as const) {
      const parsed = parseBvh(
        readFileSync(file, 'utf8'),
        'walk',
        BVH_UNIT_SCALE_CENTIMETRES,
      );
      const out = retargetClip({
        sourceBones: parsed.skeletonParams.bones,
        sourceClip: {
          name: parsed.clipParams.name,
          duration: parsed.clipParams.duration,
          keyframes: parsed.clipParams.keyframes,
        },
        targetBones: target,
        nameMap: preset.map,
      });
      const { bones: pose } = specToThreeSkeleton(target);
      const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const byTime = new Map<number, typeof out.clipParams.keyframes>();
      for (const k of out.clipParams.keyframes)
        byTime.set(k.time, [...(byTime.get(k.time) ?? []), k]);
      const frames: Array<Record<string, number[]>> = [];
      const rootPos: number[][] = [];
      for (const t of times) {
        for (const k of byTime.get(t) ?? []) {
          const b = pose[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        pose[0].updateMatrixWorld(true);
        const row: Record<string, number[]> = {};
        for (const b of pose) {
          const bq = bindRot.get(b.name);
          if (!bq) continue;
          const delta = worldRot(b).clone().multiply(bq.clone().invert());
          row[b.name] = [delta.x, delta.y, delta.z, delta.w];
        }
        frames.push(row);
        const hips = pose.find((b) => b.name === 'mixamorig_Hips');
        const p = hips ? new Vector3().setFromMatrixPosition(hips.matrixWorld) : new Vector3();
        rootPos.push([p.x, p.y, p.z]);
      }
      // A BIND frame prepended, so the replay can be gated on identity before
      // any of its output is read.
      const identity: Record<string, number[]> = {};
      for (const name of bindRot.keys()) identity[name] = [0, 0, 0, 1];
      writeFileSync(
        `${OUT}/live-${tag}.json`,
        JSON.stringify({ fps: 30, bindFrame: identity, frames, rootPos }),
      );
      console.log(`  wrote live-${tag}.json — ${frames.length} frames, ${Object.keys(frames[0]).length} bones`);
    }
  }, 120000);
});
