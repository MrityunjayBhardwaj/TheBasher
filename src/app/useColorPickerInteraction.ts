import { useRef } from 'react';
import { useDagStore } from '../core/dag/store';

/**
 * Brackets a native `<input type="color">` picker drag as ONE undo entry ([[V84]],
 * [[H131]]). The OS colour picker fires the DOM `input` event (React `onChange`)
 * REPEATEDLY while the user drags inside it; without a bracket every tick commits a
 * `setParam` and so becomes its own undo + activity entry — Cmd+Z then steps back
 * tick-by-tick instead of reverting the whole pick.
 *
 * This opens a store interaction on the FIRST onChange of a picker session and
 * flushes it on blur — when focus leaves the swatch, the OS picker has closed. The
 * per-tick dispatches still mutate state (so the viewport preview follows the
 * drag), but their undo + activity records DEFER into one `AtomicGroup`. Same
 * machinery as the gizmo drag (`Gizmo.tsx` startGizmoDrag/endGizmoDrag) and the
 * Light-Studio puck drag — one correct implementation, shared so the false
 * "auto-coalesces" belief that caused [[H131]] cannot recur per-call-site.
 *
 * Usage: call `onPickStart()` inside the colour input's `onChange` (before the
 * commit) and pass `onPickEnd` to its `onBlur`. `endInteraction` self-guards on an
 * empty buffer, so a blur with no preceding pick flushes nothing.
 */
export function useColorPickerInteraction(label: string): {
  onPickStart: () => void;
  onPickEnd: () => void;
} {
  const picking = useRef(false);
  return {
    onPickStart: () => {
      if (picking.current) return;
      picking.current = true;
      useDagStore.getState().beginInteraction();
    },
    onPickEnd: () => {
      if (!picking.current) return;
      picking.current = false;
      useDagStore.getState().endInteraction(`set ${label} color`);
    },
  };
}
