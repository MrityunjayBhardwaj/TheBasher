// Director-mode right rail — minimal P0 inspector.
// Edits a single number param via setParam Op (V1 — no setState shortcut).
// Acceptance #5: edits flow to the viewport within 16ms because the dispatch
// is synchronous and zustand subscribers re-render before the next frame.
//
// REF: THESIS.md §15, krama K2.

import { useDagStore } from '../core/dag/store';
import type { NodeRef } from '../core/dag/types';
import { useSelectionStore } from './stores/selectionStore';

interface NumericFieldProps {
  nodeId: string;
  paramPath: string;
  label: string;
  value: number;
}

function NumericField({ nodeId, paramPath, label, value }: NumericFieldProps) {
  const dispatch = useDagStore((s) => s.dispatch);
  return (
    <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="font-mono text-fg/60">{label}</span>
      <input
        type="number"
        step="0.1"
        // Controlled — `value` reflects external state (undo/redo, agent ops,
        // load). Uncontrolled `defaultValue` would silently desync the moment
        // the param changes outside this input (e.g. Cmd+Z).
        value={value}
        data-testid={`inspector-input-${nodeId}-${paramPath}`}
        className="w-24 rounded border border-border bg-muted px-2 py-0.5 text-right font-mono text-xs text-fg focus:border-accent focus:outline-none"
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isNaN(next)) return;
          dispatch({ type: 'setParam', nodeId, paramPath, value: next });
        }}
      />
    </label>
  );
}

function VectorField({
  nodeId,
  paramPath,
  label,
  value,
}: {
  nodeId: string;
  paramPath: string;
  label: string;
  value: readonly number[];
}) {
  const dispatch = useDagStore((s) => s.dispatch);
  const dims = ['x', 'y', 'z'];
  return (
    <div className="flex flex-col gap-1 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="font-mono text-fg/60">{label}</span>
      <div className="flex gap-1">
        {value.slice(0, 3).map((v, i) => (
          <input
            key={dims[i]}
            type="number"
            step="0.1"
            // Controlled — see NumericField for the why.
            value={v}
            data-testid={`inspector-vec-${nodeId}-${paramPath}-${dims[i]}`}
            className="w-full rounded border border-border bg-muted px-1.5 py-0.5 text-right font-mono text-[11px] text-fg focus:border-accent focus:outline-none"
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              if (Number.isNaN(next)) return;
              const newVec = [...value] as number[];
              newVec[i] = next;
              dispatch({ type: 'setParam', nodeId, paramPath, value: newVec });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

function isInputBinding(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<NodeRef>;
  return typeof o.node === 'string' && typeof o.socket === 'string';
}

export function Inspector() {
  const selectedId = useSelectionStore((s) => s.selectedNodeId);
  const node = useDagStore((s) => (selectedId ? s.state.nodes[selectedId] : null));

  return (
    <aside
      data-testid="inspector"
      className="flex flex-col overflow-y-auto border-l border-border bg-muted/40 text-xs"
    >
      <header className="border-b border-border px-3 py-2 font-mono uppercase tracking-wide text-fg/70">
        inspector
      </header>
      {!node ? (
        <div className="p-4 text-fg/40">select a node</div>
      ) : (
        <>
          <div className="border-b border-border px-3 py-2 text-fg/60">
            <div className="font-mono text-fg">{node.id}</div>
            <div className="text-[10px] text-fg/40">
              {node.type} v{node.version}
            </div>
          </div>
          <div className="flex flex-col py-1">
            {Object.entries((node.params ?? {}) as Record<string, unknown>).map(([key, value]) => {
              const path = key;
              if (typeof value === 'number') {
                return (
                  <NumericField
                    key={path}
                    nodeId={node.id}
                    paramPath={path}
                    label={key}
                    value={value}
                  />
                );
              }
              if (isVec3(value)) {
                return (
                  <VectorField
                    key={path}
                    nodeId={node.id}
                    paramPath={path}
                    label={key}
                    value={value}
                  />
                );
              }
              if (typeof value === 'string') {
                return (
                  <div
                    key={path}
                    className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px]"
                  >
                    <span className="font-mono text-fg/60">{key}</span>
                    <span className="font-mono text-fg/80">{value}</span>
                  </div>
                );
              }
              if (isInputBinding(value)) return null;
              return (
                <div key={path} className="px-3 py-1.5 text-[11px] text-fg/40">
                  {key}: <span className="text-fg/30">(complex — Pro mode)</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}
