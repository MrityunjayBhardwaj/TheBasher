// Does the T-pose BVH play the same motion when read as PLAIN BVH?
// The kimodo round-trip compared through kimodo's own neutral skeleton, so it
// could only prove kimodo self-consistent. This reads each file on its own terms —
// its own OFFSETs, its own channels — which is what our importer and Blender do.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vector3 } from 'three';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';

const DEGENERATE = resolve(__dirname, '../../../public/assets/kimodo-walk.bvh');
const TPOSE =
  '/private/tmp/claude-501/-Users-mrityunjaybhardwaj-Documents-projects-basher-ai/c4498c5a-50b8-4a2a-9a8a-6a9415d0ec19/scratchpad/kimodo-walk-tpose.bvh';

function worldPositions(path: string): Map<string, Vector3[]> {
  const bvh = parseBvh(readFileSync(path, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
  const { bones } = specToThreeSkeleton(bvh.skeletonParams.bones);
  const times = [...new Set(bvh.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
  const byTime = new Map<number, typeof bvh.clipParams.keyframes>();
  for (const k of bvh.clipParams.keyframes)
    byTime.set(k.time, [...(byTime.get(k.time) ?? []), k]);
  const out = new Map<string, Vector3[]>();
  for (const t of times) {
    for (const k of byTime.get(t) ?? []) {
      const b = bones[k.bone];
      if (!b) continue;
      b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      if (bvh.skeletonParams.bones[k.bone].parent === -1)
        b.position.set(k.position[0], k.position[1], k.position[2]);
    }
    bones[0].updateMatrixWorld(true);
    for (const b of bones)
      out.set(b.name, [...(out.get(b.name) ?? []), new Vector3().setFromMatrixPosition(b.matrixWorld)]);
  }
  return out;
}

describe('#855 — is the T-pose export plain-BVH equivalent?', () => {
  it('compares world joint positions computed from each file alone', () => {
    const a = worldPositions(DEGENERATE);
    const b = worldPositions(TPOSE);
    let worst = 0;
    let worstName = '';
    let n = 0;
    for (const [name, pa] of a) {
      const pb = b.get(name);
      if (!pb || pb.length !== pa.length) continue;
      for (let i = 0; i < pa.length; i++) {
        const d = pa[i].distanceTo(pb[i]);
        n++;
        if (d > worst) {
          worst = d;
          worstName = `${name}@${i}`;
        }
      }
    }
    console.log(`  samples compared: ${n}`);
    console.log(`  max world position difference: ${worst.toFixed(6)} m  (${worstName})`);
    for (const name of ['Hips', 'Head', 'LeftFoot', 'LeftHand']) {
      const pa = a.get(name);
      const pb = b.get(name);
      if (!pa || !pb) continue;
      console.log(
        `    ${name.padEnd(10)} frame0 degenerate (${pa[0].x.toFixed(3)}, ${pa[0].y.toFixed(3)}, ${pa[0].z.toFixed(3)})` +
          `   T-pose (${pb[0].x.toFixed(3)}, ${pb[0].y.toFixed(3)}, ${pb[0].z.toFixed(3)})`,
      );
    }
  });
});
