// Is the rest-direction alignment ill-conditioned near antiparallel?
// Perturb the source direction by a FIXED 3D angle in several directions and
// measure how far the resulting correction moves, as the pair approaches 180°.
// Well-conditioned: output moves about as much as the input. Ill-conditioned:
// output moves far more, so noise in a rest becomes a large arbitrary roll.
import { describe, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

const DEG = 180 / Math.PI;

describe('#855 — conditioning of setFromUnitVectors near antiparallel', () => {
  it('measures output movement per fixed input movement', () => {
    const t = new Vector3(0, 1, 0);
    const e1 = new Vector3(1, 0, 0);
    const e2 = new Vector3(0, 0, 1);
    const ETA = 0.5; // the input is nudged by half a degree, in 8 directions

    console.log('    pair angle | input nudge | worst output movement | amplification');
    for (const apart of [90, 150, 175, 179, 179.9]) {
      const polar = 180 - apart;
      const base = t
        .clone()
        .multiplyScalar(-Math.cos((polar * Math.PI) / 180))
        .add(e1.clone().multiplyScalar(Math.sin((polar * Math.PI) / 180)))
        .normalize();
      const q0 = new Quaternion().setFromUnitVectors(t, base);
      let worst = 0;
      for (let az = 0; az < 360; az += 45) {
        // rotate `base` by ETA degrees about an axis at azimuth `az` around it
        const perp = new Vector3().crossVectors(base, e2).normalize();
        const perp2 = new Vector3().crossVectors(base, perp).normalize();
        const axis = perp
          .clone()
          .multiplyScalar(Math.cos((az * Math.PI) / 180))
          .add(perp2.clone().multiplyScalar(Math.sin((az * Math.PI) / 180)))
          .normalize();
        const s = base
          .clone()
          .applyQuaternion(new Quaternion().setFromAxisAngle(axis, (ETA * Math.PI) / 180));
        const q = new Quaternion().setFromUnitVectors(t, s);
        worst = Math.max(worst, q0.angleTo(q) * DEG);
      }
      console.log(
        `    ${apart.toFixed(1).padStart(7)}°  | ${ETA.toFixed(2)}°        | ${worst.toFixed(2).padStart(8)}°            | ${(worst / ETA).toFixed(1).padStart(6)}x`,
      );
    }
  });
});
