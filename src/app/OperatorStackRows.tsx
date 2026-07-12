// OperatorStackRows — the ONE stack-panel presentation, shared by every operator
// stack (#312). Blender's stack UX is identical whatever the operator writes: a list
// of rows bottom → top, each with mute / reorder / remove, plus an "+ Add" row.
//
// THE SPLIT (why this is a component and not a hook or a base class):
//   - PRESENTATION is genuinely identical across stacks → this file, once.
//   - ENUMERATION and the OP-BUILDERS are genuinely different → NOT shared:
//       geometry (SOP)  : an edge-wired sub-chain — enumerateModifierStack, and
//                         add/move/remove are RE-WIRING (operatorStack.ts).
//       constraints(CHOP): an edge-LESS set on one target — constraintStackEntries,
//                         and add/move/remove are `target` + `order` field writes
//                         (constraintStack.ts). A constraint has no data edge, so it
//                         cannot be a sub-chain ("modifiers are; constraints aren't").
//   Each caller passes its own entries + its own handlers. DRY where the domain
//   actually repeats; separate where it doesn't.
//
// Rows are the normalized `StackRowEntry` ({nodeId, muted, label}) — never raw nodes,
// so a stack whose members store mute under a different param name (`muted` on a
// modifier, `mute` on a constraint) still renders through one path; each op-builder
// writes its own param.
//
// REF: src/app/ModifierStackControls.tsx + src/app/ConstraintStackControls.tsx (the
//      two callers); src/app/operatorStack.ts + src/app/constraintStack.ts (builders).

import type { ReactNode } from 'react';

/** The one row shape every stack normalizes to. Structurally `ModifierEntry`. */
export interface StackRowEntry {
  readonly nodeId: string;
  readonly muted: boolean;
  readonly label: string;
}

export interface OperatorStackRowsProps {
  /** Bottom → top. */
  readonly entries: ReadonlyArray<StackRowEntry>;
  /** Prefixes every data-testid: `${testIdPrefix}-stack`, `-row-`, `-mute-`, … */
  readonly testIdPrefix: string;
  /** The "+ Add" buttons. */
  readonly addable: ReadonlyArray<{ readonly type: string; readonly label: string }>;
  readonly selectedNodeId: string | null;
  readonly emptyLabel: string;
  readonly onSelect: (nodeId: string) => void;
  readonly onMute: (nodeId: string) => void;
  readonly onMove: (nodeId: string, dir: 'up' | 'down') => void;
  readonly onRemove: (nodeId: string) => void;
  readonly onAdd: (type: string) => void;
  /** Stack-specific banner above the rows (e.g. the modifier unsupported-source warning). */
  readonly banner?: ReactNode;
}

const BTN =
  'rounded border border-border px-1.5 py-0.5 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg';

export function OperatorStackRows({
  entries,
  testIdPrefix,
  addable,
  selectedNodeId,
  emptyLabel,
  onSelect,
  onMute,
  onMove,
  onRemove,
  onAdd,
  banner,
}: OperatorStackRowsProps) {
  return (
    <div data-testid={`${testIdPrefix}-stack`} className="flex flex-col gap-1 text-xs">
      {banner}
      {entries.length === 0 ? (
        <p className="px-1 py-0.5 text-fg/60">{emptyLabel}</p>
      ) : (
        entries.map((e, i) => {
          const active = e.nodeId === selectedNodeId;
          return (
            <div
              key={e.nodeId}
              data-testid={`${testIdPrefix}-row-${e.nodeId}`}
              className={`flex items-center gap-1 rounded border px-1 py-0.5 ${
                active ? 'border-accent bg-bg-2' : 'border-border'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(e.nodeId)}
                className={`flex-1 truncate text-left ${e.muted ? 'text-fg/60 line-through' : 'text-fg'}`}
                title={e.label}
              >
                {e.label}
              </button>
              <button
                type="button"
                data-testid={`${testIdPrefix}-mute-${e.nodeId}`}
                aria-pressed={e.muted}
                onClick={() => onMute(e.nodeId)}
                className={BTN}
                title={e.muted ? 'Un-mute (re-enable)' : 'Mute (bypass)'}
              >
                {e.muted ? '◌' : '●'}
              </button>
              <button
                type="button"
                data-testid={`${testIdPrefix}-up-${e.nodeId}`}
                onClick={() => onMove(e.nodeId, 'up')}
                disabled={i === entries.length - 1}
                className={BTN}
                title="Move up (later in the stack)"
              >
                ▲
              </button>
              <button
                type="button"
                data-testid={`${testIdPrefix}-down-${e.nodeId}`}
                onClick={() => onMove(e.nodeId, 'down')}
                disabled={i === 0}
                className={BTN}
                title="Move down (earlier in the stack)"
              >
                ▼
              </button>
              <button
                type="button"
                data-testid={`${testIdPrefix}-remove-${e.nodeId}`}
                onClick={() => onRemove(e.nodeId)}
                className={BTN}
                title="Remove"
              >
                ✕
              </button>
            </div>
          );
        })
      )}
      <div className="flex items-center gap-1 pt-0.5">
        {addable.map((a) => (
          <button
            key={a.type}
            type="button"
            data-testid={`${testIdPrefix}-add-${a.type}`}
            onClick={() => onAdd(a.type)}
            className="rounded border border-border bg-bg-2 px-2 py-0.5 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            + {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
