import { describe, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { solveRestAlignment } from './restAlignment';
import { specToThreeSkeleton } from './threeAdapter';
import type { BoneSpec } from '../../nodes/types';
const DEG = 180 / Math.PI;
const SRC: BoneSpec[] = [
  { name: 's_hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
  { name: 's_spine', parent: 0, position: [0, 0.2, 0], rotation: [0, 0, 0] },
  { name: 's_neck', parent: 1, position: [0, 0.2, 0], rotation: [0, 0, 0] },
  { name: 's_head', parent: 2, position: [0, 0.15, 0], rotation: [0, 0, 0] },
  { name: 's_shoulder', parent: 1, position: [0.1, 0.1, 0], rotation: [0, 0, 0] },
  { name: 's_arm', parent: 4, position: [0.2, 0, 0], rotation: [0, 0, 0] },
  { name: 's_hand', parent: 5, position: [0.2, 0, 0], rotation: [0, 0, 0] },
  { name: 's_upleg', parent: 0, position: [0.1, -0.05, 0], rotation: [0, 0, 0] },
  { name: 's_leg', parent: 7, position: [0, -0.4, 0], rotation: [0, 0, 0] },
  { name: 's_foot', parent: 8, position: [0, -0.4, 0], rotation: [0, 0, 0] },
  { name: 's_toe', parent: 9, position: [0, 0, 0.15], rotation: [0, 0, 0] },
];
const MAP: Record<string, string> = Object.fromEntries(SRC.map((b) => [b.name.replace('s_', 't_'), b.name]));
describe('a rest that is genuinely pitched', () => {
  it('is refused rather than fitted', () => {
    for (const pitch of [0, 10, 20, 30, 45, 60, 90]) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (pitch * Math.PI) / 180);
      const TGT: BoneSpec[] = SRC.map((b) => {
        const v = new Vector3(...b.position).applyQuaternion(q);
        return { ...b, name: b.name.replace('s_', 't_'), position: [v.x, v.y, v.z] as [number, number, number] };
      });
      const a = solveRestAlignment(specToThreeSkeleton(SRC).bones, specToThreeSkeleton(TGT).bones, MAP);
      const up = new Vector3(0, 1, 0);
      console.log(`pitch ${String(pitch).padStart(2)}°: ` + (a
        ? `ACCEPTED after=${a.disagreementAfter.toFixed(2)}° tilt=${(up.clone().applyQuaternion(a.rotation).angleTo(up) * DEG).toFixed(4)}°`
        : 'REFUSED -> per-bone fallback'));
    }
  });
});
