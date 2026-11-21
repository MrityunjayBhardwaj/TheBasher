// StackFrame — the frame around the inspector's stacks (#1957, design board 14d): a Modifiers ·
// Constraints · Materials switch with counts, and a flow strip in the order the stacks apply
// (Anim layers → Constraints → Modifiers) that takes you to each one.
//
// CHROME ONLY. The stacks stay drawn by the panels that already draw them, where they already
// mount (the inspector's Modifier, Constraint, Constraint Stack and Material cards), so a row
// looks and edits exactly as before and nothing is drawn twice. The switch shows one stack at a
// time by opening that stack's cards and folding the others' (the cards' own remembered open
// state), then brings the first into view. Anim layers opens the drawer's Anim Layers tab.
//
// Picking a row selects it, as the panels always have; the frame stays up for a selected row,
// keeps its stack on, and says that the row's settings are the sections that follow it.
//
// No stack presets exist yet, so there is no presets bar (one with nothing to offer would be a
// dead control). The blend/influence bar and the per-row tools belong to the shared stack panel.
//
// REF: issue #1957; design board 14d; src/app/stackFrameModel.ts.

import { useMemo } from 'react';
import { getNodeType } from '../core/dag/registry';
import { useDagStore } from '../core/dag/store';
import type { SectionId } from './inspectorSections';
import { openDrawerTab } from './openDrawerTab';
import { resolveStackBase } from './operatorStack';
import { nodeDisplayName } from './sceneTreeWalk';
import { useInspectorSectionsStore } from './stores/inspectorSectionsStore';
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

/** The inspector cards each stack is drawn in, and whose node declares them. */
const CARDS: Record<StackKind, { readonly on: 'object' | 'data'; readonly id: SectionId }[]> = {
  modifiers: [{ on: 'object', id: 'modifier' }],
  constraints: [
    { on: 'object', id: 'constraint' },
    { on: 'object', id: 'stack' },
  ],
  materials: [{ on: 'data', id: 'material' }],
};

const TAB =
  'rounded-md px-2 py-0.5 text-[12px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

/** Open `kind`'s cards and fold the other stacks' cards, on the node types that declare them. */
export function showStackCards(view: StackFrameView, kind: StackKind): void {
  const state = useDagStore.getState().state;
  const objectType = state.nodes[view.object]?.type;
  const dataId = resolveStackBase(state, view.object);
  const dataType = dataId !== view.object ? state.nodes[dataId]?.type : undefined;
  const { setCollapsed } = useInspectorSectionsStore.getState();
  for (const stack of view.stacks) {
    for (const card of CARDS[stack.kind]) {
      const type = card.on === 'object' ? objectType : dataType;
      if (!type || !getNodeType(type)?.inspectorSections?.includes(card.id)) continue;
      setCollapsed(type, card.id, stack.kind !== kind);
    }
  }
}

export function StackFrame({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const view = useMemo(() => stackFrameOf(state, nodeId, dataKindOf), [state, nodeId]);
  const stored = useStackFrameStore((s) => s.stack);
  const setStack = useStackFrameStore((s) => s.setStack);
  if (!view) return null;
  const shown = effectiveStack(view, stored);

  function go(kind: StackKind) {
    if (!view) return;
    setStack(kind);
    // A selected row keeps its own stack up; picking another stack goes back to the object.
    if (view.member !== null && view.member !== kind) {
      useSelectionStore.getState().select(view.object);
    }
    showStackCards(view, kind);
    requestAnimationFrame(() => {
      const first = CARDS[kind][0].id;
      document
        .querySelector(`[data-testid="inspector-section-${first}"]`)
        ?.scrollIntoView?.({ block: 'nearest' });
    });
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
            data-testid={`stack-frame-tab-${s.kind}`}
            onClick={() => go(s.kind)}
            className={`${TAB} ${shown === s.kind ? 'bg-muted text-fg' : 'text-fg-dim hover:text-fg'}`}
          >
            {STACK_LABELS[s.kind]}{' '}
            <span data-testid={`stack-frame-count-${s.kind}`} className="tabular-nums">
              {s.count}
            </span>
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
      <p data-testid="stack-frame-selected" className="text-[11px] text-fg-dim">
        {memberName !== null
          ? `${memberName} · ${STACK_LABELS[shown]}: its settings follow below.`
          : 'Pick a row: its settings open below.'}
      </p>
    </section>
  );
}
