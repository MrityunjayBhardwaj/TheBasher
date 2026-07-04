// #225 — the N-selected Inspector. Before this, selecting N objects showed
// the PRIMARY node identically to selecting 1 — the selected SET was inert
// (the `MULTI_SELECT_SECTIONS` const was defined but never consumed). This
// renders a true multi-state: an "N objects selected" summary + a shared
// Transform section whose fields edit EVERY selected node at once.
//
// Semantics (the fork the user chose — "shared edit: set-on-all"):
//   • each axis shows the value SHARED across all selected nodes that have
//     that param, or "—" (mixed) when they differ / a placeholder when none,
//   • editing a field dispatches ONE atomic setParam batch over every
//     selected node that owns that param → one undo reverts the whole edit,
//   • rotation is degrees (raw param units, same as the single inspector).
//
// KNOWN-LIMIT (v1): the edit writes the STATIC source param. A selected node
// that is ANIMATED on that field renders from its channel, so the multi-edit
// may be invisible for it (no keyframe is authored) — multi-keyframing is a
// later slice. Most multi-selected nodes are static, so this is acceptable.
//
// V1: every mutation is a setParam Op through dispatchAtomic — no setState.

import { useMemo } from 'react';
import { useDagStore } from '../core/dag/store';
import type { Node, Op } from '../core/dag/types';
import { useSelectionStore } from './stores/selectionStore';
import { nodeDisplayName } from './sceneTreeWalk';

type Vec3 = [number, number, number];
const AXES = ['x', 'y', 'z'] as const;

/** Transform fields the shared section edits, in display order. */
const TRANSFORM_FIELDS = [
  { key: 'position', label: 'Position' },
  { key: 'rotation', label: 'Rotation' },
  { key: 'scale', label: 'Scale' },
] as const;

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/** The value shared across `nodes` for `field`[`axis`]:
 *   - a number when every node that HAS the param agrees,
 *   - 'mixed' when they disagree,
 *   - null when NO selected node has the param (the row hides). */
function sharedAxis(nodes: Node[], field: string, axis: number): number | 'mixed' | null {
  const vals: number[] = [];
  for (const n of nodes) {
    const v = (n.params as Record<string, unknown>)[field];
    if (isVec3(v)) vals.push(v[axis]);
  }
  if (vals.length === 0) return null;
  const first = vals[0];
  return vals.every((x) => x === first) ? first : 'mixed';
}

/** Trim float noise for display (matches the 3-dp convention elsewhere). */
function fmt(n: number): string {
  return Number.isInteger(n) ? `${n}` : `${parseFloat(n.toFixed(3))}`;
}

interface MultiAxisInputProps {
  readonly shared: number | 'mixed';
  readonly onCommit: (value: number) => void;
  readonly ariaLabel: string;
}

/** One axis cell. `key`ed by `shared` upstream so an external change (commit,
 *  selection change) remounts it with a fresh uncontrolled value — no draft
 *  state to drift. Mixed → empty with a "—" placeholder. */
function MultiAxisInput({ shared, onCommit, ariaLabel }: MultiAxisInputProps) {
  const mixed = shared === 'mixed';
  function commit(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === '') return; // empty (untouched mixed field) → no write
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    onCommit(parsed);
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      defaultValue={mixed ? '' : fmt(shared)}
      placeholder={mixed ? '—' : ''}
      className="w-full rounded border border-border bg-muted px-1 py-0.5 text-right font-mono text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={(e) => commit(e.target.value)}
    />
  );
}

export function MultiSelectInspector() {
  const selectedIds = useSelectionStore((s) => s.selectedNodeIds);
  const nodesById = useDagStore((s) => s.state.nodes);
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);

  const nodes = useMemo(
    () => [...selectedIds].map((id) => nodesById[id]).filter((n): n is Node => Boolean(n)),
    [selectedIds, nodesById],
  );

  // Which transform fields ANY selected node owns (others are hidden, not
  // shown as dead rows).
  const fields = useMemo(
    () =>
      TRANSFORM_FIELDS.filter(({ key }) =>
        nodes.some((n) => isVec3((n.params as Record<string, unknown>)[key])),
      ),
    [nodes],
  );

  function setAxis(field: string, axis: number, value: number) {
    // Read LIVE state — NOT the render-scope `nodes` closure. An Enter commit
    // then the input's own blur both call this; reading live params means the
    // second call sees the already-applied value and the `cur===value` skip
    // makes it a true no-op (no redundant atomic whose inverse can't undo).
    const liveIds = useSelectionStore.getState().selectedNodeIds;
    const liveNodes = useDagStore.getState().state.nodes;
    const ops: Op[] = [];
    for (const id of liveIds) {
      const n = liveNodes[id];
      const cur = (n?.params as Record<string, unknown> | undefined)?.[field];
      if (!isVec3(cur)) continue;
      if (cur[axis] === value) continue; // skip no-ops (keeps the batch minimal)
      const next: Vec3 = [...cur];
      next[axis] = value;
      ops.push({ type: 'setParam', nodeId: id, paramPath: field, value: next });
    }
    if (ops.length === 0) return;
    dispatchAtomic(ops, 'user', `set ${field}.${AXES[axis]} on ${ops.length} objects`);
  }

  const names = nodes.map(nodeDisplayName);
  const summary =
    names.length <= 3
      ? names.join(', ')
      : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;

  return (
    <div data-testid="inspector-multi" className="flex flex-col text-xs">
      <div className="border-b border-border px-3 py-2">
        <div data-testid="inspector-multi-count" className="font-medium text-fg">
          {nodes.length} objects selected
        </div>
        <div className="truncate text-[10px] text-fg/40" title={names.join(', ')}>
          {summary}
        </div>
      </div>

      {fields.length === 0 ? (
        <div className="p-4 text-fg-dim">No shared transform to edit.</div>
      ) : (
        <section
          data-testid="inspector-multi-transform"
          className="flex flex-col gap-1.5 px-3 py-2"
        >
          <div className="text-[11px] font-medium uppercase tracking-wide text-fg-dim">
            Transform
          </div>
          {fields.map(({ key, label }) => (
            <div key={key} className="grid grid-cols-[auto_1fr_1fr_1fr] items-center gap-1">
              <span className="w-16 font-mono text-[10px] text-fg/60">{label}</span>
              {AXES.map((axisName, axisIdx) => {
                const shared = sharedAxis(nodes, key, axisIdx);
                if (shared === null) return <span key={axisName} />;
                return (
                  <MultiAxisInput
                    key={`${key}-${axisName}-${String(shared)}`}
                    shared={shared}
                    ariaLabel={`${label} ${axisName.toUpperCase()} (all selected)`}
                    onCommit={(v) => setAxis(key, axisIdx, v)}
                  />
                );
              })}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
