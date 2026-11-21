// #1705 — the three context chips, as words. ONE place answers what each chip says, so the chip
// the director sees and the line the model receives can never disagree.
//
//   What  — the selection, by name ("Box", "Box + 2 more", "nothing selected").
//   Where — the pane last worked in, and what it shows ("Curves · Box position").
//   When  — the playhead and the shot under it ("Shot 2 · 3.40 s").
//   Also  — what the director added with @ ("Shot 2 (4.00–7.50 s)").
//
// REF: src/app/stores/agentContextStore.ts; src/agent/orchestrator.ts (buildContextBlock).

import type { DagState } from '../../core/dag';
import type { NodeId } from '../../core/dag/types';
import type { TurnContext } from '../../agent/orchestrator';
import { useDagStore } from '../../core/dag/store';
import { buildSceneTreeRows, nodeDisplayName } from '../sceneTreeWalk';
import { sceneEndSeconds } from '../sceneRange';
import { shotsOf, type Shot } from '../shots';
import { useSelectionStore } from '../stores/selectionStore';
import { useTimeStore } from '../stores/timeStore';
import {
  PANE_LABELS,
  paneLabel,
  useAgentContextStore,
  type ContextRef,
  type PaneKind,
} from '../stores/agentContextStore';

/** The selection by name: one name, or the first and how many more. */
export function whatLabel(state: DagState, selected: ReadonlySet<NodeId>): string {
  const ids = [...selected].filter((id) => state.nodes[id]);
  if (ids.length === 0) return 'nothing selected';
  const first = nodeDisplayName(state.nodes, ids[0]);
  return ids.length === 1 ? first : `${first} + ${ids.length - 1} more`;
}

/** The film's shots, for `whenLabel` (derive once per scene, not once per playhead frame). */
export function filmShots(state: DagState): readonly Shot[] {
  return shotsOf(state, sceneEndSeconds(state)).shots;
}

/** The playhead, and its shot when the scene has a camera to film one. */
export function whenLabel(shots: readonly Shot[], filmSeconds: number): string {
  const time = `${filmSeconds.toFixed(2)} s`;
  const shot = shots.find((s) => filmSeconds >= s.start && filmSeconds < s.end) ?? null;
  return shot && shot.cameraId ? `Shot ${shot.index + 1} · ${time}` : time;
}

/** What @ offers: the outliner's objects by name, every pane, and the film's shots. */
export function pickerOptions(
  state: DagState,
  shots: readonly Shot[],
): { objects: ContextRef[]; panes: ContextRef[]; shots: ContextRef[] } {
  const seen = new Set<NodeId>();
  const objects: ContextRef[] = [];
  for (const row of buildSceneTreeRows(state)) {
    if (seen.has(row.nodeId)) continue;
    seen.add(row.nodeId);
    const sent = row.display === row.nodeId ? row.nodeId : `${row.display} (${row.nodeId})`;
    objects.push({ kind: 'object', id: row.nodeId, label: row.display, sent });
  }
  const panes = (Object.keys(PANE_LABELS) as PaneKind[]).map(
    (kind): ContextRef => ({
      kind: 'pane',
      id: kind,
      label: PANE_LABELS[kind],
      sent: `the ${PANE_LABELS[kind]} pane`,
    }),
  );
  const shotRefs = shots.map((s): ContextRef => {
    const label = `Shot ${s.index + 1}`;
    return {
      kind: 'shot',
      id: String(s.index),
      label,
      sent: `${label} (${s.start.toFixed(2)}–${s.end.toFixed(2)} s)`,
    };
  });
  return { objects, panes, shots: shotRefs };
}

/** What the next turn sends: the selection to act on and the chips that were not dismissed. */
export function currentTurnContext(): {
  selectedNodeIds: ReadonlySet<NodeId>;
  context: TurnContext;
} {
  const state = useDagStore.getState().state;
  const { lastPane, subjects, dismissed } = useAgentContextStore.getState();
  const context: TurnContext = {};
  const pane = paneLabel(lastPane, subjects);
  if (pane && !dismissed.where) context.pane = pane;
  if (!dismissed.when)
    context.playhead = whenLabel(filmShots(state), useTimeStore.getState().filmSeconds);
  if (dismissed.what) context.omitSelection = true;
  const { extras } = useAgentContextStore.getState();
  if (extras.length > 0) context.also = extras.map((r) => r.sent);
  return {
    // A dismissed selection is not acted on either: "this" no longer means it.
    selectedNodeIds: dismissed.what ? new Set() : useSelectionStore.getState().selectedNodeIds,
    context,
  };
}
