// Attribution: does the SOURCE clip already carry these wraps, or do we make them?
// Same measure, applied to the parsed BVH's own keyframes before any retarget.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Quaternion } from 'three';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';

const A = (p: string) => resolve(__dirname, '../../../public/assets/' + p);
const CLIPS: Array<[string, string]> = [
  ['served T-pose', A('kimodo-served-tpose.bvh')],
  ['served degenerate', A('kimodo-served-degenerate.bvh')],
  ['bundled walk', A('motion/walk.bvh')],
];
const DEG = 180 / Math.PI;

describe('PROBE — are the wraps already in the source?', () => {
  it('measures the parsed BVH keyframes directly', () => {
    for (const [label, path] of CLIPS) {
      const soma = parseBvh(readFileSync(path, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
      const perBone = new Map<number, Array<{ t: number; r: readonly number[] }>>();
      for (const k of soma.clipParams.keyframes)
        perBone.set(k.bone, [...(perBone.get(k.bone) ?? []), { t: k.time, r: k.rotation }]);
      let pairs = 0, bad = 0, worst = 0;
      const names: string[] = [];
      for (const [bi, raw] of perBone) {
        const keys = [...raw].sort((a, b) => a.t - b.t);
        for (let i = 1; i < keys.length; i++) {
          pairs++;
          const p = keys[i - 1], c = keys[i];
          const qp = new Quaternion().setFromEuler(new Euler(p.r[0], p.r[1], p.r[2], 'XYZ'));
          const qc = new Quaternion().setFromEuler(new Euler(c.r[0], c.r[1], c.r[2], 'XYZ'));
          const geo = 2 * Math.acos(Math.min(1, Math.abs(qp.dot(qc)))) * DEG;
          const eul = Math.max(...[0, 1, 2].map((a) => Math.abs(c.r[a] - p.r[a]) * DEG));
          if (eul - geo > 90) { bad++; worst = Math.max(worst, eul); names.push(soma.skeletonParams.bones[bi].name); }
        }
      }
      console.log(`\n=== SOURCE ${label} === pairs ${pairs}  wrap-steps ${bad}  worst euler jump ${worst.toFixed(1)}°`);
      if (names.length) console.log(`     bones: ${[...new Set(names)].slice(0, 8).join(', ')}`);
    }
    console.log('');
  });
});
