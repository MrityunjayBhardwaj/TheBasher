// StackFrame — the frame around the inspector's stacks (#1957, design board 14d): a Modifiers ·
// Constraints · Materials switch with counts, a flow strip in the order the stacks apply
// (Anim layers → Constraints → Modifiers) that takes you to each one, and the picked stack itself.
//
// ONE BOX (#1959). The picked stack is drawn INSIDE the frame, by the same section bodies that drew
// it as the inspector's Modifier, Constraint, Constraint Stack and Material cards (the inspector
// hands them in through `renderStack`, and stops drawing those cards for this selection), so a row
// looks and edits exactly as before and nothing is drawn twice. The switch swaps what the frame
// draws. Anim layers opens the drawer's Anim Layers tab.
//
// Picking a row selects it, as the panels always have; the frame stays up for a selected row and
// keeps its stack on. A stack this selection cannot draw (a selected data node carries only its
// Material section) is reached by going back to the object, as picking another row's stack does.
//
// A stack the object cannot take (#1960: a camera's or a light's Modifiers) stays a tab, dimmed and
// counted as not applicable. Picking it shows the Modifier section's note inside the frame, so a
// camera has one home for its stacks; the pick is a look (not remembered), and the frame never
// opens on it by itself.
//
// No stack presets exist yet, so there is no presets bar (one with nothing to offer would be a
// dead control). The blend/influence bar and the per-row tools belong to the shared stack panel.
//
// REF: issues #1957, #1959, #1960; design board 14d; src/app/stackFrameModel.ts.

import { useMemo, type ReactNode } from 'react';
import { useDagStore } from '../core/dag/store';
import { openDrawerTab } from './openDrawerTab';
import { nodeDisplayName } from './sceneTreeWalk';
import { useSelectionStore } from './stores/selectionStore';
import { useStackFrameStore } from './stores/stackFrameStore';
import {
  effectiveStack,
  flowOf,
  STACK_LABELS,
  stackFrameOf,
  type StackFrameView,
  type StackKind,
} from './stackFrameModel';
import { uiEvaluatorCache } from './uiEvaluatorCache';
import { resolveDataKind } from './modifierGeometry';
import type { DagState } from '../core/dag/state';

/** The question the modifier and material panels ask, through the inspector's cache. */
const dataKindOf = (state: DagState, dataId: string) =>
  resolveDataKind(state, dataId, uiEvaluatorCache);

/** The frame for a selection, or null where none shows. The inspector asks it to know which
 *  sections the frame takes in; the frame is handed the same answer. */
export function useStackFrameView(nodeId: string): StackFrameView | null {
  const state = useDagStore((s) => s.state);
  return useMemo(() => stackFrameOf(state, nodeId, dataKindOf), [state, nodeId]);
}

const TAB =
  'rounded-md px-2 py-0.5 text-[12px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

export function StackFrame({
  nodeId,
  view,
  drawable,
  renderStack,
}: {
  nodeId: string;
  view: StackFrameView | null;
  /** The stacks the inspector can draw for this selection: the ones whose sections it declares. */
  drawable: readonly StackKind[];
  /** The picked stack's section bodies, as the inspector's cards drew them. */
  renderStack: (kind: StackKind) => ReactNode;
}) {
  const state = useDagStore((s) => s.state);
  const stored = useStackFrameStore((s) => s.stack);
  const setStack = useStackFrameStore((s) => s.setStack);
  const peek = useStackFrameStore((s) => s.peek);
  const setPeek = useStackFrameStore((s) => s.setPeek);
  if (!view) return null;
  const peeked = peek !== null && peek.object === view.object ? peek.stack : null;
  const shown = effectiveStack(view, stored, drawable, peeked);

  function go(kind: StackKind) {
    if (!view) return;
    // A stack the object cannot take (#1960) is a look at why, not a pick to remember.
    if (view.stacks.some((s) => s.kind === kind && !s.available)) {
      setPeek({ object: view.object, stack: kind });
    } else {
      setStack(kind);
    }
    // A selected row keeps its own stack up; picking another stack goes back to the object. So does
    // a stack this selection carries no section for (a selected data node has no Modifier section).
    const otherRow = view.member !== null && view.member !== kind;
    const notHere = nodeId !== view.object && !drawable.includes(kind);
    if (otherRow || notHere) useSelectionStore.getState().select(view.object);
  }

  const flow = flowOf(view);
  const memberName = view.member !== null ? nodeDisplayName(state.nodes, nodeId) : null;

  return (
    <section
      data-testid="stack-frame"
      data-shown={shown}
      aria-label="Stacks"
      className="flex flex-col gap-1.5 border-b border-border px-3 py-2"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg/60">Stacks</span>
        {/* The stacks' rows read in apply order, first applied on top (the 2026-11-09 decision). */}
        <span data-testid="stack-frame-order-hint" className="text-[11px] text-fg-dim">
          top of the list is applied first
        </span>
      </div>
      <div
        role="tablist"
        aria-label="Stack"
        className="flex gap-0.5 self-start rounded-lg border border-border bg-bg-2 p-0.5"
      >
        {view.stacks.map((s) => (
          <button
            key={s.kind}
            type="button"
            role="tab"
            aria-selected={shown === s.kind}
            // #1960 — a stack this object cannot take: still a tab you can pick (it shows the note
            // saying why), so not aria-disabled; dimmed, and counted as not applicable, not 0.
            data-available={s.available}
            title={
              s.available
                ? undefined
                : `${nodeDisplayName(state.nodes, view.object)} cannot take ${STACK_LABELS[s.kind].toLowerCase()}`
            }
            data-testid={`stack-frame-tab-${s.kind}`}
            onClick={() => go(s.kind)}
            className={`${TAB} ${
              !s.available
                ? // Italic and dim (fg-dim, as the contrast audit requires of a control's text),
                  // even when picked: it reads as "not for this object" beside the stacks it takes.
                  `italic text-fg-dim ${shown === s.kind ? 'bg-muted' : ''}`
                : shown === s.kind
                  ? 'bg-muted text-fg'
                  : 'text-fg-dim hover:text-fg'
            }`}
          >
            {STACK_LABELS[s.kind]}{' '}
            <span data-testid={`stack-frame-count-${s.kind}`} className="tabular-nums">
              {s.available ? s.count : '–'}
            </span>
            {s.available ? null : <span className="sr-only"> (not applicable)</span>}
          </button>
        ))}
      </div>
      {flow.length > 1 ? (
        <nav aria-label="The order the stacks apply in" data-testid="stack-frame-flow">
          <ol className="flex items-center gap-1">
            {flow.map((step, i) => (
              <li key={step.kind} className="flex min-w-0 flex-1 items-center gap-1">
                {i > 0 ? (
                  <span aria-hidden="true" className="text-[11px] text-fg-dim">
                    →
                  </span>
                ) : null}
                <button
                  type="button"
                  data-testid={`stack-frame-flow-${step.kind}`}
                  data-active={step.kind === shown}
                  title={
                    step.kind === 'animLayers'
                      ? 'Open the Anim Layers tab in the bottom drawer'
                      : `Show the ${step.label} stack`
                  }
                  onClick={() =>
                    step.kind === 'animLayers' ? openDrawerTab('animLayers') : go(step.kind)
                  }
                  className={`flex min-w-0 flex-1 flex-col items-center rounded-md border px-1.5 py-1 text-[11px] leading-tight focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                    step.kind === shown
                      ? 'border-accent bg-bg-2 text-fg'
                      : 'border-border text-fg-dim hover:text-fg'
                  }`}
                >
                  <span className="truncate font-semibold text-fg">{step.label}</span>
                  <span className="tabular-nums">{step.count}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      {/* A stack the object cannot take has no rows to pick: its note says why instead. */}
      {view.stacks.some((s) => s.kind === shown && !s.available) ? null : (
        <p data-testid="stack-frame-selected" className="text-[11px] text-fg-dim">
          {memberName !== null
            ? `${memberName} · ${STACK_LABELS[shown]}: its settings follow below.`
            : 'Pick a row: its settings open below.'}
        </p>
      )}
      <div data-testid="stack-frame-body" data-stack={shown} className="-mx-3 flex flex-col">
        {renderStack(shown)}
      </div>
    </section>
  );
}
