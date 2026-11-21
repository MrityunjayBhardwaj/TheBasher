// #1705 — the three context chips, as words. ONE place answers what each chip says, so the chip
// the director sees and the line the model receives can never disagree.
//
//   What  — the selection, by name ("Box", "Box + 2 more", "nothing selected").
//   Where — the pane last worked in, and what it shows ("Curves · Box position").
//   When  — the playhead and the shot under it ("Shot 2 · 3.40 s").
//
// REF: src/app/stores/agentContextStore.ts; src/agent/orchestrator.ts (buildContextBlock).

import type { DagState } from '../../core/dag';
import type { NodeId } from '../../core/dag/types';
import type { TurnContext } from '../../agent/orchestrator';
import { useDagStore } from '../../core/dag/store';
import { nodeDisplayName } from '../sceneTreeWalk';
import { sceneEndSeconds } from '../sceneRange';
import { shotsOf } from '../shots';
import { useSelectionStore } from '../stores/selectionStore';
import { useTimeStore } from '../stores/timeStore';
import { paneLabel, useAgentContextStore } from '../stores/agentContextStore';

/** The selection by name: one name, or the first and how many more. */
export function whatLabel(state: DagState, selected: ReadonlySet<NodeId>): string {
  const ids = [...selected].filter((id) => state.nodes[id]);
  if (ids.length === 0) return 'nothing selected';
  const first = nodeDisplayName(state.nodes, ids[0]);
  return ids.length === 1 ? first : `${first} + ${ids.length - 1} more`;
}

/** The playhead, and its shot when the scene has a camera to film one. */
export function whenLabel(state: DagState, filmSeconds: number): string {
  const time = `${filmSeconds.toFixed(2)} s`;
  const shots = shotsOf(state, sceneEndSeconds(state)).shots;
  const shot = shots.find((s) => filmSeconds >= s.start && filmSeconds < s.end) ?? null;
  return shot && shot.cameraId ? `Shot ${shot.index + 1} · ${time}` : time;
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
  if (!dismissed.when) context.playhead = whenLabel(state, useTimeStore.getState().filmSeconds);
  if (dismissed.what) context.omitSelection = true;
  return {
    // A dismissed selection is not acted on either: "this" no longer means it.
    selectedNodeIds: dismissed.what ? new Set() : useSelectionStore.getState().selectedNodeIds,
    context,
  };
}
