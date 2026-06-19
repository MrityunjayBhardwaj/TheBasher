// averageRadiance — the flux-faithful reduction of a textured area emitter to a
// RectAreaLight's single color + intensity (epic #201 / #205, §1.5). The pure
// reducer feeds BOTH the viewport and the offscreen render (V37 parity), so its
// correctness is the boundary-pair check for "the light matches the card".

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { averageRadiance, studioLightDrive } from './averageRadiance';

/** Build a Float32 RGBA DataTexture from per-texel [r,g,b] (alpha = 1). */
function floatTexture(width: number, height: number, texels: number[][]): THREE.DataTexture {
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < texels.length; i++) {
    data[i * 4] = texels[i][0];
    data[i * 4 + 1] = texels[i][1];
    data[i * 4 + 2] = texels[i][2];
    data[i * 4 + 3] = 1;
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  return tex;
}

describe('averageRadiance', () => {
  it('averages a uniform texture to that exact radiance', () => {
    const tex = floatTexture(2, 1, [
      [0.4, 0.6, 0.8],
      [0.4, 0.6, 0.8],
    ]);
    const a = averageRadiance(tex);
    expect(a.r).toBeCloseTo(0.4, 6);
    expect(a.g).toBeCloseTo(0.6, 6);
    expect(a.b).toBeCloseTo(0.8, 6);
    // Rec.709 luma of (0.4, 0.6, 0.8).
    expect(a.luminance).toBeCloseTo(0.2126 * 0.4 + 0.7152 * 0.6 + 0.0722 * 0.8, 6);
  });

  it('averages a mixed texture (the DC term = mean of all texels)', () => {
    const tex = floatTexture(2, 1, [
      [1, 0, 0],
      [0, 0, 1],
    ]);
    const a = averageRadiance(tex);
    expect(a.r).toBeCloseTo(0.5, 6);
    expect(a.g).toBeCloseTo(0, 6);
    expect(a.b).toBeCloseTo(0.5, 6);
  });

  it('preserves HDR magnitude (radiance > 1 is not clamped)', () => {
    const tex = floatTexture(1, 1, [[5, 5, 5]]);
    const a = averageRadiance(tex);
    expect(a.r).toBeCloseTo(5, 6);
    expect(a.luminance).toBeCloseTo(5, 6);
  });

  it('decodes half-float storage via DataUtils', () => {
    const half = new Uint16Array(4);
    half[0] = THREE.DataUtils.toHalfFloat(0.25);
    half[1] = THREE.DataUtils.toHalfFloat(0.5);
    half[2] = THREE.DataUtils.toHalfFloat(0.75);
    half[3] = THREE.DataUtils.toHalfFloat(1);
    const tex = new THREE.DataTexture(half, 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    const a = averageRadiance(tex);
    expect(a.r).toBeCloseTo(0.25, 3);
    expect(a.g).toBeCloseTo(0.5, 3);
    expect(a.b).toBeCloseTo(0.75, 3);
  });

  it('returns a neutral white when there is no readable pixel data', () => {
    const a = averageRadiance(null);
    expect(a).toEqual({ r: 1, g: 1, b: 1, luminance: 1 });
    const empty = new THREE.Texture();
    expect(averageRadiance(empty)).toEqual({ r: 1, g: 1, b: 1, luminance: 1 });
  });
});

describe('studioLightDrive', () => {
  it('splits a bright tint into a unit-luminance chroma + an intensity scale', () => {
    // A warm texture: mostly red. luminance is the TRUE Rec.709 luma of the rgb
    // (averageRadiance always derives it that way) — the unit-luminance split
    // only holds when they're consistent.
    const lum = 0.2126 * 1 + 0.7152 * 0.5 + 0.0722 * 0.25;
    const drive = studioLightDrive({ r: 1, g: 0.5, b: 0.25, luminance: lum });
    // The chroma rides at unit luminance (brightness moves into the scale).
    const chromaLuma = 0.2126 * drive.color[0] + 0.7152 * drive.color[1] + 0.0722 * drive.color[2];
    expect(chromaLuma).toBeCloseTo(1, 6);
    expect(drive.intensityScale).toBeCloseTo(lum, 6);
  });

  it('white texture → white light, scale = its luminance', () => {
    const drive = studioLightDrive({ r: 2, g: 2, b: 2, luminance: 2 });
    expect(drive.color[0]).toBeCloseTo(1, 6);
    expect(drive.color[1]).toBeCloseTo(1, 6);
    expect(drive.color[2]).toBeCloseTo(1, 6);
    expect(drive.intensityScale).toBeCloseTo(2, 6);
  });

  it('black texture → no contribution (scale 0), neutral color', () => {
    const drive = studioLightDrive({ r: 0, g: 0, b: 0, luminance: 0 });
    expect(drive.intensityScale).toBe(0);
    expect(drive.color).toEqual([1, 1, 1]);
  });
});
