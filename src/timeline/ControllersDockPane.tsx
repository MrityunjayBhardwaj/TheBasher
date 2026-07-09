// ControllersDockPane — the scene-wide Controllers dock (#294, Epic 1 Inc 3, D-3).
// A cockpit tab in the TimelineDrawer aggregating EVERY promoted spare param across
// all nodes (F2 — a Controller is any node with a promoted spare, not a privileged
// type). Each row edits the spare value through the SAME setSpareParam op the
// inspector authoring surface uses (V34 — two pure views over one node.spare source).
//
// Once a target param is bound to a promoted spare via the Inc-2 pull rail, dragging
// a dock knob drives the target live (Inc 3 sub-step 3). Until then the dock is a
// convenient aggregated editor for the scene's controller knobs.
//
// REF: src/app/controllersDock.ts (the pure aggregator); src/app/SpareParamControls.tsx
//      (SpareValueField — the shared editor + the inspector twin); D-3; issue #294.

import { useStoreWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/shallow';
import { useDagStore } from '../core/dag/store';
import { collectPromotedControls, type PromotedControl } from '../app/controllersDock';
import { SpareValueField } from '../app/SpareParamControls';
import { useSelectionStore } from '../app/stores/selectionStore';
import type { SpareParam } from '../core/dag/types';

export function ControllersDockPane() {
  // Recompute the promoted-control list whenever the node table changes. `shallow`
  // over the flattened rows keeps this from re-rendering on unrelated deep edits that
  // don't touch a promoted spare (the rows are fresh objects each pass, so shallow
  // compares field-by-field on the array — cheap for a handful of knobs).
  const controls = useStoreWithEqualityFn(
    useDagStore,
    (s) => collectPromotedControls(s.state.nodes),
    shallow,
  );

  return (
    <div
      data-testid="controllers-dock-pane"
      className="no-scrollbar flex h-full w-full flex-col overflow-y-auto p-2 text-xs"
    >
      {controls.length === 0 ? (
        <div data-testid="controllers-dock-empty" className="flex flex-col gap-1 p-3 text-fg-dim">
          <span>No controllers yet.</span>
          <span>
            Select a node, add a spare param in the Inspector&rsquo;s{' '}
            <span className="text-fg">Controls</span> section, and press{' '}
            <span className="text-fg">★</span> to promote it here.
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {controls.map((c) => (
            <ControllerRow key={`${c.nodeId}:${c.key}`} control={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ControllerRow({ control }: { control: PromotedControl }) {
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  const select = useSelectionStore((s) => s.select);
  const { nodeId, nodeName, key, param } = control;

  const onChange = (next: SpareParam) => {
    dispatchAtomic(
      [{ type: 'setSpareParam', nodeId, key, param: next }],
      'user',
      `edit control ${key}`,
    );
  };

  return (
    <div
      data-testid={`controller-row-${nodeId}-${key}`}
      className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/40"
    >
      <button
        type="button"
        onClick={() => select(nodeId)}
        title={`Select ${nodeName}`}
        data-testid={`controller-select-${nodeId}-${key}`}
        className="w-28 shrink-0 truncate text-left font-mono text-[10px] text-fg/50 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {nodeName}
      </button>
      <span className="w-24 shrink-0 truncate font-mono text-[11px] text-fg/80" title={key}>
        {key}
      </span>
      <div className="min-w-0 flex-1">
        <SpareValueField
          param={param}
          onChange={onChange}
          testId={`controller-value-${nodeId}-${key}`}
        />
      </div>
    </div>
  );
}
