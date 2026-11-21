// #1709 — the fixed 2D | 3D split's geometry (splitPaneBoxes) and its inverse (twoDShareAt).
//
// The boxes are calc() strings against <main>'s width; these tests resolve them at a concrete
// width and check the parts tile the clear band exactly: no gap, no overlap, nothing past an
// island, each side its share — swapped and collapsed included.

import { describe, expect, it } from 'vitest';

import {
  GIZMO_BAND,
  ISLAND_GAP,
  linPx,
  LIVE_PREVIEW_MIN_WIDTH,
  LIVE_PREVIEW_WIDTH,
  livePreviewBox,
  BOTTOM_RIGHT_WIDGETS,
  PLAYBACK_BAND,
  splitPaneSpans,
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

describe('livePreviewBox', () => {
  it('alone: beside the inspector, above the playback bar (or the gap with the drawer open)', () => {
    expect(livePreviewBox({ drawerOpen: false, bandRight: 324, splitSideWidth: null })).toEqual({
      right: 324,
      bottom: PLAYBACK_BAND,
      width: LIVE_PREVIEW_WIDTH,
    });
    expect(livePreviewBox({ drawerOpen: true, bandRight: 324, splitSideWidth: null })?.bottom).toBe(
      ISLAND_GAP,
    );
  });

  it('#1954 — alone with the inspector folded: left of the gizmo corner, never over it', () => {
    // The folded inspector's rail leaves bandRight at 2 gaps + 28 = 52 px, inside the gizmo and
    // Persp/Ortho corner (BOTTOM_RIGHT_WIDGETS from the edge): the preview steps left of it and
    // keeps its height (lifting it could reach the toolbar in a viewport the drawer has shortened).
    const railRight = 2 * ISLAND_GAP + 28;
    expect(
      livePreviewBox({ drawerOpen: false, bandRight: railRight, splitSideWidth: null }),
    ).toEqual({ right: BOTTOM_RIGHT_WIDGETS, bottom: PLAYBACK_BAND, width: LIVE_PREVIEW_WIDTH });
    expect(
      livePreviewBox({ drawerOpen: true, bandRight: railRight, splitSideWidth: null })?.bottom,
    ).toBe(ISLAND_GAP);
    // Beside an open inspector it already clears the corner and stays where it was.
    expect(livePreviewBox({ drawerOpen: false, bandRight: 324, splitSideWidth: null })?.right).toBe(
      324,
    );
  });

  it('split: the 3D side’s bottom-right above the gizmo, scaled to fit, hidden below the minimum', () => {
    expect(livePreviewBox({ drawerOpen: false, bandRight: 324, splitSideWidth: 349 })).toEqual({
      right: ISLAND_GAP,
      bottom: GIZMO_BAND,
      width: LIVE_PREVIEW_WIDTH,
    });
    expect(livePreviewBox({ drawerOpen: false, bandRight: 0, splitSideWidth: 250 })?.width).toBe(
      250 - 2 * ISLAND_GAP,
    );
    const edge = LIVE_PREVIEW_MIN_WIDTH + 2 * ISLAND_GAP;
    expect(livePreviewBox({ drawerOpen: false, bandRight: 0, splitSideWidth: edge })?.width).toBe(
      LIVE_PREVIEW_MIN_WIDTH,
    );
    expect(
      livePreviewBox({ drawerOpen: false, bandRight: 0, splitSideWidth: edge - 1 }),
    ).toBeNull();
  });

  it('takes the side width from the same spans that place the 3D slot', () => {
    const s = splitPaneSpans({ insets, twoDShare: 0.3, collapsed: false, swapped: false });
    const b = splitPaneBoxes({ insets, twoDShare: 0.3, collapsed: false, swapped: false });
    expect(linPx(s.view3d!.width, W)).toBeCloseTo(px(b.view3d!.width, W), 9);
  });
});
