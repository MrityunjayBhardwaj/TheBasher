// #224 — the inline rename editor, shared by the outliner row and the
// inspector header. The TRIGGER (double-click / F2) is surface-specific; the
// COMMIT SEMANTICS are identical everywhere, so they live here once:
//
//   • seeds from the raw `meta.name` (empty for an unnamed node, whose id is
//     shown as the placeholder — committing empty leaves it unnamed rather
//     than baking the id in as a name),
//   • Enter / blur commits, Escape cancels,
//   • a no-op edit (same name) dispatches nothing, so undo isn't polluted,
//   • the single `setMeta` op is the only DAG mutation (V1).
//
// Enter/Escape stopPropagation so they don't reach the global KeyboardShortcuts
// window listener (Escape there clears the selection; Enter is harmless but we
// keep both contained). A committedRef guards the Enter→blur double-fire.

import { useEffect, useRef, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import type { NodeId } from '../core/dag/types';
import { useRenameStore } from './stores/renameStore';

interface RenameInputProps {
  readonly nodeId: NodeId;
  /** The node's current `meta.name` (undefined when unnamed). */
  readonly priorName: string | undefined;
  /** Shown when the field is empty — the fallback label (the node id). */
  readonly placeholder: string;
  readonly className?: string;
  readonly testId?: string;
}

export function RenameInput({
  nodeId,
  priorName,
  placeholder,
  className,
  testId,
}: RenameInputProps) {
  const dispatch = useDagStore((s) => s.dispatch);
  const cancel = useRenameStore((s) => s.cancel);
  const [value, setValue] = useState(priorName ?? '');
  const ref = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  function finish(save: boolean) {
    if (committedRef.current) return; // guard Enter-then-blur double fire
    committedRef.current = true;
    if (save) {
      const trimmed = value.trim();
      const next = trimmed === '' ? undefined : trimmed;
      if (next !== priorName) {
        dispatch({ type: 'setMeta', nodeId, name: next }, 'user', `rename ${nodeId}`);
      }
    }
    cancel();
  }

  return (
    <input
      ref={ref}
      data-testid={testId}
      type="text"
      value={value}
      placeholder={placeholder}
      aria-label={`Rename ${placeholder}`}
      className={className}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      // The editor lives inside a selectable row / header — keep clicks from
      // bubbling to the row's select / drill handlers while editing.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
