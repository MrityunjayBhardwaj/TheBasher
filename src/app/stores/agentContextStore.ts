// #1705 — what the composer's context chips say: the pane the director last worked in (Where), and
// which chips they dismissed for the next message. What (the selection) and When (the playhead)
// are read live from their own stores; only Where has no other home, so it lives here.
//
// "Last worked in" = the last pane that took a pointer press, a key or focus (`usePaneFocus`). The
// chat column is deliberately not a pane: typing a request must not overwrite where you were.
//
// A pane may publish a SUBJECT — what it is showing, e.g. the curve in the curve editor or the
// network the node view is inside — so Where can read "Curves · Box position" rather than just
// "Curves". Subjects are kept per pane and read live, so the chip follows the pane's content.
//
// Extras are what the director adds with @ (an object, a pane, a shot); like a dismissal they last
// one message.
//
// REF: src/app/agent/ContextChips.tsx (the chips); src/app/agent/turnContext.ts (what a turn sends).

import { useMemo } from 'react';
import { create } from 'zustand';

export type PaneKind =
  | 'viewport'
  | 'uv'
  | 'sheet'
  | 'video'
  | 'shots'
  | 'dopesheet'
  | 'nla'
  | 'curves'
  | 'nodes'
  | 'library'
  | 'controllers'
  | 'inspector'
  | 'lights';

/** The name each pane goes by in the editor's own chrome (tabs, the space switch). */
export const PANE_LABELS: Record<PaneKind, string> = {
  viewport: 'Viewport',
  uv: '2D',
  sheet: 'Spreadsheet',
  video: 'Video',
  shots: 'Shots',
  dopesheet: 'Dopesheet',
  nla: 'NLA',
  curves: 'Curves',
  nodes: 'Nodes',
  library: 'Library',
  controllers: 'Controllers',
  inspector: 'Inspector',
  lights: 'Lights',
};

export type ChipKind = 'what' | 'where' | 'when';

/** #1705 — an object, pane or shot the director added with @, beyond the three automatic chips. */
export interface ContextRef {
  readonly kind: 'object' | 'pane' | 'shot';
  /** The node id, pane kind or shot index — with `kind`, what makes two refs the same. */
  readonly id: string;
  /** What the chip shows, e.g. "n_camera", "Nodes", "Shot 2". */
  readonly label: string;
  /** What the model is told, e.g. "Shot 2 (4.00–7.50 s)". */
  readonly sent: string;
}

const NONE_DISMISSED: Record<ChipKind, boolean> = { what: false, where: false, when: false };

export interface AgentContextStore {
  /** The pane last pressed, typed or focused in; null until there is one. */
  lastPane: PaneKind | null;
  /** What each pane says it is showing, when it says. */
  subjects: Partial<Record<PaneKind, string>>;
  /** Chips the director removed for the next message. */
  dismissed: Record<ChipKind, boolean>;
  /** Refs added with @ for the next message. */
  extras: readonly ContextRef[];
  markPane(kind: PaneKind): void;
  setSubject(kind: PaneKind, subject: string | undefined): void;
  dismiss(chip: ChipKind): void;
  addExtra(ref: ContextRef): void;
  removeExtra(ref: ContextRef): void;
  /** After a message is sent every chip is back and the added refs are gone: both are for one
   *  message. */
  resetAfterSend(): void;
}

export const useAgentContextStore = create<AgentContextStore>((set, get) => ({
  lastPane: null,
  subjects: {},
  dismissed: NONE_DISMISSED,
  extras: [],
  markPane(kind) {
    // Every key press in a pane lands here; only a change of pane is a change of state.
    if (get().lastPane !== kind) set({ lastPane: kind });
  },
  setSubject(kind, subject) {
    if (get().subjects[kind] === subject) return;
    set((s) => ({ subjects: { ...s.subjects, [kind]: subject } }));
  },
  dismiss(chip) {
    set((s) => ({ dismissed: { ...s.dismissed, [chip]: true } }));
  },
  addExtra(ref) {
    if (get().extras.some((r) => r.kind === ref.kind && r.id === ref.id)) return;
    set((s) => ({ extras: [...s.extras, ref] }));
  },
  removeExtra(ref) {
    set((s) => ({ extras: s.extras.filter((r) => !(r.kind === ref.kind && r.id === ref.id)) }));
  },
  resetAfterSend() {
    set({ dismissed: NONE_DISMISSED, extras: [] });
  },
}));

/** "Curves · Box position" — the pane's name, and its subject when it has one. */
export function paneLabel(
  lastPane: PaneKind | null,
  subjects: Partial<Record<PaneKind, string>>,
): string | null {
  if (!lastPane) return null;
  const subject = subjects[lastPane];
  if (!subject) return PANE_LABELS[lastPane];
  // The node view's subject is a path into networks, read as one ("Nodes › Hull").
  return `${PANE_LABELS[lastPane]}${lastPane === 'nodes' ? ' › ' : ' · '}${subject}`;
}

/**
 * Mark a pane as where the director is working. Spread the result onto the pane's root element:
 * capture-phase handlers, so a press or key anywhere inside counts even when a child stops it.
 */
export function usePaneFocus(kind: PaneKind): {
  onPointerDownCapture: () => void;
  onKeyDownCapture: () => void;
  onFocusCapture: () => void;
} {
  return useMemo(() => {
    const mark = () => useAgentContextStore.getState().markPane(kind);
    return { onPointerDownCapture: mark, onKeyDownCapture: mark, onFocusCapture: mark };
  }, [kind]);
}
