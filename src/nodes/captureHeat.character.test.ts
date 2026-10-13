// #1356 — what the heat method is for, measured on a character: fingers standing half a millimetre
// apart keep their own bones where the voxel grid and straight-line distance do not, an arm hanging
// beside a leg still does, and the parts it cannot bind by its own measure are counted.
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesMadeBy } from '../test-utils/bytesMadeBy';
import { xbotArmsDown } from '../test-utils/xbotArmsDown';
import { captureByHeat } from './captureHeat';
import { captureByVoxel } from './captureVoxel';
import { captureByProximity, type CapturedWeights } from './captureWeights';

/** A point holds "none" of another part's bones when they hold under this share of it. */
const SHARE = 0.05;
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const ARM = /(Left|Right)(ForeArm|Hand)/;
const LEG = /Hips|UpLeg|Leg$|Foot|Toe/;

/** A vendor character that cannot be redistributed, so it is not in the repository. Every row
 *  here is measured on it and is skipped, by name, where the file is absent (CI). */
const XBOT = 'public/assets/mixamo-xbot.glb';
const ABSENT = !existsSync(XBOT);

let bytes: ArrayBuffer;
beforeAll(() => {
  if (ABSENT) return;
  const file = readFileSync(XBOT);
  bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
});

/** The character with its arms `degrees` down, and what the FILE's weights say each point is. */
async function character(degrees: number) {
  const xbot = await xbotArmsDown(bytes, degrees);
  const bones = xbot.bones.length;
  const count = xbot.mesh.points.length / 3;
  /** Per bone: which of the ten fingers it is a bone of, or −1. */
  const fingerOf = xbot.bones.map((b) => {
    for (let side = 0; side < 2; side++) {
      for (let f = 0; f < 5; f++) {
        if (b.name.includes(`${side ? 'Right' : 'Left'}Hand${FINGERS[f]}`)) return side * 5 + f;
      }
    }
    return -1;
  });
  /** Per point: the finger it is on (over half its weight there, none on another), or −1. */
  const finger = new Int8Array(count).fill(-1);
  /** Per point: 1 when it is a hips or leg point through and through. */
  const leg = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    const share = new Float64Array(10);
    let legs = 0;
    for (let b = 0; b < bones; b++) {
      const w = xbot.fileWeights[p * bones + b];
      if (fingerOf[b] >= 0) share[fingerOf[b]] += w;
      else if (LEG.test(xbot.bones[b].name)) legs += w;
    }
    const best = share.indexOf(Math.max(...share));
    const rest = share.reduce((s, w, f) => (f === best ? s : s + w), 0);
    if (share[best] > 0.5 && rest < 0.001) finger[p] = best;
    if (legs > 0.999) leg[p] = 1;
  }
  /** Of the points `own` picks, how many give over {@link SHARE} to bones `other` picks. */
  const crossed = (
    got: CapturedWeights,
    own: (p: number) => boolean,
    other: (bone: number, p: number) => boolean,
  ) => {
    const { joints, weights, width } = got.lanes;
    let over = 0;
    let most = 0;
    let of = 0;
    for (let p = 0; p < count; p++) {
      if (!own(p)) continue;
      of++;
      let given = 0;
      for (let lane = 0; lane < width; lane++) {
        if (other(joints[p * width + lane], p)) given += weights[p * width + lane];
      }
      if (given > SHARE) over++;
      if (given > most) most = given;
    }
    return { over, most, of };
  };
  return {
    xbot,
    /** Finger points, and the bones of the OTHER fingers. */
    fingers: (got: CapturedWeights) =>
      crossed(
        got,
        (p) => finger[p] >= 0,
        (b, p) => fingerOf[b] >= 0 && fingerOf[b] !== finger[p],
      ),
    /** Hips and leg points, and the forearm and hand bones hanging beside them. */
    legs: (got: CapturedWeights) =>
      crossed(
        got,
        (p) => leg[p] === 1,
        (b) => ARM.test(xbot.bones[b].name),
      ),
  };
}

describe.skipIf(ABSENT)('#1356 — fingers that touch, and an arm at the side', () => {
  it('the fingers are a twentieth of a voxel apart: the grid joins them, heat does not', async () => {
    const { xbot, fingers, legs } = await character(75);
    const near = captureByProximity(xbot.mesh.points, xbot.bones, { maxInfluences: 4, dropoff: 4 });
    const through = captureByVoxel(xbot.mesh, xbot.bones, {
      maxInfluences: 4,
      falloff: 0.2,
      resolution: 128,
    })!;
    const along = captureByHeat(xbot.mesh, xbot.bones, { maxInfluences: 4 })!;

    // Finger points on another finger's bones.
    expect(fingers(near)).toMatchObject({ of: 7965, over: 2426 });
    expect(fingers(through)).toMatchObject({ of: 7965, over: 6029 });
    expect(fingers(along)).toMatchObject({ of: 7965, over: 0 });
    expect(fingers(along).most).toBeLessThan(0.01);

    // And what the voxel method was for still holds: no hip or leg point takes the bones of the
    // hand hanging 6 cm from it, where 776 do by straight-line distance.
    expect(legs(near)).toMatchObject({ of: 7706, over: 776 });
    expect(legs(through).over).toBe(0);
    expect(legs(along).over).toBe(0);
    expect(legs(along).most).toBeLessThan(0.01);
  });

  it('with the hand a centimetre and a half from the thigh the grid joins them outright; heat lets a few points slip', async () => {
    const { xbot, legs } = await character(80);
    const through = captureByVoxel(xbot.mesh, xbot.bones, {
      maxInfluences: 4,
      falloff: 0.2,
      resolution: 128,
    })!;
    expect(legs(through).over).toBeGreaterThan(1500);
    const along = legs(captureByHeat(xbot.mesh, xbot.bones, { maxInfluences: 4 })!);
    // The pelvis is a shell that sees no bone, bound through its own wall: a few places on its
    // inner wall have the hand behind them.
    expect(along.over).toBeLessThan(40);
    expect(along.most).toBeLessThan(0.1);
  });

  it('says what it could not bind by its own measure: three shells, and six tip bones that hold nothing', async () => {
    const { xbot } = await character(75);
    const along = captureByHeat(xbot.mesh, xbot.bones, { maxInfluences: 4 })!;
    expect(along.pieces).toBe(95);
    expect(along.sites).toBe(24746);
    expect(along.unbound).toBe(0);
    expect(along.unsettled).toBe(0);
    // The pelvis (a closed band, 534 points) and the two toe caps (212 each).
    expect(along.unreached).toBe(958);
    // The last bone of two fingers a hand, and of each foot: so short that no point has it nearest.
    expect([...along.outside].sort()).toEqual([
      'mixamorig_LeftHandMiddle4',
      'mixamorig_LeftHandRing4',
      'mixamorig_LeftToe_End',
      'mixamorig_RightHandMiddle4',
      'mixamorig_RightHandRing4',
      'mixamorig_RightToe_End',
    ]);
    const { weights, width } = along.lanes;
    for (let p = 0; p < 24746; p++) {
      let sum = 0;
      for (let lane = 0; lane < width; lane++) {
        expect(weights[p * width + lane]).toBeGreaterThanOrEqual(0);
        sum += weights[p * width + lane];
      }
      expect(Math.abs(sum - 1)).toBeLessThan(1e-5);
    }
  });

  it('takes under 300 bytes a point and 200 a triangle', async () => {
    const { xbot } = await character(75);
    const points = xbot.mesh.points.length / 3;
    const triangles = xbot.mesh.faceSizes.reduce((sum, n) => sum + n - 2, 0);
    expect([points, triangles]).toEqual([24746, 49112]);
    const made = bytesMadeBy(() => captureByHeat(xbot.mesh, xbot.bones, { maxInfluences: 4 }));
    // 11.8 MB here. The grid the lines of sight are traced through is the part that does not
    // shrink with the mesh: at most 8 bytes a cell of 129 cells cubed.
    expect(made).toBeLessThan(300 * points + 200 * triangles);
    expect(made).toBeGreaterThan(8 * 1024 * 1024);
  });
});
