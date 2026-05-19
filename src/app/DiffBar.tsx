// DiffBar — accept/reject UI for pending agent diffs.
//
// Sits above the viewport when a diff is pending. Shows the description,
// per-op toggles, Apply All / Reject, and "X selected of Y" status.
//
// Dispatch lives in src/app/ (V8 file-rooted — dispatch from src/app/ is
// allowed; dispatch from src/viewport/ is not).
//
// REF: THESIS.md §19 (Diff-first), krama K3.

import { useState } from 'react';
import { useDiffStore, acceptSelectedOps } from '../agent/diff';
import { useDagStore } from '../core/dag/store';
import type { Op } from '../core/dag/types';

export function DiffBar() {
  const status = useDiffStore((s) => s.status);
  const pendingDiff = useDiffStore((s) => s.pendingDiff);
  const selectAll = useDiffStore((s) => s.selectAll);
  const reject = useDiffStore((s) => s.reject);
  const [accepting, setAccepting] = useState(false);

  if (status !== 'pending' || !pendingDiff) return null;

  const total = pendingDiff.ops.length;
  const selectedCount = pendingDiff.selected.filter(Boolean).length;

  // Wave C1 — derive Mutator metadata from existing PendingDiff fields.
  // Source breakdown: count ops per source label (e.g. "agent:mesh.add").
  const sourceCounts = countBySource(pendingDiff.opSources, total);
  const closureNodeCount = pendingDiff.closure?.nodes.size ?? 0;
  const closureRoots = pendingDiff.closure?.spec.rootSelectors ?? [];
  const warnings = pendingDiff.warnings ?? [];
  // Wave D — time-range indicator. Animation Mutators emit ops that carry
  // explicit time values (keyframes / Shot bounds). Surfacing the range
  // lets the user see at a glance "this diff lands keyframes between
  // t=0 and t=2" before accepting.
  const timeRange = extractTimeRange(pendingDiff.ops);

  const handleApply = () => {
    setAccepting(true);
    try {
      const dag = useDagStore.getState();
      acceptSelectedOps(dag.dispatchAtomic.bind(dag));
    } finally {
      setAccepting(false);
    }
  };

  const hasMeta =
    sourceCounts.length > 1 || closureNodeCount > 0 || warnings.length > 0 || timeRange !== null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: '#1a1a2e',
        borderBottom: '1px solid #333',
        fontSize: 13,
        color: '#ccc',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px' }}>
        <span style={{ fontWeight: 600, color: '#88aaff', marginRight: 8 }}>Agent Diff</span>
        <span
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {pendingDiff.description}
        </span>
        <span style={{ color: '#888', fontSize: 12 }}>
          {selectedCount}/{total} selected
        </span>
        {selectedCount !== total && (
          <button onClick={() => selectAll(true)} style={btnStyle}>
            Select all
          </button>
        )}
        <button
          onClick={handleApply}
          disabled={accepting || selectedCount === 0}
          style={{
            ...btnStyle,
            background: selectedCount > 0 ? '#2d6a4f' : '#333',
            color: selectedCount > 0 ? '#fff' : '#666',
          }}
        >
          {accepting ? 'Applying...' : `Apply${selectedCount < total ? ` (${selectedCount})` : ''}`}
        </button>
        <button
          onClick={() => reject()}
          style={{ ...btnStyle, background: '#5a1a1a', color: '#ff8888' }}
        >
          Reject
        </button>
      </div>

      {hasMeta && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            padding: '4px 12px 6px',
            borderTop: '1px solid #2a2a3e',
            fontSize: 11,
            color: '#9aa',
          }}
        >
          {sourceCounts.length > 1 && (
            <span data-testid="diffbar-sources">
              <span style={{ color: '#666' }}>Sources:</span>{' '}
              {sourceCounts.map((s, i) => (
                <span key={s.source}>
                  {i > 0 && <span style={{ color: '#444' }}> · </span>}
                  <span style={{ color: '#bbc' }}>{s.source.replace(/^agent:/, '')}</span>
                  <span style={{ color: '#666' }}> ×{s.count}</span>
                </span>
              ))}
            </span>
          )}
          {closureNodeCount > 0 && (
            <span data-testid="diffbar-closure">
              <span style={{ color: '#666' }}>Scope:</span>{' '}
              <span style={{ color: '#bbc' }}>
                {closureNodeCount} node{closureNodeCount === 1 ? '' : 's'}
              </span>
              {closureRoots.length > 0 && (
                <span style={{ color: '#666' }}> from {closureRoots.join(', ')}</span>
              )}
            </span>
          )}
          {timeRange && (
            <span data-testid="diffbar-time-range">
              <span style={{ color: '#666' }}>Time:</span>{' '}
              <span style={{ color: '#bbc' }}>{formatTimeRange(timeRange)}</span>
            </span>
          )}
          {warnings.length > 0 && (
            <span data-testid="diffbar-warnings" style={{ color: '#d4a554' }}>
              ⚠ {warnings.join(' · ')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface SourceCount {
  source: string;
  count: number;
}

function countBySource(opSources: string[] | undefined, total: number): SourceCount[] {
  if (!opSources || opSources.length === 0) return [{ source: 'agent', count: total }];
  const counts = new Map<string, number>();
  for (const s of opSources) counts.set(s, (counts.get(s) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}

interface TimeRange {
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
 * Walk the pending Op chain looking for explicit time values. Sources:
 * - addNode of a KeyframeChannel* with seeded keyframes → keyframe times
 * - addNode of a Shot                                  → startTime/endTime
 * - setParam where paramPath is 'keyframes'           → element times
 * - setParam where paramPath is 'time' (single keyframe field) → that scalar
 *
 * Returns null when no temporal data is found (the row stays hidden).
 */
function extractTimeRange(ops: Op[]): TimeRange | null {
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

function formatTimeRange({ min, max }: TimeRange): string {
  if (Math.abs(max - min) < 1e-6) return `t=${formatSeconds(min)}`;
  return `${formatSeconds(min)} → ${formatSeconds(max)}s`;
}

function formatSeconds(n: number): string {
  // Trim trailing zeros: 1 → "1", 0.5 → "0.5", 1.250 → "1.25".
  return Number.isInteger(n) ? `${n}` : `${parseFloat(n.toFixed(3))}`;
}

const btnStyle: React.CSSProperties = {
  border: '1px solid #444',
  borderRadius: 4,
  padding: '3px 10px',
  cursor: 'pointer',
  fontSize: 12,
  background: '#222',
  color: '#aaa',
};
