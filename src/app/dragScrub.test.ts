// dragScrub — pure-math tests for the per-pixel scrub sensitivity. The
// React hook that owns pointer-event lifecycle is exercised by the
// Inspector E2E (one drag → one Op → one undo entry).

import { describe, expect, it } from 'vitest';
import {
  computeScrubDelta,
  SCRUB_COARSE_PER_PIXEL,
  SCRUB_DEFAULT_PER_PIXEL,
  SCRUB_FINE_PER_PIXEL,
  scrubSensitivity,
} from './dragScrub';

describe('dragScrub.scrubSensitivity', () => {
  it('default is 0.01 per pixel (THESIS.md §15 default)', () => {
    expect(scrubSensitivity({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe(
      SCRUB_DEFAULT_PER_PIXEL,
    );
  });

  it('shift = fine (0.001)', () => {
    expect(scrubSensitivity({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe(
      SCRUB_FINE_PER_PIXEL,
    );
  });

  it('cmd / ctrl = coarse (0.1)', () => {
    expect(scrubSensitivity({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(
      SCRUB_COARSE_PER_PIXEL,
    );
    expect(scrubSensitivity({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe(
      SCRUB_COARSE_PER_PIXEL,
    );
  });

  it('shift wins over cmd when both are held (fine takes precedence)', () => {
    expect(scrubSensitivity({ shiftKey: true, metaKey: true, ctrlKey: false })).toBe(
      SCRUB_FINE_PER_PIXEL,
    );
  });
});

describe('dragScrub.computeScrubDelta', () => {
  it('100px to the right at default sensitivity adds 1.0', () => {
    expect(
      computeScrubDelta(5, 100, { shiftKey: false, metaKey: false, ctrlKey: false }),
    ).toBeCloseTo(6);
  });

  it('100px with shift adds 0.1 (fine)', () => {
    expect(
      computeScrubDelta(5, 100, { shiftKey: true, metaKey: false, ctrlKey: false }),
    ).toBeCloseTo(5.1);
  });

  it('100px with cmd adds 10 (coarse)', () => {
    expect(
      computeScrubDelta(5, 100, { shiftKey: false, metaKey: true, ctrlKey: false }),
    ).toBeCloseTo(15);
  });

  it('negative pixel delta scrubs the value down', () => {
    expect(
      computeScrubDelta(0, -50, { shiftKey: false, metaKey: false, ctrlKey: false }),
    ).toBeCloseTo(-0.5);
  });
});
