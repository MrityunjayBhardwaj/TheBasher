// Coverage for the DiffBar pure helpers (#31).
//
// DiffBar.tsx's React shell is e2e-tested (Playwright owns visibility +
// click flow); these tests pin the data shaping that drives the
// `data-testid="diffbar-…"` markers. If `countBySource` ever stops
// sorting descending, or `hasMetaToShow` ever forgets a signal, the
// strip silently shows the wrong thing — these tests catch that
// without needing a headed browser.

import { describe, expect, it } from 'vitest';
import type { Op } from '../core/dag/types';
import {
  countBySource,
  extractTimeRange,
  formatSeconds,
  formatTimeRange,
  hasMetaToShow,
  type SourceCount,
  type TimeRange,
} from './DiffBar.helpers';

describe('countBySource', () => {
  it('returns a single "agent" entry when no per-op tracking is present', () => {
    // Legacy + headless callers — no per-op source labels. The strip
    // gates `Sources:` on `result.length > 1` so a single entry stays
    // hidden; the row never appears unless the source breakdown is
    // information.
    expect(countBySource(undefined, 5)).toEqual([{ source: 'agent', count: 5 }]);
    expect(countBySource([], 3)).toEqual([{ source: 'agent', count: 3 }]);
  });

  it('counts ops per source label', () => {
    const result = countBySource(['agent:mesh.add', 'agent:mesh.add', 'agent:mutator.rotate'], 3);
    expect(result).toEqual([
      { source: 'agent:mesh.add', count: 2 },
      { source: 'agent:mutator.rotate', count: 1 },
    ]);
  });

  it('sorts descending by count (dominant source first)', () => {
    const result = countBySource(
      ['agent:a', 'agent:b', 'agent:b', 'agent:b', 'agent:c', 'agent:c'],
      6,
    );
    expect(result.map((r) => r.count)).toEqual([3, 2, 1]);
    expect(result[0].source).toBe('agent:b');
  });
});

describe('hasMetaToShow', () => {
  const empty = {
    sourceCounts: [{ source: 'agent', count: 5 }] as SourceCount[],
    closureNodeCount: 0,
    warningsCount: 0,
    timeRange: null as TimeRange | null,
  };

  it('hides the strip when no signal is present', () => {
    // Single source (length 1) + zero closure + zero warnings + null
    // timeRange → nothing to show.
    expect(hasMetaToShow(empty)).toBe(false);
  });

  it('shows the strip when any single signal lights up', () => {
    expect(
      hasMetaToShow({ ...empty, sourceCounts: [...empty.sourceCounts, empty.sourceCounts[0]] }),
    ).toBe(true);
    expect(hasMetaToShow({ ...empty, closureNodeCount: 1 })).toBe(true);
    expect(hasMetaToShow({ ...empty, warningsCount: 1 })).toBe(true);
    expect(hasMetaToShow({ ...empty, timeRange: { min: 0, max: 1 } })).toBe(true);
  });
});

describe('extractTimeRange', () => {
  it('returns null when no Op carries time data', () => {
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'box', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
    ];
    expect(extractTimeRange(ops)).toBeNull();
  });

  it('extracts keyframe times from a KeyframeChannel addNode', () => {
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelNumber',
        params: {
          keyframes: [
            { time: 0, value: 0 },
            { time: 0.5, value: 1 },
            { time: 2, value: 2 },
          ],
        },
      },
    ];
    expect(extractTimeRange(ops)).toEqual({ min: 0, max: 2 });
  });

  it('extracts startTime/endTime from a Shot addNode', () => {
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: 'sh',
        nodeType: 'Shot',
        params: { startTime: 1.5, endTime: 3.25 },
      },
    ];
    expect(extractTimeRange(ops)).toEqual({ min: 1.5, max: 3.25 });
  });

  it('extracts times from a setParam on `keyframes`', () => {
    const ops: Op[] = [
      {
        type: 'setParam',
        nodeId: 'ch',
        paramPath: 'keyframes',
        value: [
          { time: 0.25, value: 0 },
          { time: 1.75, value: 1 },
        ],
      },
    ];
    expect(extractTimeRange(ops)).toEqual({ min: 0.25, max: 1.75 });
  });

  it('extracts a scalar time from a setParam on `time`', () => {
    const ops: Op[] = [{ type: 'setParam', nodeId: 'ch', paramPath: 'time', value: 0.5 }];
    expect(extractTimeRange(ops)).toEqual({ min: 0.5, max: 0.5 });
  });

  it('reduces across mixed Op types — takes overall min/max', () => {
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: { keyframes: [{ time: 0.1 }] },
      },
      { type: 'addNode', nodeId: 'sh', nodeType: 'Shot', params: { startTime: 0, endTime: 5 } },
      { type: 'setParam', nodeId: 'ch', paramPath: 'time', value: 3 },
    ];
    expect(extractTimeRange(ops)).toEqual({ min: 0, max: 5 });
  });

  it('ignores non-finite / non-number time values defensively', () => {
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelNumber',
        params: {
          keyframes: [
            { time: NaN },
            { time: Infinity },
            { time: 'bad' as unknown as number },
            { time: 1 },
          ],
        },
      },
    ];
    expect(extractTimeRange(ops)).toEqual({ min: 1, max: 1 });
  });
});

describe('formatTimeRange + formatSeconds', () => {
  it('collapses a zero-width range to `t=…`', () => {
    expect(formatTimeRange({ min: 0.5, max: 0.5 })).toBe('t=0.5');
  });

  it('renders a non-zero range with an arrow + trailing "s"', () => {
    expect(formatTimeRange({ min: 0, max: 2 })).toBe('0 → 2s');
  });

  it('trims trailing zeros — formatSeconds: integers, 1-place, 3-place', () => {
    expect(formatSeconds(1)).toBe('1');
    expect(formatSeconds(0.5)).toBe('0.5');
    expect(formatSeconds(1.25)).toBe('1.25');
    // 1.2501 rounds to 3 decimals → '1.25' (trailing zero trimmed via parseFloat).
    expect(formatSeconds(1.2501)).toBe('1.25');
  });
});
