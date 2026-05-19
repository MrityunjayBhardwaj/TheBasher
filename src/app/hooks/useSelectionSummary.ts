import { useEffect, useMemo, useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import { useSelectionStore } from '../stores/selectionStore';

// P6 W10 UIR F-4 — promoted from Viewport.tsx's inline implementation.
// The Hickey check it carried ("not promoted to a shared hook until a
// second use-site appears") is now satisfied: §8.3 requires the R6
// region (<main> in Layout.tsx) aria-label to be the selection-debounced
// summary too, so both Viewport's aria-live span AND the <main> label
// derive from one source. A divergent second copy would let the two
// announce different things — the exact silent drift this consolidation
// prevents.
// #58 F8 — React 18 Strict Mode (dev only) mounts effects twice: the
// effect runs, its cleanup runs, then it runs again. Here that means
// the first setTimeout is cleared before it fires and a fresh one is
// scheduled — net behavior is identical (one trailing-edge update),
// just non-obvious on first read. No bug; documented per F8.
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * The screen-reader's only handle on 3D selection state (§8.3).
 * Returns the selection summary debounced 200ms so rapid marquee
 * selects don't spam announcements / thrash the R6 region name.
 */
export function useSelectionSummary(): string {
  const primaryNodeId = useSelectionStore((s) => s.primaryNodeId);
  const selectedCount = useSelectionStore((s) => s.selectedNodeIds.size);
  const primaryNode = useDagStore((s) =>
    primaryNodeId ? (s.state.nodes[primaryNodeId] ?? null) : null,
  );
  const rawSummary = useMemo(() => {
    if (selectedCount === 0) return 'no selection';
    if (selectedCount === 1 && primaryNode) {
      const name = primaryNode.meta?.name ?? primaryNode.id;
      return `${primaryNode.type} "${name}"`;
    }
    return `${selectedCount} nodes selected`;
  }, [selectedCount, primaryNode]);
  return useDebouncedValue(rawSummary, 200);
}
