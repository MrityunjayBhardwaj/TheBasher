// #1709 — the fixed 2D | 3D split's geometry (splitPaneBoxes) and its inverse (twoDShareAt).
//
// The boxes are calc() strings against <main>'s width; these tests resolve them at a concrete
// width and check the parts tile the clear band exactly: no gap, no overlap, nothing past an
// island, each side its share — swapped and collapsed included.

import { describe, expect, it } from 'vitest';

import {
  SPLIT_COLLAPSED_STRIP,
  SPLIT_DIVIDER_WIDTH,
  splitPaneBoxes,
  twoDShareAt,
  type HSpan,
} from './layoutIslands';

/** Resolve one of our calc() strings at a <main> width of `w` px. */
function px(css: string, w: number): number {
  const expr = css.replace(/calc/g, '').replace(/100%/g, String(w)).replace(/px/g, '');
  if (!/^[\d\s.+\-*/()]+$/.test(expr)) throw new Error(`unexpected css: ${css}`);
  return Function(`return (${expr});`)() as number;
}
const span = (s: HSpan, w: number) => ({
  left: px(s.left, w),
  right: px(s.left, w) + px(s.width, w),
});

const insets = { left: 300, right: 100 };
const W = 1400; // band: 300 → 1300, 1000 wide

describe('splitPaneBoxes', () => {
  it('tiles the band: 2D | divider | 3D, the 2D side taking its share of the room', () => {
    const b = splitPaneBoxes({ insets, twoDShare: 0.3, collapsed: false, swapped: false });
    const two = span(b.twoD, W);
    const div = span(b.divider!, W);
    const three = span(b.view3d!, W);
    expect(b.strip).toBeNull();
    expect(two.left).toBeCloseTo(300, 9);
    expect(two.right).toBeCloseTo(div.left, 9);
    expect(div.right - div.left).toBeCloseTo(SPLIT_DIVIDER_WIDTH, 9);
    expect(three.left).toBeCloseTo(div.right, 9);
    expect(three.right).toBeCloseTo(1300, 9);
    expect(two.right - two.left).toBeCloseTo((1000 - SPLIT_DIVIDER_WIDTH) * 0.3, 9);
  });

  it('swapped: the 3D side on the left, each side keeping its own width', () => {
    const a = splitPaneBoxes({ insets, twoDShare: 0.3, collapsed: false, swapped: false });
    const b = splitPaneBoxes({ insets, twoDShare: 0.3, collapsed: false, swapped: true });
    const three = span(b.view3d!, W);
    const two = span(b.twoD, W);
    expect(three.left).toBeCloseTo(300, 9);
    expect(two.right).toBeCloseTo(1300, 9);
    expect(three.right).toBeCloseTo(px(b.divider!.left, W), 9);
    expect(two.right - two.left).toBeCloseTo(px(a.twoD.width, W), 9);
    expect(three.right - three.left).toBeCloseTo(px(a.view3d!.width, W), 9);
  });

  it('collapsed: no divider, no 3D box; the strip on the 3D side’s edge and the 2D side the rest', () => {
    const r = splitPaneBoxes({ insets, twoDShare: 0.3, collapsed: true, swapped: false });
    expect(r.divider).toBeNull();
    expect(r.view3d).toBeNull();
    const strip = span(r.strip!, W);
    const two = span(r.twoD, W);
    expect(strip.right).toBeCloseTo(1300, 9);
    expect(strip.right - strip.left).toBe(SPLIT_COLLAPSED_STRIP);
    expect(two).toEqual({ left: 300, right: strip.left });

    const l = splitPaneBoxes({ insets, twoDShare: 0.3, collapsed: true, swapped: true });
    const stripL = span(l.strip!, W);
    expect(stripL.left).toBe(300);
    expect(span(l.twoD, W)).toEqual({ left: stripL.right, right: 1300 });
  });
});

describe('twoDShareAt', () => {
  it('inverts splitPaneBoxes: the divider’s middle maps back to the share, either way round', () => {
    for (const swapped of [false, true]) {
      for (const share of [0.2, 0.37, 0.5, 0.8]) {
        const b = splitPaneBoxes({ insets, twoDShare: share, collapsed: false, swapped });
        const mid = px(b.divider!.left, W) + SPLIT_DIVIDER_WIDTH / 2;
        expect(
          twoDShareAt({ pointerX: mid, bandLeft: 300, bandWidth: 1000, swapped }),
          `swapped=${swapped} share=${share}`,
        ).toBeCloseTo(share, 9);
      }
    }
  });

  it('answers the middle for a band too narrow to hold the divider', () => {
    expect(twoDShareAt({ pointerX: 5, bandLeft: 0, bandWidth: 4, swapped: false })).toBe(0.5);
  });
});
