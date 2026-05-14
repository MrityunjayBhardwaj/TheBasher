// ModeBadge — formatBadge pure-function tests. The React shell + DOM
// positioning is covered by C4 Playwright e2e (no RTL in the project
// per W2 acceptance gate #15).
//
// REF: docs/UI-SPEC.md §5.6; src/viewport/ModeBadge.tsx.

import { describe, expect, it } from 'vitest';
import { formatBadge } from './ModeBadge';

const FPS = 60;
const DURATION = 10; // seconds → 600 frames at 60fps

describe('formatBadge', () => {
  it('returns "EDIT" in edit mode (frame/duration ignored)', () => {
    expect(formatBadge('edit', 0, DURATION, FPS)).toBe('EDIT');
    expect(formatBadge('edit', 250, DURATION, FPS)).toBe('EDIT');
  });

  it('returns "RUN N/M" in run mode using current frame and total frames', () => {
    expect(formatBadge('run', 0, DURATION, FPS)).toBe('RUN 0/600');
    expect(formatBadge('run', 47, DURATION, FPS)).toBe('RUN 47/600');
    expect(formatBadge('run', 600, DURATION, FPS)).toBe('RUN 600/600');
  });

  it('returns "ANIMATE Nfps" in animate mode (frame/duration ignored)', () => {
    expect(formatBadge('animate', 0, DURATION, FPS)).toBe('ANIMATE 60fps');
    expect(formatBadge('animate', 250, DURATION, FPS)).toBe('ANIMATE 60fps');
  });

  it('returns null in director mode so the badge hides entirely (D-UX-9)', () => {
    expect(formatBadge('director', 0, DURATION, FPS)).toBeNull();
    expect(formatBadge('director', 47, DURATION, FPS)).toBeNull();
  });

  it('rounds the total-frames count and clamps to >= 0 for zero/negative duration', () => {
    // 9.99s at 60fps rounds to 599 frames.
    expect(formatBadge('run', 0, 9.99, FPS)).toBe('RUN 0/599');
    // Zero/negative duration produces a sane "0/0" rather than NaN.
    expect(formatBadge('run', 0, 0, FPS)).toBe('RUN 0/0');
    expect(formatBadge('run', 0, -1, FPS)).toBe('RUN 0/0');
  });
});
