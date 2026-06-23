// CameraSelect evaluator + index-clamp tests (#231 Inc 3).
//
// Pins: pick-by-index (edge order), the shared clamp `resolveCameraSelectIndex`
// (out-of-range → nearest valid slot, empty → null), and null-on-empty. The clamp
// is the ONE place both the value side (here) and the id side
// (`selectActiveCameraNode`) normalize the index, so they must agree on which
// camera is live (V44, H40).
//
// REF: src/nodes/CameraSelect.ts; src/app/activeCamera.test.ts (the id-side mirror).

import { describe, expect, it } from 'vitest';
import { CameraSelectNode, CameraSelectParams, resolveCameraSelectIndex } from './CameraSelect';
import type { CameraValue, SceneObject } from './types';

function makeCamera(name: string): CameraValue {
  return {
    kind: 'PerspectiveCamera',
    position: [0, 0, 0],
    lookAt: [0, 0, 0],
    fov: 45,
    near: 0.01,
    far: 1000,
    roll: 0,
    name,
  } as unknown as CameraValue;
}

function evalSelect(
  active: number,
  cameras: SceneObject[] | SceneObject | undefined,
): CameraValue | null {
  const parsed = CameraSelectParams.parse({ active });
  return CameraSelectNode.evaluate(
    parsed,
    cameras !== undefined ? { cameras } : {},
  ) as CameraValue | null;
}

describe('resolveCameraSelectIndex (the shared clamp)', () => {
  it('returns null for an empty list', () => {
    expect(resolveCameraSelectIndex(0, 0)).toBeNull();
    expect(resolveCameraSelectIndex(3, 0)).toBeNull();
  });

  it('passes a valid index through', () => {
    expect(resolveCameraSelectIndex(0, 3)).toBe(0);
    expect(resolveCameraSelectIndex(2, 3)).toBe(2);
  });

  it('clamps a negative index to 0 and an over-range index to the last slot', () => {
    expect(resolveCameraSelectIndex(-1, 3)).toBe(0);
    expect(resolveCameraSelectIndex(5, 3)).toBe(2);
  });

  it('rounds a fractional index (a keyframe sample mid-interpolation)', () => {
    // A linearly-interpolated `active` between cut keys lands fractional; rounding
    // picks the nearer camera (the cut snaps, no blended camera exists).
    expect(resolveCameraSelectIndex(0.4, 3)).toBe(0);
    expect(resolveCameraSelectIndex(0.6, 3)).toBe(1);
    expect(resolveCameraSelectIndex(1.5, 3)).toBe(2);
  });
});

describe('CameraSelect evaluator', () => {
  it('undefined cameras input → null', () => {
    expect(evalSelect(0, undefined)).toBeNull();
  });

  it('empty cameras list → null', () => {
    expect(evalSelect(0, [])).toBeNull();
  });

  it('picks the active camera by index (edge order)', () => {
    const cams = [makeCamera('A'), makeCamera('B'), makeCamera('C')];
    expect((evalSelect(0, cams) as { name?: string }).name).toBe('A');
    expect((evalSelect(1, cams) as { name?: string }).name).toBe('B');
    expect((evalSelect(2, cams) as { name?: string }).name).toBe('C');
  });

  it('clamps an over-range active to the last camera (matches the id side)', () => {
    const cams = [makeCamera('A'), makeCamera('B')];
    expect((evalSelect(9, cams) as { name?: string }).name).toBe('B');
  });

  it('single camera passed (not an array) → returned', () => {
    expect((evalSelect(0, makeCamera('solo')) as { name?: string }).name).toBe('solo');
  });

  it('drops null entries before indexing', () => {
    const cams = [null, makeCamera('A')] as unknown as SceneObject[];
    // Index 0 of the FILTERED list is 'A' (the null is dropped), so active:0 → A.
    expect((evalSelect(0, cams) as { name?: string }).name).toBe('A');
  });
});
