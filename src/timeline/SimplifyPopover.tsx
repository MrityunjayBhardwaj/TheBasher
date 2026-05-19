// SimplifyPopover — tolerance input anchored to the bottom-toolbar
// Simplify button (P6 W6 — D-W6-4 interactive).
//
// Renders an absolutely-positioned card above the anchor button when
// `open` is true. Numeric input pre-populated with `defaultTolerance`
// (0.01). Apply dispatches mutator.timeline.simplifyChannel against
// timelineSelection.activeChannelId. Cancel and Esc and click-outside
// all dismiss without applying. The pattern mirrors AddMenu's
// click-outside dismissal (codebase has no global modal infra in v0.5).
//
// V1 honored — the apply path goes through validatePlan +
// dispatchAtomic, so the same five-gate validation as agent calls runs
// on this UI surface. No bypass paths.

import { useEffect, useRef, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import { simplifyChannelMutator, validatePlan } from '../agent/mutators';
import { useTimelineSelection } from './timelineSelection';

const DEFAULT_TOLERANCE = 0.01;
const MIN_TOLERANCE = 0.0001;
const MAX_TOLERANCE = 1;

export function SimplifyPopover({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [raw, setRaw] = useState<string>(String(DEFAULT_TOLERANCE));
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state every time the popover opens — stale errors from the
  // previous open would survive otherwise.
  useEffect(() => {
    if (open) {
      setRaw(String(DEFAULT_TOLERANCE));
      setError(null);
      // Focus the input on the next tick so the user can immediately type.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Click-outside + Esc dismissal (AddMenu pattern).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  function apply() {
    const tolerance = Number(raw);
    if (!Number.isFinite(tolerance) || tolerance < MIN_TOLERANCE || tolerance > MAX_TOLERANCE) {
      setError(`Tolerance must be in [${MIN_TOLERANCE}, ${MAX_TOLERANCE}].`);
      return;
    }
    const channelId = useTimelineSelection.getState().activeChannelId;
    if (!channelId) {
      setError('No active channel — select a channel row in the dopesheet first.');
      return;
    }
    const state = useDagStore.getState().state;
    const plan = validatePlan(
      simplifyChannelMutator,
      { channelId, tolerance },
      state,
      'simplify channel',
    );
    if (!plan.ok) {
      setError(plan.reason);
      return;
    }
    if (plan.ops.length === 0) {
      // No-op (already simplified) — close silently.
      onClose();
      return;
    }
    useDagStore.getState().dispatchAtomic(plan.ops, 'user', 'simplify channel');
    onClose();
  }

  return (
    <div
      ref={rootRef}
      data-testid="simplify-popover"
      role="dialog"
      aria-label="Simplify channel — tolerance"
      className="absolute bottom-full right-0 z-50 mb-1 w-64 rounded border border-line bg-bg-2 p-3 text-xs text-fg shadow-lg"
    >
      <div className="mb-2 font-semibold">Simplify channel</div>
      <label className="mb-2 block text-mute" htmlFor="simplify-popover-input">
        Tolerance ε ({MIN_TOLERANCE}–{MAX_TOLERANCE})
      </label>
      <input
        ref={inputRef}
        id="simplify-popover-input"
        data-testid="simplify-popover-input"
        type="number"
        step={0.001}
        min={MIN_TOLERANCE}
        max={MAX_TOLERANCE}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          }
        }}
        className="w-full rounded border border-line bg-bg px-2 py-1 text-fg"
      />
      {error !== null && (
        <div data-testid="simplify-popover-error" className="mt-2 text-warn">
          {error}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          data-testid="simplify-popover-cancel"
          onClick={onClose}
          className="rounded border border-line px-2 py-1 text-mute hover:bg-line"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="simplify-popover-apply"
          onClick={apply}
          className="rounded bg-accent px-2 py-1 text-bg hover:bg-accent-dim"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
