// #1935 — the toolbar fit decision: which inline groups stay in the pill at a given width.

import { describe, expect, it } from 'vitest';
import { fitToolbar, TOOLBAR_GROUPS, type FitCandidate } from './toolbarFit';

// Widths as measured in the live app at 1280×800 (group + leading divider, px).
const EVERYDAY: FitCandidate[] = [
  { id: 'tools', width: 124, keep: 0 },
  { id: 'add', width: 63, keep: 1 },
  { id: 'shading', width: 183, keep: 2 },
  { id: 'camera', width: 53, keep: 3 },
];
const GAP = 4;
const MORE = 41;
// Everything + ⋯: 124 + 63 + 183 + 53 + 41 + 4 gaps × 4 = 480.
const FULL = 480;

const fit = (available: number, candidates = EVERYDAY, alwaysMore = true) =>
  fitToolbar({ candidates, available, gap: GAP, moreWidth: MORE, alwaysMore });

describe('fitToolbar', () => {
  it('keeps every everyday group inline when the row fits exactly', () => {
    expect(fit(FULL)).toEqual({ inline: ['tools', 'add', 'shading', 'camera'], overflow: [] });
  });

  it('moves the lowest-priority group into ⋯ one pixel short of fitting', () => {
    expect(fit(FULL - 1)).toEqual({ inline: ['tools', 'add', 'shading'], overflow: ['camera'] });
  });

  it('drops groups by priority, not by position, and reports overflow in display order', () => {
    // camera (keep 3) then shading (keep 2) go; add (keep 1) stays although shading sat after it.
    const r = fit(124 + 63 + MORE + 2 * GAP);
    expect(r.inline).toEqual(['tools', 'add']);
    expect(r.overflow).toEqual(['shading', 'camera']);
  });

  it('an earlier group with a lower priority goes before a later one (the armature menu)', () => {
    // Display order tools · add · armature · shading · camera, but the contextual armature menu
    // (keep 4) yields before shading and camera. Dropping by position would take camera first.
    const withArmature: FitCandidate[] = [
      EVERYDAY[0]!,
      EVERYDAY[1]!,
      { id: 'armature', width: 100, keep: 4 },
      EVERYDAY[2]!,
      EVERYDAY[3]!,
    ];
    expect(fit(FULL, withArmature)).toEqual({
      inline: ['tools', 'add', 'shading', 'camera'],
      overflow: ['armature'],
    });
  });

  it('on a priority tie drops the later group first', () => {
    const tied: FitCandidate[] = [
      { id: 'a', width: 100, keep: 1 },
      { id: 'b', width: 100, keep: 1 },
    ];
    expect(fit(100 + MORE + GAP, tied)).toEqual({ inline: ['a'], overflow: ['b'] });
  });

  it('counts the ⋯ button only once something needs it when no group is menu-only', () => {
    // Without ⋯ the row is 124 + 63 + 183 + 53 + 3 × 4 = 435 — fits in 435 with no ⋯ at all.
    expect(fit(435, EVERYDAY, false).overflow).toEqual([]);
    // One px less: camera goes, and now ⋯ must be paid for too.
    expect(fit(434, EVERYDAY, false)).toEqual({
      inline: ['tools', 'add', 'shading'],
      overflow: ['camera'],
    });
  });

  it('puts everything into ⋯ when not even the first group fits', () => {
    expect(fit(60)).toEqual({ inline: [], overflow: ['tools', 'add', 'shading', 'camera'] });
  });

  it('never returns a row wider than the space it was given', () => {
    for (let available = 0; available <= FULL + 20; available++) {
      const { inline } = fit(available);
      const kept = EVERYDAY.filter((c) => inline.includes(c.id));
      const width = kept.reduce((a, c) => a + c.width, 0) + MORE + kept.length * GAP; // n groups + ⋯ → n gaps
      if (kept.length > 0) expect(width).toBeLessThanOrEqual(available);
    }
  });
});

describe('TOOLBAR_GROUPS — the decided board', () => {
  it('keeps exactly the everyday groups inline, each with a priority', () => {
    const inline = TOOLBAR_GROUPS.filter((g) => g.placement === 'inline');
    expect(inline.map((g) => g.id)).toEqual(['tools', 'add', 'armature', 'shading', 'camera']);
    for (const g of inline) expect(typeof g.keep).toBe('number');
  });

  it('puts the less-used groups behind ⋯', () => {
    expect(TOOLBAR_GROUPS.filter((g) => g.placement === 'menu').map((g) => g.id)).toEqual([
      'assets',
      'space',
      'play',
      'view',
      'pivot',
      'orientation',
      'snap',
      'timeline',
      'output',
    ]);
  });

  it('has unique ids', () => {
    const ids = TOOLBAR_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
