// goToProposal — clicking a proposal line in chat takes you to where the change lands (#1706).
//
// The line's target says which editor (the inspector, or a bottom-drawer tab) and which node. This
// opens that editor and selects the node. It only moves the director's view — space, drawer, tab,
// selection — and never touches the scene: no op is dispatched here (V1).
//
// A node the proposal ADDS is not in the scene yet, so it cannot be selected; its editor still
// opens (Nodes previews the proposal, the new node outlined).
//
// REF: src/agent/diff/proposalLines.ts (`ProposalTarget`); src/app/ProposalCard.tsx.

import type { ProposalLine } from '../agent/diff/proposalLines';
import { objectOf } from '../agent/diff/proposalLines';
import { useDagStore } from '../core/dag/store';
import { useTimelineSelection } from '../timeline/timelineSelection';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore } from './stores/editorStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTimelineDockStore } from './stores/timelineDockStore';
import { useViewportStore } from './stores/viewportStore';

export function goToProposalLine(line: ProposalLine, opts: { isNarrow: boolean }): void {
  const { editor, nodeId } = line.target;
  const state = useDagStore.getState().state;
  const exists = nodeId !== null && Boolean(state.nodes[nodeId]);
  const editorStore = useEditorStore.getState();

  if (editor === 'inspector' || editor === 'viewport') {
    // The viewport draws Objects: a data half's change is shown — and selected — on its Object.
    if (editorStore.space !== 'view3d') editorStore.setSpace('view3d');
    if (exists) useSelectionStore.getState().select(objectOf(state, nodeId));
    // Desktop: bring the inspector back if it is folded. (The narrow layout's inspector is an
    // overlay drawer that would cover the chat this click came from, so it is left closed there.)
    const chrome = useChromeStore.getState();
    if (!opts.isNarrow && chrome.inspectorCollapsed) chrome.setInspectorCollapsed(false);
    return;
  }

  // A bottom-drawer editor. The drawer is hidden in the Video space, so leave it for 3D.
  if (editorStore.space === 'video') editorStore.setSpace('view3d');
  useViewportStore.getState().setTimelineDrawerOpen(true);
  useTimelineDockStore.getState().setActiveTab(editor);
  if (!exists) return;
  useSelectionStore.getState().select(nodeId);
  if (editor === 'curve' || editor === 'dopesheet')
    useTimelineSelection.getState().setActiveChannel(nodeId);
}
