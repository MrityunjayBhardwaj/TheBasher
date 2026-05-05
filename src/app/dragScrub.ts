// dragScrub — pure math + lifecycle for Blender-style numeric drag-scrub.
//
// Behavior (NEXT_SESSION.md decision default):
//   - User clicks the label (NOT the input) and drags horizontally.
//   - Live preview is local — no setParam Op fires per pixel; that would
//     spray hundreds of undo entries per drag.
//   - On pointer-up (release): commit ONE setParam Op via the caller. One
//     drag = one undo entry.
//
// Sensitivity (per pixel of horizontal travel):
//   - default     = 0.01
//   - shift held  = 0.001  (fine)
//   - cmd/ctrl    = 0.1    (coarse)
//
// Pure helper `computeScrubDelta` is unit-tested. The React hook
// `useDragScrub` is a thin wrapper that owns the pointer event lifecycle.
//
// REF: THESIS.md §15, vyapti V1 (one Cmd+Z = one user action).

import { useEffect, useRef, useState } from 'react';

export interface ScrubModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export const SCRUB_DEFAULT_PER_PIXEL = 0.01;
export const SCRUB_FINE_PER_PIXEL = 0.001;
export const SCRUB_COARSE_PER_PIXEL = 0.1;

/** Returns the world-units-per-pixel sensitivity for the given modifiers. */
export function scrubSensitivity(mods: ScrubModifiers): number {
  if (mods.shiftKey) return SCRUB_FINE_PER_PIXEL;
  if (mods.metaKey || mods.ctrlKey) return SCRUB_COARSE_PER_PIXEL;
  return SCRUB_DEFAULT_PER_PIXEL;
}

/** Compute the scrubbed value given a starting value and a horizontal pixel
 *  delta. Returns a fresh number; callers preview live, then commit on
 *  release. */
export function computeScrubDelta(
  startValue: number,
  pixelDeltaX: number,
  mods: ScrubModifiers,
): number {
  return startValue + pixelDeltaX * scrubSensitivity(mods);
}

interface UseDragScrubOptions {
  /** Current authoritative value (from store / props). */
  value: number;
  /** Called on release with the final value. ONE Op per drag. */
  onCommit: (next: number) => void;
}

interface UseDragScrubResult {
  /** True while the user is dragging — the consumer can read `previewValue`
   *  for the live displayed number. */
  isDragging: boolean;
  /** The value to display while dragging; falls back to `options.value` when
   *  not dragging. */
  previewValue: number;
  /** Bind to the LABEL element (NOT the input). */
  onPointerDown: (e: React.PointerEvent) => void;
}

export function useDragScrub({ value, onCommit }: UseDragScrubOptions): UseDragScrubResult {
  const [isDragging, setDragging] = useState(false);
  const [previewValue, setPreview] = useState(value);
  // Refs so the global pointermove/up handlers see the live state without
  // re-binding listeners every render.
  const stateRef = useRef({ startX: 0, startValue: 0, latest: value, moved: false });

  // Keep the preview in sync with external value when not dragging.
  useEffect(() => {
    if (!isDragging) setPreview(value);
  }, [value, isDragging]);

  function onPointerDown(e: React.PointerEvent) {
    // Only respond to primary button. Ignore right/middle clicks so they can
    // fall through to context menus / pan.
    if (e.button !== 0) return;
    e.preventDefault();
    stateRef.current.startX = e.clientX;
    stateRef.current.startValue = value;
    stateRef.current.latest = value;
    stateRef.current.moved = false;
    setDragging(true);
    setPreview(value);

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - stateRef.current.startX;
      if (Math.abs(dx) > 1) stateRef.current.moved = true;
      const next = computeScrubDelta(stateRef.current.startValue, dx, {
        shiftKey: moveEvent.shiftKey,
        metaKey: moveEvent.metaKey,
        ctrlKey: moveEvent.ctrlKey,
      });
      stateRef.current.latest = next;
      setPreview(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDragging(false);
      // Only commit if the user actually moved. A bare click on the label
      // shouldn't dispatch — that would create an undo entry for nothing.
      if (stateRef.current.moved && stateRef.current.latest !== stateRef.current.startValue) {
        onCommit(stateRef.current.latest);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  return {
    isDragging,
    previewValue: isDragging ? previewValue : value,
    onPointerDown,
  };
}
