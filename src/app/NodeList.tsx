// Director-mode left rail. Lists nodes by id; click to select. The library/
// scene-tree projection (THESIS.md §12, §14) lands in P1; this is the
// minimum surface that exercises selection in P0.

import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';

export function NodeList() {
  const nodes = useDagStore((s) => s.state.nodes);
  const selected = useSelectionStore((s) => s.selectedNodeId);
  const select = useSelectionStore((s) => s.select);
  const ids = Object.keys(nodes).sort();

  return (
    <aside
      data-testid="node-list"
      className="flex flex-col overflow-y-auto border-r border-border bg-muted/40 text-xs"
    >
      <header className="border-b border-border px-3 py-2 font-mono uppercase tracking-wide text-fg/70">
        nodes
      </header>
      <ul className="flex flex-col">
        {ids.map((id) => {
          const node = nodes[id];
          const isSel = selected === id;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => select(id)}
                data-testid={`node-list-item-${id}`}
                data-selected={isSel || undefined}
                className={`flex w-full items-baseline justify-between gap-2 border-b border-border/60 px-3 py-1.5 text-left font-mono ${
                  isSel ? 'bg-accent/15 text-accent' : 'text-fg/80 hover:bg-muted'
                }`}
              >
                <span>{id}</span>
                <span className="text-[10px] text-fg/40">{node.type}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
