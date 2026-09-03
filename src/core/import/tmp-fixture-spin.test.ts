import { describe, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Quaternion } from 'three';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
const DEG = 180 / Math.PI;
const F = (p: string) => resolve(__dirname, '../../../public/fixtures/anim/' + p);
describe('tracked fixtures — do their SOURCE keyframes wrap?', () => {
  it('counts', () => {
    for (const f of ['soma-walk-tpose.bvh', 'soma-walk.bvh', 'soma-generated.bvh', 'walk.bvh', 'mixamo-naming.bvh']) {
      if (!existsSync(F(f))) { console.log(`  ${f}: MISSING`); continue; }
      const s = parseBvh(readFileSync(F(f), 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
      const per = new Map<number, Array<{t:number;r:readonly number[]}>>();
      for (const k of s.clipParams.keyframes) per.set(k.bone, [...(per.get(k.bone) ?? []), {t:k.time,r:k.rotation}]);
      let pairs=0, bad=0;
      for (const [,raw] of per) { const ks=[...raw].sort((a,b)=>a.t-b.t);
        for (let i=1;i<ks.length;i++){ pairs++;
          const qp=new Quaternion().setFromEuler(new Euler(ks[i-1].r[0],ks[i-1].r[1],ks[i-1].r[2],'XYZ'));
          const qc=new Quaternion().setFromEuler(new Euler(ks[i].r[0],ks[i].r[1],ks[i].r[2],'XYZ'));
          const geo=2*Math.acos(Math.min(1,Math.abs(qp.dot(qc))))*DEG;
          const eul=Math.max(...[0,1,2].map(a=>Math.abs(ks[i].r[a]-ks[i-1].r[a])*DEG));
          if (eul-geo>90) bad++; } }
      console.log(`  ${f.padEnd(24)} pairs ${String(pairs).padStart(5)}  source-wraps ${bad}`);
    }
  });
});
