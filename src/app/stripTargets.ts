// stripTargets — what an NLA Strip may be placed on, and which Actions it may place (#1065).
//
// ONE list for every surface that offers a strip's target or action: the NLA add-strip
// popover and the Strip inspector's pickers read the same functions, so the panel and the
// popover cannot disagree about what a strip may drive (#1065 asked for exactly that).
//
// REF: src/app/stripDrive.ts (the refusal the target list applies);
//      src/timeline/NlaAddStripPopover.tsx (the popover); src/nodes/Strip.ts (the pickers);
//      src/timeline/nlaLaneModel.ts (the lane reads an `action` only when it is an `Action`).

import type { DagState } from '../core/dag/state';
import type { ParamOption } from '../nodes/paramWidget';
import { buildSceneTreeRows } from './sceneTreeWalk';
import { stripDriveRefusal } from './stripDrive';

/** Valid add-strip targets: the outliner's scene rows (depth > 0 — the Scene
 *  container itself is not a strip target) minus every row a strip could not
 *  actually drive. That exclusion is `stripDriveRefusal` — the SAME expression
 *  the push-down offer and accept consume (#479), so this picker and push-down
 *  cannot disagree about which targets are reachable (the agent road is
 *  deliberately still ungated — see Strip.ts); plus the camera band socket,
 *  which excludes a camera row structurally. Pure — unit/e2e assert the
 *  exclusion. Cameras become valid targets when #480 lands.
 *
 *  #387 — the refusal's camera test is POSSESSION-keyed (`isCameraNode`), so this
 *  picker inherits the split form transitively rather than spelling a type list.
 *  That matters for exactly one shape: a TOP-LEVEL camera is already excluded by
 *  the band socket, but a camera NESTED IN A GROUP carries the Group's socket
 *  instead, and post-split its `nodeType` is 'Object' — a type test fails open on
 *  it and offers a strip that folds nothing. Asserted on a GROUPED camera. */
export function stripTargetRows(state: DagState): { id: string; label: string }[] {
  return buildSceneTreeRows(state)
    .filter(
      (r) =>
        r.depth > 0 && r.parent?.socket !== 'camera' && stripDriveRefusal(state, r.nodeId) === null,
    )
    .map((r) => ({ id: r.nodeId, label: r.display }));
}

/** The Actions a strip may place: every `Action` node, by name. The lane model and the
 *  channel fold read a strip's `action` only when it names an `Action`, so nothing else
 *  can be offered. */
export function stripActionRows(state: DagState): { id: string; name: string }[] {
  return Object.values(state.nodes)
    .filter((n) => n.type === 'Action')
    .map((n) => ({ id: n.id, name: (n.params as { name?: string }).name ?? n.id }));
}

/** `Strip.target`'s picker: {@link stripTargetRows}, as options. */
export function stripTargetOptions(state: DagState): ParamOption[] {
  return stripTargetRows(state).map((r) => ({ value: r.id, label: r.label }));
}

/** `Strip.action`'s picker: {@link stripActionRows}, as options. */
export function stripActionOptions(state: DagState): ParamOption[] {
  return stripActionRows(state).map((r) => ({ value: r.id, label: r.name }));
}
