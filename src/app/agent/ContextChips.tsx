// #1705 — the chips above the composer: What (the selection), Where (the pane last worked in) and
// When (the playhead and its shot). They are filled in from live state, and say what the next
// message will tell the agent; ✕ leaves one out of that message only. Design board 10
// ("ChatColumn"): plain chips with a ✕, no headings, and "@ add" at the end of the row: a picker of
// objects, panes and shots, each added as one more chip for the next message.
//
// REF: src/app/agent/turnContext.ts (the words, shared with what is sent);
//      src/app/stores/agentContextStore.ts (Where + dismissals).

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useDagStore } from '../../core/dag/store';
import { useSelectionStore } from '../stores/selectionStore';
import { useTimeStore } from '../stores/timeStore';
import {
  paneLabel,
  useAgentContextStore,
  type ChipKind,
  type ContextRef,
} from '../stores/agentContextStore';
import { filmShots, pickerOptions, whatLabel, whenLabel } from './turnContext';

const TITLES: Record<ChipKind, string> = {
  what: 'What: the selection the agent acts on',
  where: 'Where: the pane you last worked in',
  when: 'When: the playhead and its shot',
};

const CHIP_CLASS =
  'inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-fg/85';
const X_CLASS =
  'shrink-0 rounded px-0.5 leading-none text-fg/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

function Chip({ kind, text }: { kind: ChipKind; text: string }): ReactNode {
  const dismiss = useAgentContextStore((s) => s.dismiss);
  return (
    <span data-testid={`context-chip-${kind}`} title={TITLES[kind]} className={CHIP_CLASS}>
      <span className="truncate">{text}</span>
      <button
        type="button"
        data-testid={`context-chip-${kind}-dismiss`}
        aria-label={`Leave ${kind} out of the next message`}
        title="Leave out of the next message"
        onClick={() => dismiss(kind)}
        className={X_CLASS}
      >
        ×
      </button>
    </span>
  );
}

function ExtraChip({ item: r }: { item: ContextRef }): ReactNode {
  const remove = useAgentContextStore((s) => s.removeExtra);
  return (
    <span data-testid="context-chip-extra" title={`Added: ${r.sent}`} className={CHIP_CLASS}>
      <span className="truncate">{r.label}</span>
      <button
        type="button"
        data-testid="context-chip-extra-dismiss"
        aria-label={`Remove ${r.label}`}
        title="Remove"
        onClick={() => remove(r)}
        className={X_CLASS}
      >
        ×
      </button>
    </span>
  );
}

/** The @ picker: objects, panes and shots, one button each. */
function Picker({
  shots,
  onPick,
  onClose,
}: {
  shots: ReturnType<typeof filmShots>;
  onPick: (ref: ContextRef) => void;
  onClose: () => void;
}): ReactNode {
  const state = useDagStore((s) => s.state);
  const options = useMemo(() => pickerOptions(state, shots), [state, shots]);
  const box = useRef<HTMLDivElement>(null);
  // A press anywhere else closes it, as a menu does.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (box.current?.contains(t) || t?.closest?.('[data-testid="context-add"]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  const group = (title: string, refs: ContextRef[]) =>
    refs.length === 0 ? null : (
      <div className="py-0.5">
        <div className="px-2 pb-0.5 pt-1 text-[9px] uppercase tracking-wide text-fg/40">
          {title}
        </div>
        {refs.map((r) => (
          <button
            key={`${r.kind}-${r.id}`}
            type="button"
            data-testid={`context-pick-${r.kind}-${r.id}`}
            onClick={() => onPick(r)}
            className="block w-full truncate px-2 py-0.5 text-left text-[11px] text-fg/85 hover:bg-bg-1 hover:text-fg focus-visible:bg-bg-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          >
            {r.label}
          </button>
        ))}
      </div>
    );
  return (
    <div
      ref={box}
      role="menu"
      aria-label="Add to the message"
      data-testid="context-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
      className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-56 overflow-auto rounded border border-border bg-bg-2 py-0.5 shadow-xl shadow-black/40"
    >
      {group('Objects', options.objects)}
      {group('Panes', options.panes)}
      {group('Shots', options.shots)}
    </div>
  );
}

export interface ContextChipsProps {
  /** Whether the @ picker is open (the composer opens it too, on a typed @). */
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  /** A ref was picked: the composer adds it (and takes out a typed @). */
  onPick: (ref: ContextRef) => void;
}

export function ContextChips({ pickerOpen, setPickerOpen, onPick }: ContextChipsProps): ReactNode {
  const state = useDagStore((s) => s.state);
  const selected = useSelectionStore((s) => s.selectedNodeIds);
  const filmSeconds = useTimeStore((s) => s.filmSeconds);
  const lastPane = useAgentContextStore((s) => s.lastPane);
  const subjects = useAgentContextStore((s) => s.subjects);
  const dismissed = useAgentContextStore((s) => s.dismissed);
  const extras = useAgentContextStore((s) => s.extras);
  const closePicker = useCallback(() => setPickerOpen(false), [setPickerOpen]);
  const where = paneLabel(lastPane, subjects);
  // The chip re-renders every playback frame; the shots change only with the scene.
  const shots = useMemo(() => filmShots(state), [state]);

  return (
    <div data-testid="context-chips" className="relative mb-1.5 flex flex-wrap items-center gap-1">
      {dismissed.what ? null : <Chip kind="what" text={whatLabel(state, selected)} />}
      {dismissed.where || !where ? null : <Chip kind="where" text={where} />}
      {dismissed.when ? null : <Chip kind="when" text={whenLabel(shots, filmSeconds)} />}
      {extras.map((r) => (
        <ExtraChip key={`${r.kind}-${r.id}`} item={r} />
      ))}
      <button
        type="button"
        data-testid="context-add"
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        title="Add an object, pane or shot to the message"
        onClick={() => setPickerOpen(!pickerOpen)}
        className="rounded px-1 py-0.5 text-[11px] text-fg/50 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        @ add
      </button>
      {pickerOpen ? <Picker shots={shots} onPick={onPick} onClose={closePicker} /> : null}
    </div>
  );
}
