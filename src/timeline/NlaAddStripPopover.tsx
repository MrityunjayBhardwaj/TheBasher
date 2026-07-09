// NlaAddStripPopover — the director's add-strip flow (epic #283 Phase 5,
// inc 5D; UI-SPEC §2.6). Picks an Action + a target + a start + a track
// ("New track" omits trackId → `addStrip` auto-creates one, addStrip.ts:43-44)
// and commits ONE `mutator.nla.addStrip` through the commitNla funnel — one
// dispatch = one undo entry covering strip + (possibly) track + append.
//
// H103 hard-avoid: the 240px drawer + the pane's overflow-auto rows CLIP any
// in-pane absolute overlay (in the DOM, "visible" to count()/toBeVisible(),
// yet not hit-testable) — so this popover PORTALS to document.body and opens
// UPWARD from the anchor button's rect (the drawer sits at the viewport
// bottom). The e2e probes document.elementFromPoint at the commit button.
//
// {ok:false} discipline (B26/H70): the funnel already toasts the reason; the
// popover ADDITIONALLY shows it inline and STAYS OPEN for correction (both
// surfaces — RESEARCH open-q 3). The DAG is byte-unchanged on rejection.
//
// Target list: scene-tree rows (the outliner projection) MINUS cameras —
// camera strips are the documented Phase-3+ KNOWN-LIMIT (Strip.ts:13-16); the
// UI must not offer the dead road. Default target = the global 3D selection
// (READ only — the NLA pane never WRITES useSelectionStore, UI-SPEC §1.5).
//
// Focus: trapped inside the dialog (Tab cycles), Esc closes, focus returns to
// the anchor on unmount (UI-SPEC §5).
//
// REF: .planning/phases/nla-5-lane-ui/UI-SPEC.md §2.6/§5/§6.2; PLAN.md inc 5D;
//      hetvabhasa H103/H70; dharana B26; sibling: SimplifyPopover.tsx;
//      src/agent/mutators/builders/addStrip.ts; issue #283.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDagStore } from '../core/dag/store';
import { useTimeStore } from '../app/stores/timeStore';
import { useSelectionStore } from '../app/stores/selectionStore';
import { buildSceneTreeRows } from '../app/sceneTreeWalk';
import type { DagState } from '../core/dag/state';
import { commitNla } from './nlaCommit';

/** Camera node types — excluded from the target list (camera strips are the
 *  documented Phase-3+ KNOWN-LIMIT, Strip.ts:13-16; not a silent no-op, so
 *  the UI simply must not offer them). */
const CAMERA_NODE_TYPES = new Set(['PerspectiveCamera', 'OrthographicCamera']);

/** Valid add-strip targets: the outliner's scene rows (depth > 0 — the Scene
 *  container itself is not a strip target) minus every camera row (by TYPE
 *  and by the camera band socket, so a camera nested in a Group is excluded
 *  too). Pure — unit/e2e assert the exclusion. */
export function stripTargetRows(state: DagState): { id: string; label: string }[] {
  return buildSceneTreeRows(state)
    .filter(
      (r) => r.depth > 0 && r.parent?.socket !== 'camera' && !CAMERA_NODE_TYPES.has(r.nodeType),
    )
    .map((r) => ({ id: r.nodeId, label: r.display }));
}

const POPOVER_WIDTH_PX = 256; // w-64

export function NlaAddStripPopover({
  anchor,
  defaultTrackId,
  onClose,
}: {
  /** The [+ Strip] button that opened the popover — position source + focus
   *  return target. */
  anchor: HTMLElement;
  /** The clicked track (pre-selects it), or null → "New track". */
  defaultTrackId: string | null;
  onClose: () => void;
}) {
  const state = useDagStore((s) => s.state);

  const actions = useMemo(
    () =>
      Object.values(state.nodes)
        .filter((n) => n.type === 'Action')
        .map((n) => ({ id: n.id, name: (n.params as { name?: string }).name ?? n.id })),
    [state],
  );
  const targets = useMemo(() => stripTargetRows(state), [state]);
  const tracks = useMemo(
    () =>
      Object.values(state.nodes)
        .filter((n) => n.type === 'Track')
        .map((n) => ({ id: n.id, name: (n.params as { name?: string }).name ?? n.id })),
    [state],
  );

  // Drafts (committed in ONE dispatch). Defaults per §2.6: first Action; the
  // global 3D selection when it is a valid (non-camera) target; the playhead
  // seconds; the clicked track or "New track" (empty = omit trackId).
  const [action, setAction] = useState<string>(() => {
    const first = Object.values(useDagStore.getState().state.nodes).find(
      (n) => n.type === 'Action',
    );
    return first?.id ?? '';
  });
  const [target, setTarget] = useState<string>(() => {
    const rows = stripTargetRows(useDagStore.getState().state);
    const primary = useSelectionStore.getState().primaryNodeId;
    if (primary && rows.some((r) => r.id === primary)) return primary;
    return rows[0]?.id ?? '';
  });
  const [start, setStart] = useState<string>(() =>
    String(Math.round(useTimeStore.getState().seconds * 1000) / 1000),
  );
  const [trackId, setTrackId] = useState<string>(defaultTrackId ?? '');
  const [error, setError] = useState<string | null>(null);

  // Position: FIXED, opening UPWARD from the anchor (the drawer sits at the
  // viewport bottom — H103). Re-measured on resize/scroll (#288 N8) so the
  // dialog stays pinned to its anchor if the viewport reflows while open.
  const measurePos = useCallback(() => {
    const r = anchor.getBoundingClientRect();
    return {
      left: Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH_PX - 8)),
      bottom: window.innerHeight - r.top + 4,
    };
  }, [anchor]);
  const [pos, setPos] = useState(measurePos);
  useEffect(() => {
    const reposition = () => setPos(measurePos());
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true); // capture: catch nested scrolls
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [measurePos]);

  const rootRef = useRef<HTMLDivElement | null>(null);

  // Initial focus → first field; focus RETURNS to the anchor on unmount
  // (Esc, commit-close, click-outside — one seam covers all three, §5).
  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLElement>('select, input, button');
    first?.focus();
    return () => anchor.focus();
  }, [anchor]);

  // Esc closes (capture — the pane's own Esc-clears-selection must not also
  // fire); click-outside dismisses (the SimplifyPopover/AddMenu pattern).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  // Focus trap: Tab cycles within the dialog (§5). Tab is handled ENTIRELY
  // here — observed (tmp probe, live :5180): the app's global Tab shortcut
  // (editor-space cycle, KeyboardShortcuts.tsx:571-578) preventDefaults any
  // Tab whose target is not a typing field, so a native Tab from a BUTTON in
  // this dialog would cycle the editor space instead of moving focus.
  // preventDefault + stopPropagation + a manual next/prev keeps the trap
  // deterministic AND shields the global shortcut while the dialog is modal.
  const onTrapKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    const els = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(
        'select, input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (els.length === 0) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const dir = e.shiftKey ? -1 : 1;
    els[(i + dir + els.length) % els.length].focus();
  };

  const startNum = Number(start);
  const commitDisabled = action === '' || target === '';

  function commit() {
    if (commitDisabled) return;
    if (!Number.isFinite(startNum)) {
      setError('Start must be a number (seconds).');
      return;
    }
    // ONE dispatch through the funnel; "New track" omits trackId → addStrip
    // auto-creates (addStrip.ts:43-44). On {ok:false} the funnel toasts, the
    // popover stays open with the reason inline, and the DAG is unchanged.
    const res = commitNla(
      'mutator.nla.addStrip',
      { action, target, start: startNum, ...(trackId !== '' ? { trackId } : {}) },
      'Add strip',
    );
    if (res.ok) {
      onClose();
    } else {
      setError(res.reason);
    }
  }

  const fieldCls =
    'w-full rounded border border-border bg-bg px-1.5 py-0.5 text-fg ' +
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
  const labelCls = 'mb-0.5 mt-1.5 block text-fg-dim';

  return createPortal(
    <div
      ref={rootRef}
      data-testid="nla-add-strip-popover"
      role="dialog"
      aria-modal="true"
      aria-label="Add strip"
      onKeyDown={onTrapKeyDown}
      className="fixed z-50 rounded border border-border bg-bg-2 p-3 text-[11px] text-fg shadow-lg"
      style={{ left: pos.left, bottom: pos.bottom, width: POPOVER_WIDTH_PX }}
    >
      <div className="font-semibold">Add strip</div>

      <label className={labelCls} htmlFor="nla-add-strip-action">
        Action
      </label>
      <select
        id="nla-add-strip-action"
        data-testid="nla-add-strip-action"
        value={action}
        onChange={(e) => setAction(e.target.value)}
        className={fieldCls}
      >
        {actions.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.id})
          </option>
        ))}
      </select>

      <label className={labelCls} htmlFor="nla-add-strip-target">
        Target
      </label>
      <select
        id="nla-add-strip-target"
        data-testid="nla-add-strip-target"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className={fieldCls}
      >
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>

      <label className={labelCls} htmlFor="nla-add-strip-start">
        Start (s)
      </label>
      <input
        id="nla-add-strip-start"
        data-testid="nla-add-strip-start"
        type="number"
        step={0.1}
        value={start}
        onChange={(e) => setStart(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        className={fieldCls}
      />

      <label className={labelCls} htmlFor="nla-add-strip-track">
        Track
      </label>
      <select
        id="nla-add-strip-track"
        data-testid="nla-add-strip-track"
        value={trackId}
        onChange={(e) => setTrackId(e.target.value)}
        className={fieldCls}
      >
        <option value="">New track</option>
        {tracks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.id})
          </option>
        ))}
      </select>

      {error !== null && (
        <div data-testid="nla-add-strip-error" role="alert" className="mt-2 text-error">
          {error}
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          data-testid="nla-add-strip-cancel"
          onClick={onClose}
          className="rounded border border-border px-2 py-1 text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="nla-add-strip-commit"
          disabled={commitDisabled}
          onClick={commit}
          className="rounded bg-accent px-2 py-1 text-bg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add strip
        </button>
      </div>
    </div>,
    document.body,
  );
}
