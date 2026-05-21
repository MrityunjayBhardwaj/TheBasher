// Pure helpers extracted from DiffBar (#31).
//
// DiffBar.tsx is a React shell — its visual rendering, click handlers,
// and zustand subscriptions are exercised by Playwright e2e (this
// project has no React Testing Library; W2 acceptance gate #15 forbids
// new external deps). What CAN be unit-tested in vitest is the pure
// data shaping that drives the `data-testid="diffbar-…"` markers:
//
//   - `countBySource`        → drives `diffbar-sources`
//   - `extractTimeRange`     → drives `diffbar-time-range`
//   - `formatTimeRange`      → text inside `diffbar-time-range`
//   - `hasMetaToShow`        → drives the strip's visibility
//
// Closure/warnings are simple `.size > 0` / `.length > 0` JSX
// conditionals with no logic worth extracting; the e2e gate is the
// right tool for those.
//
// REF: #31 (Wave C1 render-path test coverage), `src/app/DiffBar.tsx`,
// `tests/e2e/p3-acceptance.spec.ts:251` (the existing diffbar-time-range
// e2e — covers visibility; this file covers the shaping logic).

import type { Op } from '../core/dag/types';

export interface SourceCount {
  source: string;
  count: number;
}

/**
 * Count ops per source label. Used to render the `Sources:` row when
 * the diff was contributed to by more than one Mutator / direct tool.
 *
 * Default: when no per-op source tracking is present (legacy callers,
 * older planners), returns a single `{ source: 'agent', count: total }`
 * entry. Callers gate the row on `result.length > 1`, so the default
 * stays hidden.
 *
 * Sort: descending by count so the dominant source leads.
 */
export function countBySource(opSources: string[] | undefined, total: number): SourceCount[] {
  if (!opSources || opSources.length === 0) return [{ source: 'agent', count: total }];
  const counts = new Map<string, number>();
  for (const s of opSources) counts.set(s, (counts.get(s) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}

export interface TimeRange {
  min: number;
  max: number;
}

const CHANNEL_NODE_TYPES = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec3',
  'KeyframeChannelQuat',
  'KeyframeChannelColor',
]);

/**
 * Walk a pending Op chain looking for explicit time values. Sources:
 *   - addNode of a KeyframeChannel* with seeded keyframes → keyframe times
 *   - addNode of a Shot                                  → startTime/endTime
 *   - setParam where paramPath is 'keyframes'           → element times
 *   - setParam where paramPath is 'time' (single keyframe field) → that scalar
 *
 * Returns null when no temporal data is found — the diffbar-time-range
 * row stays hidden.
 */
export function extractTimeRange(ops: Op[]): TimeRange | null {
  let min = Infinity;
  let max = -Infinity;
  const consume = (t: unknown) => {
    if (typeof t !== 'number' || !Number.isFinite(t)) return;
    if (t < min) min = t;
    if (t > max) max = t;
  };

  for (const op of ops) {
    if (op.type === 'addNode') {
      const params = (op.params ?? {}) as Record<string, unknown>;
      if (CHANNEL_NODE_TYPES.has(op.nodeType)) {
        const kfs = (params.keyframes as Array<{ time?: unknown }> | undefined) ?? [];
        for (const k of kfs) consume(k.time);
      } else if (op.nodeType === 'Shot') {
        consume(params.startTime);
        consume(params.endTime);
      }
    } else if (op.type === 'setParam') {
      if (op.paramPath === 'keyframes' && Array.isArray(op.value)) {
        for (const k of op.value as Array<{ time?: unknown }>) consume(k?.time);
      } else if (op.paramPath === 'time') {
        consume(op.value);
      }
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/** Human-readable formatter for the time-range row. */
export function formatTimeRange({ min, max }: TimeRange): string {
  if (Math.abs(max - min) < 1e-6) return `t=${formatSeconds(min)}`;
  return `${formatSeconds(min)} → ${formatSeconds(max)}s`;
}

/** Trim trailing zeros: 1 → "1", 0.5 → "0.5", 1.250 → "1.25". */
export function formatSeconds(n: number): string {
  return Number.isInteger(n) ? `${n}` : `${parseFloat(n.toFixed(3))}`;
}

/**
 * Predicate the strip's visibility derives from. The strip renders only
 * when at least one signal is present. Exported for the same reason —
 * the boolean composition is small but easy to break (e.g. forgetting
 * to OR in `timeRange !== null` after Wave D landed it).
 */
export function hasMetaToShow(args: {
  sourceCounts: readonly SourceCount[];
  closureNodeCount: number;
  warningsCount: number;
  timeRange: TimeRange | null;
}): boolean {
  return (
    args.sourceCounts.length > 1 ||
    args.closureNodeCount > 0 ||
    args.warningsCount > 0 ||
    args.timeRange !== null
  );
}
