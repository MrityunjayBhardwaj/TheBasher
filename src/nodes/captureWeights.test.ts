// #1353 — skin weights by proximity: the rule, in numbers worked out by hand.
import { describe, expect, it } from 'vitest';
import { captureByProximity, type CaptureBone } from './captureWeights';
import { skinPointLayers } from './skinInfluences';

const OPTS = { maxInfluences: 4, dropoff: 4 };
/** Two bones end to end along +Y, meeting at y = 1. */
const A: CaptureBone = { name: 'A', head: [0, 0, 0], tail: [0, 1, 0] };
const B: CaptureBone = { name: 'B', head: [0, 1, 0], tail: [0, 2, 0] };

/** Point `p`'s weight per bone index. */
function weightsOf(points: number[], bones: CaptureBone[], opts = OPTS, p = 0): number[] {
  const { lanes } = captureByProximity(new Float32Array(points), bones, opts);
  const out = bones.map(() => 0);
  for (let lane = 0; lane < lanes.width; lane++) {
    const w = lanes.weights[p * lanes.width + lane];
    if (w > 0) out[lanes.joints[p * lanes.width + lane]] += w;
  }
  return out;
}

describe('#1353 — a point is bound to the bones nearest it', () => {
  it('weights fall as distance^-dropoff and add up to one', () => {
    // 1 from A's segment, 2 from C's: (1/1)^4 : (1/2)^4 = 16 : 1.
    const C: CaptureBone = { name: 'C', head: [3, 0, 0], tail: [3, 1, 0] };
    const [a, c] = weightsOf([1, 0.5, 0], [A, C]);
    expect(a).toBeCloseTo(16 / 17, 6);
    expect(c).toBeCloseTo(1 / 17, 6);
    // Dropoff 1 is linear: 2 : 1.
    const linear = weightsOf([1, 0.5, 0], [A, C], { maxInfluences: 4, dropoff: 1 });
    expect(linear[0]).toBeCloseTo(2 / 3, 6);
    expect(linear[1]).toBeCloseTo(1 / 3, 6);
  });

  it('the distance is to the whole bone, not to its joint', () => {
    // Beside the middle of A: 0.5 from the segment, but 0.707 from either joint.
    const far: CaptureBone = { name: 'far', head: [1.5, 0.5, 0], tail: [1.5, 0.5, 0] };
    const [a, f] = weightsOf([0.5, 0.5, 0], [A, far]);
    // far is a bone with no length — its head — exactly 1 away: (0.5/1)^4 = 1/16.
    expect(a).toBeCloseTo(16 / 17, 6);
    expect(f).toBeCloseTo(1 / 17, 6);
    // Past the tail, the tail is the nearest point of the bone.
    const [past] = weightsOf([0, 3, 0], [A, far]);
    const dA = 2;
    const dFar = Math.hypot(1.5, 2.5);
    expect(past).toBeCloseTo(1 / (1 + (dA / dFar) ** 4), 6);
  });

  it('a point level with a joint is shared evenly by the two bones that meet there', () => {
    const [a, b] = weightsOf([0.25, 1, 0], [A, B]);
    expect(a).toBeCloseTo(0.5, 6);
    expect(b).toBeCloseTo(0.5, 6);
  });

  it('a point on a bone belongs to it alone, and one on a joint to both', () => {
    expect(weightsOf([0, 0.4, 0], [A, B])).toEqual([1, 0]);
    expect(weightsOf([0, 1, 0], [A, B])).toEqual([0.5, 0.5]);
  });

  it('the size of the scene does not change the weights', () => {
    const scale = (b: CaptureBone, s: number): CaptureBone => ({
      name: b.name,
      head: [b.head[0] * s, b.head[1] * s, b.head[2] * s],
      tail: [b.tail[0] * s, b.tail[1] * s, b.tail[2] * s],
    });
    const small = weightsOf([0.3, 0.8, 0.1], [A, B]);
    const large = weightsOf([30, 80, 10], [scale(A, 100), scale(B, 100)]);
    expect(large[0]).toBeCloseTo(small[0], 6);
    expect(large[1]).toBeCloseTo(small[1], 6);
    expect(small[0]).toBeGreaterThan(0.5); // and the answer is not a trivial one
    expect(small[1]).toBeGreaterThan(0.01);
  });
});

describe('#1353 — max influences', () => {
  const near: CaptureBone = { name: 'near', head: [1, 0, 0], tail: [1, 0, 0] };
  const mid: CaptureBone = { name: 'mid', head: [2, 0, 0], tail: [2, 0, 0] };
  const far: CaptureBone = { name: 'far', head: [4, 0, 0], tail: [4, 0, 0] };

  it('keeps the nearest and gives the rest nothing, still adding up to one', () => {
    // Given farthest first, so "nearest" is by distance and not by order.
    const bones = [far, mid, near];
    expect(weightsOf([0, 0, 0], bones, { maxInfluences: 1, dropoff: 4 })).toEqual([0, 0, 1]);
    const two = weightsOf([0, 0, 0], bones, { maxInfluences: 2, dropoff: 4 });
    expect(two[0]).toBe(0);
    expect(two[1]).toBeCloseTo(1 / 17, 6);
    expect(two[2]).toBeCloseTo(16 / 17, 6);
    const all = weightsOf([0, 0, 0], bones, { maxInfluences: 3, dropoff: 4 });
    expect(all[0]).toBeGreaterThan(0);
    expect(all.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 6);
  });

  it('more than four influences are stored in further sets of four', () => {
    const ring = Array.from({ length: 6 }, (_, i): CaptureBone => {
      const at: [number, number, number] = [Math.cos(i), Math.sin(i), 0];
      return { name: `b${i}`, head: at, tail: at };
    });
    const four = captureByProximity(new Float32Array([0, 0, 0]), ring, OPTS);
    expect(four.lanes.width).toBe(4);
    const six = captureByProximity(new Float32Array([0, 0, 0]), ring, {
      maxInfluences: 6,
      dropoff: 4,
    });
    expect(six.lanes.width).toBe(8);
    // All six are 1 away: a sixth each, the last two lanes empty.
    expect([...six.lanes.weights].slice(0, 6).every((w) => Math.abs(w - 1 / 6) < 1e-6)).toBe(true);
    expect([...six.lanes.weights].slice(6)).toEqual([0, 0]);
    expect(skinPointLayers(six.lanes).map((l) => l.name)).toEqual([
      'skin_joints',
      'skin_weights',
      'skin_joints_1',
      'skin_weights_1',
    ]);
  });

  it('equally near bones are kept in bone order', () => {
    const twin: CaptureBone = { name: 'twin', head: [-1, 0, 0], tail: [-1, 0, 0] };
    expect(weightsOf([0, 0, 0], [near, twin], { maxInfluences: 1, dropoff: 4 })).toEqual([1, 0]);
    expect(weightsOf([0, 0, 0], [twin, near], { maxInfluences: 1, dropoff: 4 })).toEqual([1, 0]);
  });
});

describe('#1353 — a point no bone holds is counted', () => {
  it('every finite point is held; one that is not a number is counted and left empty', () => {
    const captured = captureByProximity(
      new Float32Array([0.2, 0.5, 0, NaN, 0, 0, 5, 5, 5]),
      [A, B],
      OPTS,
    );
    expect(captured.unbound).toBe(1);
    expect([...captured.lanes.weights].slice(4, 8)).toEqual([0, 0, 0, 0]);
    expect(captured.lanes.weights[0]).toBeGreaterThan(0);
    expect(captured.lanes.weights[8]).toBeGreaterThan(0);
  });

  it('with no bones, every point is unheld', () => {
    const captured = captureByProximity(new Float32Array([0, 0, 0, 1, 1, 1]), [], OPTS);
    expect(captured.unbound).toBe(2);
    expect(captured.vertexGroups).toEqual([]);
    expect([...captured.lanes.weights]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('one group per bone, in bone order, whether or not any point uses it', () => {
    const lonely: CaptureBone = { name: 'lonely', head: [900, 0, 0], tail: [900, 1, 0] };
    const captured = captureByProximity(new Float32Array([0.2, 0.5, 0]), [lonely, A], {
      maxInfluences: 1,
      dropoff: 4,
    });
    expect(captured.vertexGroups).toEqual(['lonely', 'A']);
    expect(captured.lanes.joints[0]).toBe(1);
  });
});
