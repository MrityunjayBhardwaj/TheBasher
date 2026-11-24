// Floating-island geometry — the centered-surface reserve (#327, #1704).
//
// Every centred surface (toolbar pill, playback bar, 2D View / Spreadsheet,
// DiffBar) derives its box from ONE function, centerSurfaceBox — the DiffBar
// was once left out of a hand-copied rule, which is how its Apply button ended
// up under the inspector island (#327). #1704 moved the centre from the
// viewport midpoint (which reserved the WIDER island on both sides) to the
// clear band between the islands, so a folded panel frees its whole width.
// These tests pin the exact CSS strings, so a geometry change happens HERE,
// once, visibly.

import { describe, expect, it } from 'vitest';

import {
  BOTTOM_RIGHT_WIDGETS,
  CENTER_SURFACE_MAX_WIDTH,
  centerBandInsets,
  centerSurfaceBox,
  CHAT_COLUMN_WIDTH,
  CHAT_RAIL_WIDTH,
  chatColumnWidth,
  COLLAPSED_STRIP,
  GIZMO_BAND,
  INSPECTOR_WIDTH,
  ISLAND_GAP,
  OUTLINER_WIDTH,
  PLAYBACK_BAND,
  sideIslandBottom,
  sideIslandWidth,
} from './layoutIslands';

const BOTH_OPEN = { leftCollapsed: false, inspectorCollapsed: false };

describe('sideIslandWidth', () => {
  it('is the chevron strip when folded and the full column when open', () => {
    expect(sideIslandWidth(true, INSPECTOR_WIDTH)).toBe(COLLAPSED_STRIP);
    expect(sideIslandWidth(false, INSPECTOR_WIDTH)).toBe(INSPECTOR_WIDTH);
  });
});

// #1704 — centred surfaces sit in the CLEAR BAND between the two islands (not on the viewport
// midpoint reserving the wider island on both sides), so a folded panel frees its whole width.
describe('centerBandInsets', () => {
  const desk = { isNarrow: false, ...BOTH_OPEN };
  it('top band: each side reserves its OWN island plus a gap each side', () => {
    expect(centerBandInsets({ ...desk, band: 'top' })).toEqual({
      left: 2 * ISLAND_GAP + OUTLINER_WIDTH,
      right: 2 * ISLAND_GAP + INSPECTOR_WIDTH,
    });
  });

  it('top band: a folded inspector frees its whole width (only the 28px strip stays reserved)', () => {
    expect(centerBandInsets({ ...desk, inspectorCollapsed: true, band: 'top' }).right).toBe(
      2 * ISLAND_GAP + COLLAPSED_STRIP,
    );
    expect(centerBandInsets({ ...desk, leftCollapsed: true, band: 'top' }).left).toBe(
      2 * ISLAND_GAP + COLLAPSED_STRIP,
    );
  });

  it('bottom band: the islands stop above it; only the gizmo + Persp/Ortho corner is reserved', () => {
    for (const leftCollapsed of [true, false]) {
      for (const inspectorCollapsed of [true, false]) {
        expect(
          centerBandInsets({ isNarrow: false, leftCollapsed, inspectorCollapsed, band: 'bottom' }),
        ).toEqual({ left: ISLAND_GAP, right: BOTTOM_RIGHT_WIDGETS });
      }
    }
    // The pill is ~102px wide at 16px from the corner; the gizmo's column ends ~120px in.
    expect(BOTTOM_RIGHT_WIDGETS).toBeGreaterThanOrEqual(120 + ISLAND_GAP - 2);
  });

  it('narrow: the drawers overlay, so only the edge gaps come off, top and bottom', () => {
    for (const band of ['top', 'bottom'] as const) {
      expect(centerBandInsets({ isNarrow: true, ...BOTH_OPEN, band })).toEqual({
        left: ISLAND_GAP,
        right: ISLAND_GAP,
      });
    }
  });
});

describe('centerSurfaceBox — the ONE geometry every centred surface derives from', () => {
  it('centres on the clear band, not the viewport midpoint', () => {
    const box = centerSurfaceBox({ isNarrow: false, ...BOTH_OPEN, band: 'top' });
    // 284 left + 324 right = 608 off; centre = 284 + (100% - 608)/2.
    expect(box.width).toBe('calc(100% - 608px)');
    expect(box.left).toBe('calc(284px + (100% - 608px) / 2)');
    expect(box.transform).toBe('translateX(-50%)');
  });

  it('caps the width but keeps the band centre', () => {
    const box = centerSurfaceBox({
      isNarrow: false,
      ...BOTH_OPEN,
      band: 'bottom',
      capPx: CENTER_SURFACE_MAX_WIDTH,
    });
    expect(box.width).toBe('min(960px, calc(100% - 144px))');
    expect(box.left).toBe('calc(12px + (100% - 144px) / 2)');
  });

  it('narrow is the full width less the edge gaps, centred on the viewport', () => {
    const box = centerSurfaceBox({ isNarrow: true, ...BOTH_OPEN, band: 'top', capPx: 960 });
    expect(box.width).toBe('calc(100% - 24px)');
    expect(box.left).toBe('calc(12px + (100% - 24px) / 2)');
  });

  it('at 1280 with chat open (920px viewport) and the inspector folded, the bands fit their bars', () => {
    const viewport = 1280 - 360;
    const top = centerBandInsets({
      isNarrow: false,
      leftCollapsed: false,
      inspectorCollapsed: true,
      band: 'top',
    });
    const bottom = centerBandInsets({ isNarrow: false, ...BOTH_OPEN, band: 'bottom' });
    // The playback bar's natural width measured 704px (2026-11-21, 1440×900).
    expect(viewport - bottom.left - bottom.right).toBeGreaterThanOrEqual(704);
    expect(viewport - top.left - top.right).toBeGreaterThan(560);
  });
});

// #1704 — the chat is a grid column at the window's right; the bottom band holds only playback.
describe('chatColumnWidth', () => {
  it('is the column open, the rail folded', () => {
    expect(chatColumnWidth({ isNarrow: false, isPresent: false, open: true })).toBe(
      CHAT_COLUMN_WIDTH,
    );
    expect(chatColumnWidth({ isNarrow: false, isPresent: false, open: false })).toBe(
      CHAT_RAIL_WIDTH,
    );
    expect(CHAT_RAIL_WIDTH).toBeLessThanOrEqual(40);
  });

  it('takes no width when narrow (it overlays) or in present mode (it is hidden)', () => {
    for (const open of [true, false]) {
      expect(chatColumnWidth({ isNarrow: true, isPresent: false, open })).toBe(0);
      expect(chatColumnWidth({ isNarrow: false, isPresent: true, open })).toBe(0);
    }
  });
});

describe('sideIslandBottom — the side panels reclaim the old chat band', () => {
  it('the outliner stops above the floating playback bar, and runs to the gap when the drawer is open', () => {
    expect(sideIslandBottom('left', false)).toBe(PLAYBACK_BAND);
    expect(sideIslandBottom('left', true)).toBe(ISLAND_GAP);
  });

  it('the inspector still stops above the orbit gizmo (centre 80px from the corner)', () => {
    expect(sideIslandBottom('right', false)).toBe(GIZMO_BAND);
    expect(sideIslandBottom('right', true)).toBe(GIZMO_BAND);
    expect(GIZMO_BAND).toBeGreaterThan(80 + 40);
  });
});
