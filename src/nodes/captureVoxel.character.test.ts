// #1539 — the two things the voxel method is for, measured on a character: an arm hanging beside a
// leg keeps its own bones where straight-line distance does not, and the memory a capture takes
// does not grow with the number of bones.
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesMadeBy } from '../test-utils/bytesMadeBy';
import { xbotArmsDown, type XbotArmsDown } from '../test-utils/xbotArmsDown';
import { captureByProximity, type CaptureBone, type CapturedWeights } from './captureWeights';
import { captureByVoxel } from './captureVoxel';

const RESOLUTION = 128;
/** Arms turned down this far leave the hands 6 cm from the thighs. */
const DEGREES = 75;
/** A point holds "none" of another part's bones when they hold under this share of it. */
const SHARE = 0.05;

const ARM = /(Left|Right)(ForeArm|Hand)/;
const LEG = /Hips|UpLeg|Leg$|Foot|Toe/;

/** A vendor character that cannot be redistributed, so it is not in the repository. Every row
 *  here is measured on it and is skipped, by name, where the file is absent (CI). */
const XBOT = 'public/assets/mixamo-xbot.glb';
const ABSENT = !existsSync(XBOT);

let xbot: XbotArmsDown;
/** Per point: 1 a forearm or hand point, 2 a hips or leg point, 0 neither — by the FILE's weights. */
let part: Uint8Array;
beforeAll(async () => {
  if (ABSENT) return;
  const file = readFileSync(XBOT);
  xbot = await xbotArmsDown(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
    DEGREES,
  );
  const bones = xbot.bones.length;
  const count = xbot.mesh.points.length / 3;
  part = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    let arm = 0;
    let leg = 0;
    for (let b = 0; b < bones; b++) {
      const w = xbot.fileWeights[p * bones + b];
      if (ARM.test(xbot.bones[b].name)) arm += w;
      else if (LEG.test(xbot.bones[b].name)) leg += w;
    }
    part[p] = arm > 0.999 ? 1 : leg > 0.999 ? 2 : 0;
  }
});

/** How much of each point of `which` part is held by the OTHER part's bones: the count over
 *  {@link SHARE}, and the most any one point gives away. */
function crossed(got: CapturedWeights, which: 1 | 2): { over: number; most: number; of: number } {
  const other = xbot.bones.map((b) => (which === 1 ? LEG : ARM).test(b.name));
  const { joints, weights, width } = got.lanes;
  let over = 0;
  let most = 0;
  let of = 0;
  for (let p = 0; p < part.length; p++) {
    if (part[p] !== which) continue;
    of++;
    let share = 0;
    for (let lane = 0; lane < width; lane++) {
      if (other[joints[p * width + lane]]) share += weights[p * width + lane];
    }
    if (share > SHARE) over++;
    if (share > most) most = share;
  }
  return { over, most, of };
}

describe.skipIf(ABSENT)('#1539 — an arm at the side of a character', () => {
  it('the fixture is what it says: 67 bones, hands a few centimetres from the thighs', () => {
    expect(xbot.bones).toHaveLength(67);
    expect(xbot.mesh.points.length / 3).toBe(24746);
    const points = xbot.mesh.points;
    let gap = Infinity;
    const legs: number[] = [];
    for (let p = 0; p < part.length; p++) if (part[p] === 2) legs.push(p);
    for (let a = 0; a < part.length; a++) {
      if (part[a] !== 1) continue;
      for (const b of legs) {
        const d = Math.hypot(
          points[a * 3] - points[b * 3],
          points[a * 3 + 1] - points[b * 3 + 1],
          points[a * 3 + 2] - points[b * 3 + 2],
        );
        if (d < gap) gap = d;
      }
    }
    // 0.061: over four cubes at 128 on a character 1.81 tall, so the grid can tell them apart.
    expect(gap).toBeGreaterThan(0.055);
    expect(gap).toBeLessThan(0.07);
    expect(gap / (1.81 / RESOLUTION)).toBeGreaterThan(4);
  });

  it('by straight-line distance hundreds of leg points take the hand’s bones; through the volume none does', () => {
    const near = captureByProximity(xbot.mesh.points, xbot.bones, { maxInfluences: 4, dropoff: 4 });
    const through = captureByVoxel(xbot.mesh, xbot.bones, {
      maxInfluences: 4,
      falloff: 0.2,
      resolution: RESOLUTION,
    })!;
    expect([through.unbound, through.unreached, through.outside]).toEqual([0, 0, []]);

    // Hips and leg points, and the forearm and hand bones hanging beside them.
    const legsNear = crossed(near, 2);
    const legsThrough = crossed(through, 2);
    expect(legsNear.of).toBe(7706);
    expect(legsNear.over).toBeGreaterThan(500);
    expect(legsNear.most).toBeGreaterThan(0.9);
    expect(legsThrough.over).toBe(0);
    expect(legsThrough.most).toBeLessThan(0.01);

    // The other way round — forearm and hand points on the hips' and legs' bones — neither does:
    // an arm's own bone runs down its middle, nearer than anything in the leg.
    const armsNear = crossed(near, 1);
    const armsThrough = crossed(through, 1);
    expect(armsNear.of).toBe(12720);
    expect(armsNear.over).toBe(0);
    expect(armsThrough.over).toBe(0);
    expect(armsThrough.most).toBeLessThan(0.01);
  });
});

describe.skipIf(ABSENT)('#1539 — the memory a capture takes', () => {
  /** 72 bones: the fixture's 67 and five more up the spine. */
  const seventyTwo = (): CaptureBone[] => [
    ...xbot.bones,
    ...[0, 1, 2, 3, 4].map((i) => ({
      name: `extra.${i}`,
      head: [0, 1 + i * 0.05, 0] as [number, number, number],
      tail: [0, 1.05 + i * 0.05, 0] as [number, number, number],
    })),
  ];
  const opts = { maxInfluences: 4, falloff: 0.2, resolution: RESOLUTION };

  it('is the same for 72 bones as for 4: one distance field, written over bone after bone', () => {
    const bones = seventyTwo();
    expect(bones).toHaveLength(72);
    const many = bytesMadeBy(() => captureByVoxel(xbot.mesh, bones, opts));
    const few = bytesMadeBy(() => captureByVoxel(xbot.mesh, bones.slice(0, 4), opts));
    expect(many).toBe(few);
    // Keeping every bone's field as the reference does would add 72 × 8 bytes per grid cube.
    expect(many).toBeLessThan(16 * 1024 * 1024);
  });

  it('stays inside its stated bound: 24 bytes a grid cube and 153 a point, at four influences', () => {
    const bones = seventyTwo();
    let dims: readonly number[] = [];
    const made = bytesMadeBy(() => {
      dims = captureByVoxel(xbot.mesh, bones, opts)!.dims;
    });
    const cubes = dims[0] * dims[1] * dims[2];
    const points = xbot.mesh.points.length / 3;
    // The grid is no bigger than (resolution + 5)³, whatever the mesh's shape.
    expect(cubes).toBeLessThanOrEqual((RESOLUTION + 5) ** 3);
    expect(made).toBeLessThanOrEqual(24 * cubes + 153 * points + 4096);
    // And the bound is not slack by much on the per-point side: the grid's share alone is under it.
    expect(made).toBeGreaterThan(8 * cubes + 153 * points);
  });
});
