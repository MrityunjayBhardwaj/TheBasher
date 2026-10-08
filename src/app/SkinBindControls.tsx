// SkinBindControls — binding a mesh to an armature from the modifier section (#1353).
//
// Three small things, each a view of `src/app/animate/bindSkin.ts`:
//   - on a mesh that is not bound: "bind to armature", which adds Capture and the Armature
//     modifier and connects both (the agent's `mutator.rig.bindSkin`, the same plan);
//   - on a Capture or an Armature modifier: which armature it points at, changeable — an operator
//     added on its own from "+ Add" has no armature until one is picked here;
//   - on a Capture: what it did, or why it did nothing, in a sentence. A mesh that does not move
//     looks the same whether nothing was captured or no bone was turned, so the reason is printed.
//
// REF: src/app/animate/bindSkin.ts; src/nodes/CaptureModifier.ts (`planCapture`); issue #1353.

import { useState } from 'react';
import { useDagStore } from '../core/dag/store';
import {
  ARMATURE_INPUT_TYPES,
  armatureObjectsIn,
  armatureOf,
  captureIsWhole,
  captureStatusOf,
  captureStatusText,
  planBindSkin,
  setArmatureOps,
} from './animate/bindSkin';
import { enumerateModifierStack } from './operatorStack';
import { uiEvaluatorCache } from './uiEvaluatorCache';

const selectClass =
  'w-full rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-fg';

export function SkinBindControls({ nodeId, base }: { nodeId: string; base: string }) {
  const state = useDagStore((s) => s.state);
  // Keyed by the mesh it was said about, so a refusal does not follow the selection elsewhere.
  const [refusal, setRefusal] = useState<{ base: string; reason: string } | null>(null);
  const node = state.nodes[nodeId];
  if (!node) return null;
  const armatures = armatureObjectsIn(state);
  const nameOf = (id: string) => state.nodes[id]?.meta?.name ?? id;

  if (ARMATURE_INPUT_TYPES.includes(node.type)) {
    const current = armatureOf(state, nodeId);
    const status = captureStatusOf(state, nodeId, uiEvaluatorCache);
    return (
      <div className="flex flex-col gap-1 text-[11px] text-fg/80">
        <label className="flex items-center gap-1">
          <span className="w-14 shrink-0 font-mono text-[10px] text-fg/50">armature</span>
          <select
            aria-label="armature"
            data-testid="skin-armature"
            className={selectClass}
            value={current ?? ''}
            onChange={(e) => {
              const ops = setArmatureOps(
                useDagStore.getState().state,
                nodeId,
                e.target.value === '' ? null : e.target.value,
              );
              if (ops.length > 0) {
                useDagStore.getState().dispatchAtomic(ops, 'user', 'set armature');
              }
            }}
          >
            <option value="">none</option>
            {armatures.map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        </label>
        {status ? (
          <p
            data-testid="capture-status"
            data-captured={captureIsWhole(status)}
            className={
              captureIsWhole(status)
                ? 'text-fg-dim'
                : 'rounded border border-border-strong bg-warn/10 px-1.5 py-1 text-warn'
            }
          >
            {captureStatusText(status)}
          </p>
        ) : null}
      </div>
    );
  }

  // The mesh itself (or an operator that takes no armature): offer the bind while it has none.
  const bound = enumerateModifierStack(state, base).some((entry) =>
    ARMATURE_INPUT_TYPES.includes(entry.type),
  );
  if (bound || armatures.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-[11px] text-fg/80">
      <label className="flex items-center gap-1">
        <span className="w-14 shrink-0 font-mono text-[10px] text-fg/50">bind to</span>
        <select
          aria-label="bind to armature"
          data-testid="skin-bind"
          className={selectClass}
          value=""
          onChange={(e) => {
            if (e.target.value === '') return;
            const plan = planBindSkin(
              useDagStore.getState().state,
              { mesh: base, armature: e.target.value },
              uiEvaluatorCache,
            );
            if (!plan.ok) {
              setRefusal({ base, reason: plan.reason });
              return;
            }
            setRefusal(null);
            useDagStore.getState().dispatchAtomic(plan.ops, 'user', 'bind to armature');
          }}
        >
          <option value="">armature…</option>
          {armatures.map((id) => (
            <option key={id} value={id}>
              {nameOf(id)}
            </option>
          ))}
        </select>
      </label>
      {refusal && refusal.base === base ? (
        <p
          data-testid="skin-bind-refusal"
          className="rounded border border-border-strong bg-warn/10 px-1.5 py-1 text-warn"
        >
          Not bound: {refusal.reason}
        </p>
      ) : null}
    </div>
  );
}
