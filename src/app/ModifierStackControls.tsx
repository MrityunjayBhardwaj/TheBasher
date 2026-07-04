// ModifierStackControls — the inspector UI for the geometry OperatorStack (epic
// #201, #209, V58). The Blender modifier-stack panel: for the selected mesh (the
// base, or any modifier in its chain) it lists the stack bottom→top, with per-row
// mute / reorder / delete, and an "+ Add Modifier" button. Every action is an
// atomic Op chain from operatorStack.ts (dispatchAtomic → save/undo/animate free).
//
// It renders for both a selected mesh-producer (Box/Sphere — the base) AND a
// selected modifier (resolveStackBase walks down to the base), so the same stack
// shows whichever the user picked. Clicking a row selects that modifier so its
// params (count/offset) edit in the same section's ParamRows below.
//
// REF: src/app/operatorStack.ts; src/nodes/ArrayModifier.ts;
//      src/app/NPanel.tsx (renders this in the 'modifier' section); vyapti V58.

import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';
import {
  buildAddModifierOps,
  buildMoveModifierOps,
  buildRemoveModifierOps,
  buildToggleModifierMuteOp,
  enumerateModifierStack,
  resolveStackBase,
} from './operatorStack';

/** The modifiers the user can add from the "+ Add" menu. New modifiers join here
 *  + MODIFIER_NODE_TYPES + the agent ModifierType enum + registerAll. */
const ADDABLE: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'ArrayModifier', label: 'Array' },
  { type: 'MirrorModifier', label: 'Mirror' },
];

export function ModifierStackControls({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const selectedNodeId = useSelectionStore((s) => s.selectedNodeId);
  const select = useSelectionStore((s) => s.select);

  const base = resolveStackBase(state, nodeId);
  const stack = enumerateModifierStack(state, base);

  // #256 (V38) — a geometry modifier only rewrites a PRIMITIVE leaf mesh
  // (`sourceGeometryRef` handles box/sphere/baked); on a glTF / Group / other
  // source it passes THROUGH unchanged (async geometry is a documented v1
  // follow-up). Silently doing nothing reads as "the modifier is broken" on an
  // imported asset. Surface the limitation so the no-op is EXPECTED, not a bug.
  const SUPPORTED_BASE_TYPES = new Set(['BoxMesh', 'SphereMesh', 'BakedMesh']);
  const baseType = state.nodes[base]?.type;
  const unsupportedSource =
    stack.length > 0 && baseType != null && !SUPPORTED_BASE_TYPES.has(baseType);

  function onAdd(type: string) {
    const res = buildAddModifierOps(useDagStore.getState().state, base, type);
    if (res) useDagStore.getState().dispatchAtomic(res.ops, 'user', 'add modifier');
  }
  function onMute(id: string) {
    const op = buildToggleModifierMuteOp(useDagStore.getState().state, id);
    if (op) useDagStore.getState().dispatchAtomic([op], 'user', 'toggle modifier mute');
  }
  function onMove(id: string, dir: 'up' | 'down') {
    const ops = buildMoveModifierOps(useDagStore.getState().state, id, dir);
    if (ops) useDagStore.getState().dispatchAtomic(ops, 'user', 'reorder modifier');
  }
  function onRemove(id: string) {
    const ops = buildRemoveModifierOps(useDagStore.getState().state, id);
    if (ops) {
      useDagStore.getState().dispatchAtomic(ops, 'user', 'remove modifier');
      if (selectedNodeId === id) select(base); // don't strand the selection on a deleted node
    }
  }

  const btn =
    'rounded border border-line px-1.5 py-0.5 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg';

  return (
    <div data-testid="modifier-stack" className="flex flex-col gap-1 text-xs">
      {unsupportedSource ? (
        <p
          data-testid="modifier-unsupported-source"
          className="rounded border border-border-strong bg-warn/10 px-1.5 py-1 text-warn"
        >
          ⚠ Modifiers only reshape primitive meshes (Box, Sphere). This{' '}
          {baseType === 'GltfAsset' ? 'imported' : baseType} source passes through unchanged.
        </p>
      ) : null}
      {stack.length === 0 ? (
        <p className="px-1 py-0.5 text-fg/60">No modifiers.</p>
      ) : (
        stack.map((m, i) => {
          const active = m.nodeId === selectedNodeId;
          return (
            <div
              key={m.nodeId}
              data-testid={`modifier-row-${m.nodeId}`}
              className={`flex items-center gap-1 rounded border px-1 py-0.5 ${
                active ? 'border-accent bg-bg-2' : 'border-line'
              }`}
            >
              <button
                type="button"
                onClick={() => select(m.nodeId)}
                className={`flex-1 truncate text-left ${m.muted ? 'text-fg/60 line-through' : 'text-fg'}`}
                title={m.label}
              >
                {m.label}
              </button>
              <button
                type="button"
                data-testid={`modifier-mute-${m.nodeId}`}
                aria-pressed={m.muted}
                onClick={() => onMute(m.nodeId)}
                className={btn}
                title={m.muted ? 'Un-mute modifier' : 'Mute modifier (bypass)'}
              >
                {m.muted ? '◌' : '●'}
              </button>
              <button
                type="button"
                data-testid={`modifier-up-${m.nodeId}`}
                onClick={() => onMove(m.nodeId, 'up')}
                disabled={i === stack.length - 1}
                className={btn}
                title="Move up (later in the stack)"
              >
                ▲
              </button>
              <button
                type="button"
                data-testid={`modifier-down-${m.nodeId}`}
                onClick={() => onMove(m.nodeId, 'down')}
                disabled={i === 0}
                className={btn}
                title="Move down (earlier in the stack)"
              >
                ▼
              </button>
              <button
                type="button"
                data-testid={`modifier-remove-${m.nodeId}`}
                onClick={() => onRemove(m.nodeId)}
                className={btn}
                title="Remove modifier"
              >
                ✕
              </button>
            </div>
          );
        })
      )}
      <div className="flex items-center gap-1 pt-0.5">
        {ADDABLE.map((a) => (
          <button
            key={a.type}
            type="button"
            data-testid={`modifier-add-${a.type}`}
            onClick={() => onAdd(a.type)}
            className="rounded border border-line bg-bg-2 px-2 py-0.5 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            + {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
