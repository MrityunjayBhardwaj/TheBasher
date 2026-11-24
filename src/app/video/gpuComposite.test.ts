// gpuComposite — the pure parts of the GPU compositor (#1883): the inverse of the 2D canvas
// layer transform, and the sRGB curve. The pass itself runs in a real browser (e2e).

import { describe, expect, it } from 'vitest';
import { layerInverseMatrix, linearToSrgb, srgbToLinear } from './gpuComposite';

/** The 2D canvas's forward map (drawComposite): layer UV → comp pixel. */
function forward(
  W: number,
  H: number,
  pos: readonly [number, number],
  rotDeg: number,
  scale: readonly [number, number],
  dw: number,
  dh: number,
  u: number,
  v: number,
): [number, number] {
  const qx = (u - 0.5) * dw * scale[0];
  const qy = (v - 0.5) * dh * scale[1];
  const r = (rotDeg * Math.PI) / 180;
  return [
    W / 2 + pos[0] + Math.cos(r) * qx - Math.sin(r) * qy,
    H / 2 + pos[1] + Math.sin(r) * qx + Math.cos(r) * qy,
  ];
}

function apply(m: Float32Array, x: number, y: number): [number, number] {
  return [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]];
}

describe('layerInverseMatrix', () => {
  const cases: [readonly [number, number], number, readonly [number, number]][] = [
    [[0, 0], 0, [1, 1]],
    [[300, -40], 0, [0.5, 0.5]],
    [[12, 7], 33, [1.5, 0.75]],
    [[-100, 50], -120, [-1, 2]], // a mirrored layer
  ];
  it.each(cases)('undoes the canvas transform (pos %j, rot %d, scale %j)', (pos, rot, scale) => {
    const m = layerInverseMatrix(1280, 720, pos, rot, scale, 720, 720)!;
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0.25, 0.8],
      [1, 1],
    ]) {
      const [x, y] = forward(1280, 720, pos, rot, scale, 720, 720, u, v);
      const [bu, bv] = apply(m, x, y);
      expect(bu).toBeCloseTo(u, 4);
      expect(bv).toBeCloseTo(v, 4);
    }
  });

  it('is null when the layer collapses', () => {
    expect(layerInverseMatrix(10, 10, [0, 0], 0, [0, 1], 10, 10)).toBeNull();
    expect(layerInverseMatrix(10, 10, [0, 0], 0, [1, 1], 0, 10)).toBeNull();
  });
});

describe('the sRGB curve', () => {
  it('round-trips every 8-bit code', () => {
    for (let i = 0; i <= 255; i++) {
      expect(Math.round(linearToSrgb(srgbToLinear(i / 255)) * 255)).toBe(i);
    }
  });

  it('puts linear mid-grey at sRGB 188', () => {
    expect(Math.round(linearToSrgb(0.5) * 255)).toBe(188);
  });
});
