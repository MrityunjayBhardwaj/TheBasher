// #1705 — the chips above the composer: What (the selection), Where (the pane last worked in) and
// When (the playhead and its shot). They are filled in from live state, and say what the next
// message will tell the agent; ✕ leaves one out of that message only. Design board 10
// ("ChatColumn"): plain chips with a ✕, no headings.
//
// REF: src/app/agent/turnContext.ts (the words, shared with what is sent);
//      src/app/stores/agentContextStore.ts (Where + dismissals).

import { useMemo, type ReactNode } from 'react';
import { useDagStore } from '../../core/dag/store';
import { useSelectionStore } from '../stores/selectionStore';
import { useTimeStore } from '../stores/timeStore';
import { paneLabel, useAgentContextStore, type ChipKind } from '../stores/agentContextStore';
import { filmShots, whatLabel, whenLabel } from './turnContext';

const TITLES: Record<ChipKind, string> = {
  what: 'What: the selection the agent acts on',
  where: 'Where: the pane you last worked in',
  when: 'When: the playhead and its shot',
};

function Chip({ kind, text }: { kind: ChipKind; text: string }): ReactNode {
  const dismiss = useAgentContextStore((s) => s.dismiss);
  return (
    <span
      data-testid={`context-chip-${kind}`}
      title={TITLES[kind]}
      className="inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-fg/85"
    >
      <span className="truncate">{text}</span>
      <button
        type="button"
        data-testid={`context-chip-${kind}-dismiss`}
        aria-label={`Leave ${kind} out of the next message`}
        title="Leave out of the next message"
        onClick={() => dismiss(kind)}
        className="shrink-0 rounded px-0.5 leading-none text-fg/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ×
      </button>
    </span>
  );
}

export function ContextChips(): ReactNode {
  const state = useDagStore((s) => s.state);
  const selected = useSelectionStore((s) => s.selectedNodeIds);
  const filmSeconds = useTimeStore((s) => s.filmSeconds);
  const lastPane = useAgentContextStore((s) => s.lastPane);
  const subjects = useAgentContextStore((s) => s.subjects);
  const dismissed = useAgentContextStore((s) => s.dismissed);
  const where = paneLabel(lastPane, subjects);
  // The chip re-renders every playback frame; the shots change only with the scene.
  const shots = useMemo(() => filmShots(state), [state]);

  return (
    <div data-testid="context-chips" className="mb-1.5 flex flex-wrap items-center gap-1">
      {dismissed.what ? null : <Chip kind="what" text={whatLabel(state, selected)} />}
      {dismissed.where || !where ? null : <Chip kind="where" text={where} />}
      {dismissed.when ? null : <Chip kind="when" text={whenLabel(shots, filmSeconds)} />}
    </div>
  );
}
