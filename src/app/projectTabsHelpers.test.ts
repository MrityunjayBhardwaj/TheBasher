// Unit tests for the ProjectTabs pure helpers (P6 W3 / D-UX-12 / D-02).
//
// Verifies the hover-tooltip formatter exhaustively across the
// granularity boundaries (just-now / Ns / Nm / Nh / Nd) AND the
// null-lastSavedAt path AND the dirty=true prefix path.

import { describe, expect, it } from 'vitest';
import { formatSavedAgo, formatTooltip } from './projectTabsHelpers';

const NOW = 1_000_000_000_000; // arbitrary epoch ms anchor for the test

describe('formatSavedAgo', () => {
  it('null lastSavedAt → "never saved"', () => {
    expect(formatSavedAgo(NOW, null)).toBe('never saved');
  });

  it('diff < 10s → "saved just now"', () => {
    expect(formatSavedAgo(NOW, NOW)).toBe('saved just now');
    expect(formatSavedAgo(NOW, NOW - 9_000)).toBe('saved just now');
  });

  it('10s ≤ diff < 60s → "saved Ns ago"', () => {
    expect(formatSavedAgo(NOW, NOW - 10_000)).toBe('saved 10s ago');
    expect(formatSavedAgo(NOW, NOW - 30_000)).toBe('saved 30s ago');
    expect(formatSavedAgo(NOW, NOW - 59_000)).toBe('saved 59s ago');
  });

  it('1m ≤ diff < 60m → "saved Nm ago"', () => {
    expect(formatSavedAgo(NOW, NOW - 60_000)).toBe('saved 1m ago');
    expect(formatSavedAgo(NOW, NOW - 5 * 60_000)).toBe('saved 5m ago');
    expect(formatSavedAgo(NOW, NOW - 59 * 60_000)).toBe('saved 59m ago');
  });

  it('1h ≤ diff < 24h → "saved Nh ago"', () => {
    expect(formatSavedAgo(NOW, NOW - 60 * 60_000)).toBe('saved 1h ago');
    expect(formatSavedAgo(NOW, NOW - 5 * 60 * 60_000)).toBe('saved 5h ago');
    expect(formatSavedAgo(NOW, NOW - 23 * 60 * 60_000)).toBe('saved 23h ago');
  });

  it('≥ 24h → "saved Nd ago"', () => {
    expect(formatSavedAgo(NOW, NOW - 24 * 60 * 60_000)).toBe('saved 1d ago');
    expect(formatSavedAgo(NOW, NOW - 3 * 24 * 60 * 60_000)).toBe('saved 3d ago');
  });

  it('clamps negative diffs (clock skew) to "saved just now"', () => {
    // Future timestamp (e.g. system clock changed): treat as just-now,
    // never "saved -5s ago".
    expect(formatSavedAgo(NOW, NOW + 5_000)).toBe('saved just now');
  });
});

describe('formatTooltip', () => {
  it('dirty=false → plain saved-ago text', () => {
    expect(formatTooltip(NOW, NOW - 5 * 60_000, false)).toBe('saved 5m ago');
    expect(formatTooltip(NOW, null, false)).toBe('never saved');
  });

  it('dirty=true → "unsaved changes · " prefix', () => {
    expect(formatTooltip(NOW, NOW - 5 * 60_000, true)).toBe('unsaved changes · saved 5m ago');
    expect(formatTooltip(NOW, null, true)).toBe('unsaved changes · never saved');
    expect(formatTooltip(NOW, NOW, true)).toBe('unsaved changes · saved just now');
  });
});
