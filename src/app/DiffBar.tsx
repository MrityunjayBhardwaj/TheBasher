// DiffBar — accept/reject UI for pending agent diffs.
//
// Floats over the top of the viewport when a diff is pending. Shows the
// description, per-op toggles, Apply / Reject, and "X selected of Y" status.
//
// Dispatch lives in src/app/ (V8 file-rooted — dispatch from src/app/ is
// allowed; dispatch from src/viewport/ is not).
//
// GEOMETRY (#327) — why this bar is a BOUNDED CENTERED ISLAND and not a
// full-bleed strip. It used to be a full-width bar in the NORMAL FLOW of the
// view3d slot, with its actions right-aligned. Two consequences, both observed
// in the running app and both invisible to the suite:
//
//   1. The side islands (outliner/inspector) float OVER that slot at zIndex 20.
//      A full-width bar therefore ran UNDERNEATH them — and its Apply/Reject
//      live at the right end, exactly where the inspector sits. Measured at the
//      default 1680x1000 with the inspector open: 0 of 9 sample points across
//      Apply belonged to Apply (elementFromPoint returned the inspector's
//      header). The agent proposed and the director could not accept. The button
//      was VISIBLE and UNREACHABLE, which is why `toBeVisible()` never caught it
//      — occlusion is a different question from visibility (V35).
//   2. Being in FLOW, the bar SHOVED the canvas down by its own height the
//      instant a diff appeared — the ghost preview jumped at the exact moment
//      the director was asked to judge it.
//
// The fix is the same collapse-aware reserve every other centered surface uses
// (centerSurfaceWidthCss — the ONE geometry source, V46), NOT a z-index bump: a
// bump would keep the bar full-bleed and merely trade which surface is buried
// (the sibling AssetErrorBanner took the z-index road in #261 and now covers the
// inspector when it fires). Reserving the band means the bar and the islands
// never contend for a pixel in the first place. Anchored below the toolbar pill
// (CENTER_SURFACE_TOP) so it shares no band with it either.
//
// REF: THESIS.md §19 (Diff-first), krama K3; #327; V35 (reveal reachable),
// V46 (one geometry source), H91/V45 (floating-surface overlap family).

import { useState } from 'react';
import { useDiffStore, acceptSelectedOps } from '../agent/diff';
import { useDagStore } from '../core/dag/store';
import { countBySource, extractTimeRange, formatTimeRange, hasMetaToShow } from './DiffBar.helpers';
import { useIsNarrowLayout } from './hooks/useIsNarrowLayout';
import { CENTER_SURFACE_TOP, centerSurfaceWidthCss } from './layoutIslands';
import { useChromeStore } from './stores/chromeStore';

export function DiffBar() {
  const status = useDiffStore((s) => s.status);
  const pendingDiff = useDiffStore((s) => s.pendingDiff);
  const selectAll = useDiffStore((s) => s.selectAll);
  const reject = useDiffStore((s) => s.reject);
  const [accepting, setAccepting] = useState(false);
  // The live collapse flags — folding a side panel gives the bar that width
  // back, same as the toolbar and the 2D View.
  const leftCollapsed = useChromeStore((s) => s.leftSidebarCollapsed);
  const inspectorCollapsed = useChromeStore((s) => s.inspectorCollapsed);
  const isNarrow = useIsNarrowLayout();

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

  const hasMeta = hasMetaToShow({
    sourceCounts,
    closureNodeCount,
    warningsCount: warnings.length,
    timeRange,
  });

  return (
    <div
      data-testid="diffbar"
      style={{
        // Bounded centered island in the clear band between the side islands —
        // never under one, and out of flow so the canvas does not jump when a
        // diff arrives. See the geometry note at the top of this file.
        position: 'absolute',
        top: CENTER_SURFACE_TOP,
        left: '50%',
        transform: 'translateX(-50%)',
        width: centerSurfaceWidthCss({ isNarrow, leftCollapsed, inspectorCollapsed }),
        // Below the side islands (20): the reserve already keeps them apart, so
        // if the two ever disagree the islands win rather than this bar burying
        // them — the failure mode stays visible instead of swapping victims.
        zIndex: 15,
        display: 'flex',
        flexDirection: 'column',
        background: '#1a1a2e',
        border: '1px solid #333',
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.4)',
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
          <button data-testid="diffbar-select-all" onClick={() => selectAll(true)} style={btnStyle}>
            Select all
          </button>
        )}
        <button
          data-testid="diffbar-apply"
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
          data-testid="diffbar-reject"
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

const btnStyle: React.CSSProperties = {
  border: '1px solid #444',
  borderRadius: 4,
  padding: '3px 10px',
  cursor: 'pointer',
  fontSize: 12,
  background: '#222',
  color: '#aaa',
};
