import { describe, it, expect } from 'vitest';
import {
  normalizeRect,
  rectContains,
  isDragRect,
  boxSelectHits,
  type BoxCandidate,
  type ScreenPoint,
} from './boxSelect';

describe('normalizeRect', () => {
  it('orders bounds regardless of drag direction', () => {
    expect(normalizeRect({ x0: 10, y0: 20, x1: 5, y1: 8 })).toEqual({
      minX: 5,
      minY: 8,
      maxX: 10,
      maxY: 20,
    });
    // down-right drag yields the same bounds
    expect(normalizeRect({ x0: 5, y0: 8, x1: 10, y1: 20 })).toEqual({
      minX: 5,
      minY: 8,
      maxX: 10,
      maxY: 20,
    });
  });
});

describe('rectContains', () => {
  const r = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  it('includes the edges and interior, excludes outside', () => {
    expect(rectContains(r, 50, 50)).toBe(true);
    expect(rectContains(r, 0, 0)).toBe(true);
    expect(rectContains(r, 100, 100)).toBe(true);
    expect(rectContains(r, -1, 50)).toBe(false);
    expect(rectContains(r, 50, 101)).toBe(false);
  });
});

describe('isDragRect', () => {
  it('treats a tiny rect as a click (not a drag)', () => {
    expect(isDragRect({ x0: 10, y0: 10, x1: 12, y1: 11 })).toBe(false);
  });
  it('treats a meaningful drag on either axis as a drag', () => {
    expect(isDragRect({ x0: 10, y0: 10, x1: 30, y1: 11 })).toBe(true);
    expect(isDragRect({ x0: 10, y0: 10, x1: 11, y1: 40 })).toBe(true);
  });
});

describe('boxSelectHits', () => {
  // A trivial orthographic-style projector: world (x,y) → screen (x,y) px, world
  // z<0 means "behind the camera" → invisible. Lets us test rect + visibility
  // logic without THREE; the real perspective projection is observed in e2e.
  const project = (w: [number, number, number]): ScreenPoint => ({
    x: w[0],
    y: w[1],
    visible: w[2] >= 0,
  });

  const cands: BoxCandidate[] = [
    { id: 'a', world: [10, 10, 0] }, // inside
    { id: 'b', world: [90, 90, 0] }, // inside
    { id: 'c', world: [200, 50, 0] }, // outside (x)
    { id: 'd', world: [50, 50, -1] }, // inside rect but BEHIND camera
  ];
  const rect = { x0: 0, y0: 0, x1: 100, y1: 100 };

  it('returns ids whose projected origin is inside the marquee', () => {
    expect(boxSelectHits(cands, rect, project)).toEqual(['a', 'b']);
  });

  it('excludes candidates behind the camera even if the projection lands inside', () => {
    expect(boxSelectHits(cands, rect, project)).not.toContain('d');
  });

  it('preserves candidate order (last hit becomes the active node)', () => {
    const reversed = [...cands].reverse();
    expect(boxSelectHits(reversed, rect, project)).toEqual(['b', 'a']);
  });

  it('returns empty when the marquee covers nothing', () => {
    expect(boxSelectHits(cands, { x0: 300, y0: 300, x1: 400, y1: 400 }, project)).toEqual([]);
  });
});
