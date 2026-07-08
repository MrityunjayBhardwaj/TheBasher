// NlaStripInspector — the in-dock right column editing the selected Strip
// (epic #283 Phase 5, inc 5D; UI-SPEC §1.5). Shows when
// `nlaSelectionStore.selectedStripId` resolves to a live Strip node; a stale
// id (strip deleted) degrades to hidden at this consumer. Widths from the ONE
// geometry module (H95).
//
// Fields → commits EXACTLY per the §1.5 table — every edit is ONE dispatch =
// ONE undo entry through the commitNla funnel (H70/B26: {ok:false} → toast,
// the field re-renders the unchanged store value):
//   start / timeScale / repeat / reverse  → mutator.nla.setStripTiming
//   blendMode / influence / blendIn / blendOut → mutator.nla.setStripBlend
//   muted → the ONE sanctioned raw road (commitNlaSetParam — no mutator
//           covers Strip.muted, UI-SPEC §2.5)
//   action / target → read-only labels (retarget UI deferred);
//   extrapolate → read-only "hold" (enumeration forces it in v1 — a live
//           dropdown would lie, UI-SPEC §0).
//
// Field idiom: draft-on-focus / commit-on-blur-or-Enter (the OutlinePropRow
// precedent, LayerTimeline.tsx:801-841). The `draft === null` guard is the
// commit-once lock — Enter commits then blurs, and the blur finds no draft
// (no double-fire). These number fields are ALSO the keyboard path for edge
// resize (§2.8 LOCK — no dedicated resize key binding).
//
// REF: .planning/phases/nla-5-lane-ui/UI-SPEC.md §1.5/§2.5/§2.8/§5;
//      PLAN.md inc 5D; sibling: LayerTimeline.tsx OutlinePropRow;
//      hetvabhasa H70; dharana B26; issue #283.

import { useState } from 'react';
import { useDagStore } from '../core/dag/store';
import { useNlaSelectionStore } from './nlaSelectionStore';
import { NLA_INSPECTOR_WIDTH_PX } from './nlaLaneGeometry';
import { commitNla, commitNlaSetParam } from './nlaCommit';
import type { StripParams } from '../nodes/Strip';

export function NlaStripInspector() {
  const selectedStripId = useNlaSelectionStore((s) => s.selectedStripId);
  // H48: the stable nodes ref — params read below, no derived array returned.
  const nodes = useDagStore((s) => s.state.nodes);

  if (!selectedStripId) return null;
  const node = nodes[selectedStripId];
  if (!node || node.type !== 'Strip') return null; // stale id → hidden
  const strip = node.params as StripParams;

  const actionNode = strip.action ? nodes[strip.action] : undefined;
  const actionLabel = actionNode
    ? `${(actionNode.params as { name?: string }).name ?? strip.action} (${strip.action})`
    : strip.action || '—';
  const targetLabel = strip.target || '—';

  const timing = (field: 'start' | 'timeScale' | 'repeat') => (n: number) => {
    commitNla(
      'mutator.nla.setStripTiming',
      { stripId: selectedStripId, [field]: n },
      `Edit strip ${field}`,
    );
  };
  const blendNum = (field: 'influence' | 'blendIn' | 'blendOut') => (n: number) => {
    commitNla(
      'mutator.nla.setStripBlend',
      { stripId: selectedStripId, [field]: n },
      `Edit strip ${field}`,
    );
  };

  return (
    <div
      data-testid="nla-strip-inspector"
      role="region"
      aria-label={`Strip inspector — ${strip.name}`}
      className="shrink-0 overflow-y-auto border-l border-line bg-bg-2 px-2 py-1.5 text-[11px] text-fg"
      style={{ width: NLA_INSPECTOR_WIDTH_PX }}
    >
      <div className="mb-1 truncate font-semibold" title={strip.name}>
        {strip.name}
      </div>

      <ReadOnlyRow param="action" label="Action" value={actionLabel} />
      <ReadOnlyRow param="target" label="Target" value={targetLabel} />

      <NumRow
        param="start"
        label="Start (s)"
        step={0.1}
        value={strip.start}
        commit={timing('start')}
      />
      <NumRow
        param="timeScale"
        label="Time scale"
        step={0.1}
        value={strip.timeScale}
        commit={timing('timeScale')}
      />
      <NumRow
        param="repeat"
        label="Repeat"
        step={1}
        value={strip.repeat}
        commit={timing('repeat')}
      />

      <CheckRow
        param="reverse"
        label="Reverse"
        checked={strip.reverse}
        onChange={(checked) =>
          commitNla(
            'mutator.nla.setStripTiming',
            { stripId: selectedStripId, reverse: checked },
            'Edit strip reverse',
          )
        }
      />

      <div className="flex items-center justify-between gap-1 border-b border-line py-1">
        <label className="shrink-0 text-fg-dim" htmlFor="nla-strip-field-blendMode">
          Blend
        </label>
        <select
          id="nla-strip-field-blendMode"
          data-testid="nla-strip-field-blendMode"
          value={strip.blendMode}
          onChange={(e) =>
            commitNla(
              'mutator.nla.setStripBlend',
              { stripId: selectedStripId, blendMode: e.target.value },
              'Edit strip blend mode',
            )
          }
          className="w-24 rounded border border-line bg-bg px-1 py-0.5 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <option value="replace">replace</option>
          <option value="combine">combine</option>
        </select>
      </div>

      <InfluenceRow value={strip.influence} commit={blendNum('influence')} />

      <NumRow
        param="blendIn"
        label="Blend in (s)"
        step={0.1}
        value={strip.blendIn}
        commit={blendNum('blendIn')}
      />
      <NumRow
        param="blendOut"
        label="Blend out (s)"
        step={0.1}
        value={strip.blendOut}
        commit={blendNum('blendOut')}
      />

      <CheckRow
        param="muted"
        label="Muted"
        checked={strip.muted}
        onChange={(checked) =>
          // The ONE sanctioned raw road — no mutator covers Strip.muted (§2.5).
          commitNlaSetParam(selectedStripId, 'muted', checked, 'toggle strip mute')
        }
      />

      {/* Enumeration forces 'hold' in v1 — read-only text, never a dead
          dropdown (UI-SPEC §0). */}
      <div className="flex items-center justify-between gap-1 py-1">
        <span className="text-fg-dim">Extrapolate</span>
        <span data-testid="nla-strip-field-extrapolate" className="text-fg-dim">
          hold
        </span>
      </div>
    </div>
  );
}

function ReadOnlyRow({ param, label, value }: { param: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-1 border-b border-line py-1">
      <span className="shrink-0 text-fg-dim">{label}</span>
      <span
        data-testid={`nla-strip-field-${param}`}
        className="min-w-0 truncate text-fg"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/** Number field with the OutlinePropRow draft idiom: draft-on-focus,
 *  commit-on-blur-or-Enter, `draft === null` = the commit-once guard. */
function NumRow({
  param,
  label,
  step,
  value,
  commit,
}: {
  param: string;
  label: string;
  step: number;
  value: number;
  commit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commitDraft = () => {
    if (draft === null) return;
    const n = parseFloat(draft);
    if (Number.isFinite(n) && n !== value) commit(n);
    setDraft(null);
  };
  return (
    <div className="flex items-center justify-between gap-1 border-b border-line py-1">
      <label className="shrink-0 text-fg-dim" htmlFor={`nla-strip-field-${param}`}>
        {label}
      </label>
      <input
        id={`nla-strip-field-${param}`}
        data-testid={`nla-strip-field-${param}`}
        type="number"
        step={step}
        value={draft ?? value}
        onFocus={() => setDraft(String(value))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitDraft();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-20 rounded border border-line bg-bg px-1 py-0.5 text-right text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
    </div>
  );
}

function CheckRow({
  param,
  label,
  checked,
  onChange,
}: {
  param: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-1 border-b border-line py-1">
      <label className="shrink-0 text-fg-dim" htmlFor={`nla-strip-field-${param}`}>
        {label}
      </label>
      <input
        id={`nla-strip-field-${param}`}
        data-testid={`nla-strip-field-${param}`}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
    </div>
  );
}

/** Influence: slider (preview while dragging, ONE commit at pointerup/blur)
 *  + number field sharing the same commit — §1.5 "slider + number". */
function InfluenceRow({ value, commit }: { value: number; commit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commitDraft = () => {
    if (draft === null) return;
    const n = parseFloat(draft);
    if (Number.isFinite(n) && n !== value) commit(Math.max(0, Math.min(1, n)));
    setDraft(null);
  };
  return (
    <div className="flex items-center justify-between gap-1 border-b border-line py-1">
      <label className="shrink-0 text-fg-dim" htmlFor="nla-strip-field-influence">
        Influence
      </label>
      <input
        aria-label="Influence slider"
        data-testid="nla-strip-field-influence-slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={draft !== null && Number.isFinite(parseFloat(draft)) ? parseFloat(draft) : value}
        onChange={(e) => setDraft(e.target.value)}
        onPointerUp={commitDraft}
        onBlur={commitDraft}
        className="w-16 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
      <input
        id="nla-strip-field-influence"
        data-testid="nla-strip-field-influence"
        type="number"
        min={0}
        max={1}
        step={0.05}
        value={draft ?? value}
        onFocus={() => setDraft(String(value))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitDraft();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-14 rounded border border-line bg-bg px-1 py-0.5 text-right text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
    </div>
  );
}
