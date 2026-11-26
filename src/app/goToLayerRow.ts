// goToLayerRow — a click on a "What changes this" row opens the editor that row is edited in (#1940).
//
// The surface (`ObjectLayerSurfacePanel`) is a pure read: it hands its host a `LayerRowPick` and
// performs nothing. This is that host. Editing stays in each lane's existing control (the hybrid
// the user chose: a merged read, per-lane edit), so a pick only moves the view: which node is
// selected, which stack the inspector's frame shows, and which bottom-drawer tab is open. Like
// `goToProposal`, it never touches the scene: no op is dispatched here.
//
// Where each lane is edited:
//   - modifier / constraint: the row's node is selected, and the frame shows its stack. A selected
//     row keeps its stack up in the frame, with that row's settings under the list (#1959).
//   - driver: the driver node is selected; its inspector draws the Drivers stack it stands in.
//   - a MATERIAL param (any lane whose paramPath is a material path, #1928's one canonical
//     predicate): the object is selected and the frame shows Materials. Material-ness comes from
//     the path, never from a lane, so the surface's closed lane union stays as it is.
//   - channel: the Curves tab, on that channel, as a proposal line on a channel goes.
//   - strip: the NLA tab, with the object selected (a synthetic strip has no node of its own).
//   - pose: the Anim Layers tab, with the object selected (the tab reads the selected character).
//
// `layerRowRoute` is the pure decision and `goToLayerRow` applies it, so the routing is tested
// without the stores.
//
// REF: issue #1940 (T2: per-row route handles); src/app/ObjectLayerSurfacePanel.tsx (the pick);
//      src/app/goToProposal.ts (the same view-only routing for a chat proposal line).

import { useDagStore } from '../core/dag/store';
import { useTimelineSelection } from '../timeline/timelineSelection';
import { isImportedChildMaterialPath } from './importedChild';
import type { LayerRowPick } from './ObjectLayerSurfacePanel';
import { openDrawerTab } from './openDrawerTab';
import type { StackKind } from './stackFrameModel';
import { useEditorStore } from './stores/editorStore';
import { useSelectionStore } from './stores/selectionStore';
import { useStackFrameStore } from './stores/stackFrameStore';
import type { TimelineTab } from './stores/timelineDockStore';

/** Where a pick takes the view. Every field is a view move; none is an edit. */
export interface LayerRowRoute {
  /** The node to select, or null to leave the selection as it is. */
  readonly select: string | null;
  /** The stack the inspector's frame shows, or null to leave it. */
  readonly stack: StackKind | null;
  /** The bottom-drawer tab to open, or null to leave the drawer. */
  readonly drawer: TimelineTab | null;
  /** The channel the Curves tab focuses, or null. */
  readonly activeChannel: string | null;
}

const route = (r: Partial<LayerRowRoute>): LayerRowRoute => ({
  select: null,
  stack: null,
  drawer: null,
  activeChannel: null,
  ...r,
});

/** Where a pick on a "What changes this" row takes the view. Pure. */
export function layerRowRoute(pick: LayerRowPick): LayerRowRoute {
  const own = pick.rowNodeId ?? pick.objectId;
  // A material param is edited in the Materials stack, whichever lane animates it.
  if (pick.paramPath !== null && isImportedChildMaterialPath(pick.paramPath)) {
    return route({ select: pick.objectId, stack: 'materials' });
  }
  switch (pick.lane) {
    case 'modifier':
      return route({ select: own, stack: 'modifiers' });
    case 'constraint':
      return route({ select: own, stack: 'constraints' });
    case 'driver':
      return route({ select: own });
    case 'channel':
      return route({ select: own, drawer: 'curve', activeChannel: pick.rowNodeId });
    case 'strip':
      return route({ select: pick.objectId, drawer: 'nla' });
    case 'pose':
      return route({ select: pick.objectId, drawer: 'animLayers' });
  }
}

/** Apply a pick's route: select, show the stack, open the drawer tab. Never dispatches an op. */
export function goToLayerRow(pick: LayerRowPick): void {
  const r = layerRowRoute(pick);
  const exists = (id: string) => Boolean(useDagStore.getState().state.nodes[id]);
  if (r.stack !== null) useStackFrameStore.getState().setStack(r.stack);
  if (r.drawer !== null) {
    // The drawer is hidden in the Video space, so a drawer route leaves it for 3D.
    const editor = useEditorStore.getState();
    if (editor.space === 'video') editor.setSpace('view3d');
    openDrawerTab(r.drawer);
  }
  if (r.select !== null && exists(r.select)) useSelectionStore.getState().select(r.select);
  if (r.activeChannel !== null && exists(r.activeChannel)) {
    useTimelineSelection.getState().setActiveChannel(r.activeChannel);
  }
}
