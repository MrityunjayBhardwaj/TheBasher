// Floating-island geometry — the centered-surface reserve (#327).
//
// centerSurfaceWidthCss is an EXTRACTION: the toolbar, the 2D View and the
// bottom stack each hand-copied the same narrow?full:reserve ternary, and the
// DiffBar was never given a copy at all — which is precisely how its Apply
// button ended up under the inspector island (#327). The reserve is now derived
// from one function by every centered surface.
//
// An extraction is only safe if it is BYTE-IDENTICAL at the existing call sites,
// so these tests pin the exact CSS strings those three sites produced before it.
// If a future edit changes the geometry, it changes it HERE, once, visibly —
// not silently in one of four copies.

import { describe, expect, it } from 'vitest';

import {
  CENTER_SURFACE_MAX_WIDTH,
  centerSideReserved,
  centerSurfaceWidthCss,
  COLLAPSED_STRIP,
  INSPECTOR_WIDTH,
  ISLAND_GAP,
  OUTLINER_WIDTH,
  sideIslandWidth,
} from './layoutIslands';

const BOTH_OPEN = { leftCollapsed: false, inspectorCollapsed: false };

describe('centerSideReserved', () => {
  it('reserves the WIDER island plus a gap each side, on both sides', () => {
    // 2 * (12 + max(260, 300) + 12) = 648 — the historic static constant.
    expect(centerSideReserved(false, false)).toBe(648);
    expect(centerSideReserved(false, false)).toBe(
      2 * (ISLAND_GAP + Math.max(OUTLINER_WIDTH, INSPECTOR_WIDTH) + ISLAND_GAP),
    );
  });

  it('shrinks as panels fold — a folded island reserves only its chevron strip', () => {
    // Right folded: the left island (260) is now the wider one.
    expect(centerSideReserved(false, true)).toBe(2 * (ISLAND_GAP + OUTLINER_WIDTH + ISLAND_GAP));
    // Both folded: only the 28px strips.
    expect(centerSideReserved(true, true)).toBe(2 * (ISLAND_GAP + COLLAPSED_STRIP + ISLAND_GAP));
    // Folding never widens the reserve.
    expect(centerSideReserved(true, true)).toBeLessThan(centerSideReserved(false, false));
  });
});

describe('sideIslandWidth', () => {
  it('is the chevron strip when folded and the full column when open', () => {
    expect(sideIslandWidth(true, INSPECTOR_WIDTH)).toBe(COLLAPSED_STRIP);
    expect(sideIslandWidth(false, INSPECTOR_WIDTH)).toBe(INSPECTOR_WIDTH);
  });
});

describe('centerSurfaceWidthCss — byte-identical to the three pre-extraction call sites', () => {
  it('un-capped surface (2D View, DiffBar): the full clear band', () => {
    expect(centerSurfaceWidthCss({ isNarrow: false, ...BOTH_OPEN })).toBe('calc(100% - 648px)');
  });

  it('capped surface (toolbar pill, bottom stack): the band, capped at 960', () => {
    expect(
      centerSurfaceWidthCss({ isNarrow: false, ...BOTH_OPEN, capPx: CENTER_SURFACE_MAX_WIDTH }),
    ).toBe('min(960px, calc(100% - 648px))');
  });

  it('narrow: the drawers overlay rather than reserve, so only the edge gaps come off', () => {
    expect(centerSurfaceWidthCss({ isNarrow: true, ...BOTH_OPEN })).toBe('calc(100% - 24px)');
    // The cap is irrelevant when narrow — the drawers do not reserve.
    expect(centerSurfaceWidthCss({ isNarrow: true, ...BOTH_OPEN, capPx: 960 })).toBe(
      'calc(100% - 24px)',
    );
  });

  it('tracks the LIVE collapse flags — folding a panel gives the width back', () => {
    expect(
      centerSurfaceWidthCss({ isNarrow: false, leftCollapsed: false, inspectorCollapsed: true }),
    ).toBe('calc(100% - 568px)');
    expect(
      centerSurfaceWidthCss({ isNarrow: false, leftCollapsed: true, inspectorCollapsed: true }),
    ).toBe('calc(100% - 104px)');
  });

  it('never reserves so much that a centered surface has no band left at a sane width', () => {
    // 1280 (the narrowest DESKTOP width) minus the widest reserve still leaves
    // a usable band — otherwise Apply/Reject would have nowhere to sit.
    expect(1280 - centerSideReserved(false, false)).toBeGreaterThan(300);
  });
});
