// keyCamera — what Insert Keyframe (I) keys on a camera (#1763).
//
// Blender 5.1.1, measured with its real Insert Keyframe in the 3D viewport: I on a camera keys
// its OWN location, rotation (in its rotation mode) and scale, exactly as on any object. A
// constraint's result is not keyed: a constrained camera's aim is keyed on what the constraint
// aims at. Only the opt-in visual keying writes the computed orientation, and that exists for
// baking.
//
// So here: the camera Object's own pose (its keys and held edits, never its Track-To's computed
// orientation), and, when a point Track-To wins on it, that Track-To's `aimPoint` — the channel
// the v26 step already moves a saved camera's look-at keys onto. A Track-To that follows a node
// gets no extra key: the node carries its own, as Blender's target object does.
//
// The aim key runs on the camera's clock without help: a constraint's keys run on the clock of
// the object it constrains (`subjectClock`), and `keyParamFromTransient` keys on that clock.

import type { EvaluatorCache } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import type { RotationModeFields } from '../../nodes/types';
import { cameraLocalPose } from '../resolveWorldTransform';
import { overlayCameraChannels } from '../cameraChannels';
import { withHeldCameraEdits } from '../cameraHeldEdits';
import { resolveActiveTrackTo } from '../nodeConstraints';
import { resolvedQuaternionOf } from '../resolvedRotation';
import { type ClockedCtx, ctxOnClockOf, liveCtx } from '../subjectClock';
import { uiEvaluatorCache } from '../uiEvaluatorCache';
import { keyParamFromTransient } from './autoKeyCommit';

/** One key Insert Keyframe takes: `value` on `nodeId`'s `paramPath`. */
export interface CameraKey {
  readonly nodeId: string;
  readonly paramPath: 'position' | 'rotation' | 'quaternion' | 'scale' | 'aimPoint';
  readonly value: unknown;
}

/**
 * The keys I takes on the camera `cameraId` at `ctx`: its own position, its rotation in its mode
 * (`quaternion` in quaternion mode, else `rotation`) and its scale, each with its keys and held
 * edits applied; then the winning point Track-To's `aimPoint`, when one aims it. Pure apart from
 * the held edits it reads, as every camera pose read does.
 */
export function cameraInsertKeys(
  state: DagState,
  cameraId: string,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): CameraKey[] {
  const own = cameraLocalPose(state, cameraId, ctx, cache);
  const quat = resolvedQuaternionOf(own as RotationModeFields);
  const keys: CameraKey[] = [
    { nodeId: cameraId, paramPath: 'position', value: own.position },
    quat
      ? { nodeId: cameraId, paramPath: 'quaternion', value: quat }
      : { nodeId: cameraId, paramPath: 'rotation', value: own.rotation },
  ];
  // The pose leaves scale out (a camera draws without it); it is read by the same two rules.
  const scale = (state.nodes[cameraId]?.params as { scale?: unknown } | undefined)?.scale;
  if (scale !== undefined && scale !== null) {
    const onClock = ctxOnClockOf(state, cameraId, ctx);
    const read = withHeldCameraEdits(
      state,
      cameraId,
      overlayCameraChannels(state, cameraId, { scale }, onClock, cache),
    );
    keys.push({ nodeId: cameraId, paramPath: 'scale', value: read.scale });
  }
  const winner = resolveActiveTrackTo(state, cameraId, ctxOnClockOf(state, cameraId, ctx), cache);
  if (winner && !winner.aimNode) {
    keys.push({ nodeId: winner.nodeId, paramPath: 'aimPoint', value: winner.aimPoint });
  }
  return keys;
}

/** Insert Keyframe on the camera `cameraId` at the live playhead: every key `cameraInsertKeys`
 *  names, each through the shared insert fork (a held edit is what gets keyed). */
export function keyCameraFromUI(cameraId: string): void {
  const state = useDagStore.getState().state;
  for (const k of cameraInsertKeys(state, cameraId, liveCtx(), uiEvaluatorCache)) {
    keyParamFromTransient(k.nodeId, k.paramPath, k.value);
  }
}
