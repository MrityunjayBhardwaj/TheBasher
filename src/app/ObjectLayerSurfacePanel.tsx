// ObjectLayerSurfacePanel — the read-only "what changes this object" panel (#1940 T2).
//
// A PURE VIEW over `objectLayerSurface`: given the selected Object's `nodeId`, it draws every lane
// that layers onto it — value lanes (channel/strip/driver) first, then structural (modifier/
// constraint/pose) — each row read == render (the folded value the renderer composes), with a
// caveat badge on a row whose render road is base-only today (#1928, `rendersBaseOnly`).
//
// It writes NOTHING and navigates NOWHERE. A click only calls `onPickRow` with the row's pick;
// the host (the shell's `goToLayerRow`) owns routing — opening the lane's existing inspector
// section / drawer tab and selecting its node. Display-only lanes (pose, strip in v1) still emit a
// pick; the host decides what to do. This keeps the panel reusable and the edit paths unmoved:
// editing stays in each lane's existing control, never here (the hybrid: merged read, per-lane edit).
//
// The surface is computed at the playhead (`usePlayheadFor`), through the shared UI evaluator cache,
// exactly as `StackPanel` reads its rows — so a per-scrub re-read stays warm and read == render.
//
// REF: issue #1940 (plan scratchpad/stage3-PLAN.md, slice T2); src/app/objectLayerSurface.ts
//      (the read model); src/app/StackPanel.tsx (the state/playhead/cache pattern). Mount + routing
//      are the shell's (basher-ai): this file imports no shell file.

import { useMemo } from 'react';
import { useDagStore } from '../core/dag/store';
import type { EvalCtx } from '../core/dag/types';
import { usePlayheadFor } from './animate/usePlayheadFor';
import {
  objectLayerSurface,
  type LaneGroup,
  type LaneName,
  type SurfaceRow,
} from './objectLayerSurface';
import { uiEvaluatorCache } from './uiEvaluatorCache';

/**
 * A click on a surface row, for the host to route. Pure intent — the panel performs no edit and no
 * navigation itself. `lane` is the row's OWN group (never "material": the host derives material-ness
 * from `paramPath`). `rowNodeId` is the node the row stands for, null for a synthetic strip.
 * `paramPath` is set on value rows (the animated param) and null on structural rows (route by node).
 */
export interface LayerRowPick {
  /** The row's own lane group — the SAME closed union the surface emits (never a bare string). */
  readonly lane: LaneName;
  readonly objectId: string;
  readonly rowNodeId: string | null;
  readonly paramPath: string | null;
}

export interface ObjectLayerSurfacePanelProps {
  /** The Object to show. The host passes `selectionStore.primaryNodeId`. */
  readonly nodeId: string;
  /** Called with a row's pick on click. The panel writes nothing and navigates nowhere. */
  readonly onPickRow: (pick: LayerRowPick) => void;
}

/** Value lanes carry a param path in `tag`; structural rows carry a human label there, not a path. */
const VALUE_LANES: ReadonlySet<string> = new Set(['channel', 'strip', 'driver']);

/** The header label for each lane group. */
const LANE_LABEL: Readonly<Record<string, string>> = {
  channel: 'Channels',
  strip: 'Strips',
  driver: 'Drivers',
  modifier: 'Modifiers',
  constraint: 'Constraints',
  pose: 'Pose layers',
};

/** The pick a click on `row` emits: lane = the row's own group, paramPath only on value rows. */
function pickOf(group: LaneGroup, row: SurfaceRow, objectId: string): LayerRowPick {
  return {
    lane: group.lane,
    objectId,
    rowNodeId: row.nodeId,
    paramPath: VALUE_LANES.has(group.lane) ? row.tag : null,
  };
}

export function ObjectLayerSurfacePanel({ nodeId, onPickRow }: ObjectLayerSurfacePanelProps) {
  const state = useDagStore((s) => s.state);
  // The playhead the folded values are read at (read == render), subscribed while the object moves.
  const { frame, seconds, normalized } = usePlayheadFor(nodeId);
  const ctx = useMemo<EvalCtx>(
    () => ({ time: { frame, seconds, normalized } }),
    [frame, seconds, normalized],
  );
  const surface = useMemo(
    () => objectLayerSurface(state, nodeId, ctx, uiEvaluatorCache),
    [state, nodeId, ctx],
  );

  if (surface.groups.length === 0) {
    return (
      <p data-testid="object-layer-surface-empty" className="px-2 py-1.5 text-xs text-fg-dim">
        Nothing changes this object yet.
      </p>
    );
  }

  return (
    <div data-testid="object-layer-surface" className="flex flex-col gap-2">
      {surface.groups.map((group) => (
        <section key={group.lane} data-testid={`object-layer-group-${group.lane}`}>
          <header className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-fg-dim">
            <span>{LANE_LABEL[group.lane] ?? group.lane}</span>
            <span className="tabular-nums">{group.count}</span>
          </header>
          <ul className="flex flex-col">
            {group.rows.map((row, i) => (
              <li key={`${group.lane}:${row.nodeId ?? row.tag}:${i}`}>
                <button
                  type="button"
                  data-testid={`object-layer-row-${group.lane}`}
                  onClick={() => onPickRow(pickOf(group, row, surface.objectId))}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs text-fg hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{row.name}</span>
                    {row.muted ? <span className="text-fg-dim">(muted)</span> : null}
                    {row.rendersBaseOnly ? (
                      <span
                        data-testid="object-layer-row-base-only"
                        title="Reads right, but renders the base value today (#1928)"
                        className="shrink-0 rounded border border-dashed border-border px-1 text-[10px] text-fg-dim"
                      >
                        renders base
                      </span>
                    ) : null}
                  </span>
                  {row.influence !== null ? (
                    <span className="shrink-0 tabular-nums text-fg-dim">{row.influence}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
