// shotOps — the shots panel's edits, each ONE undo step, written as keys on the active camera
// (#1595). There is no shot record to keep in step: a cut is a key on `CameraSelect.active`, and
// the rows are derived from those keys (`shots.ts`). The agent makes the same data with
// `mutator.timeline.addChannel` + `mutator.timeline.keyframe`; moving a cut is the dopesheet's own
// one-undo retime (`dispatchRetimeKeyframe`), so dragging a cut and dragging its key are one road.
//
// Every key is written 'constant' — a choice holds until the next key (#1663) — and the cuts
// channel is the one the resolver samples (`cutChannelOf`), so what the panel writes is what plays.

import { applyOp, type DagState } from '../core/dag';
import type { NodeRef, Op } from '../core/dag/types';
import { enumerateCameraNodeIds, selectActiveCameraNode } from './activeCamera';
import { buildSetActiveCameraOps } from './setActiveCamera';
import { cameraSelectOf, cutChannelOf } from './shots';

type Key = { time: number; value: number; easing: string };

/** Apply `ops` to `state` in order (the panel builds later ops against the earlier ones' result). */
function applied(state: DagState, ops: readonly Op[]): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

/**
 * Ops that guarantee a camera switch exists and lists `cameraId`, plus that camera's index in it.
 * Null when the scene has no camera socket or `cameraId` is not a camera.
 */
function ensureListed(
  state: DagState,
  cameraId: string,
): { ops: Op[]; selectId: string; index: number } | null {
  const ops: Op[] = [];
  let s = state;
  if (!cameraSelectOf(s)) {
    // One camera wired directly: the switch is inserted the way Set Active inserts it. With the
    // chosen camera already active there is nothing to insert yet — pick another first.
    const first = enumerateCameraNodeIds(s).find((id) => id !== cameraId);
    const insert =
      buildSetActiveCameraOps(s, cameraId) ?? (first ? buildSetActiveCameraOps(s, first) : null);
    if (!insert) return null;
    ops.push(...insert);
    s = applied(s, insert);
  }
  const select = cameraSelectOf(s);
  if (!select) return null;
  const listed = ((select.inputs.cameras ?? []) as NodeRef[]).map((r) => r.node);
  let index = listed.indexOf(cameraId);
  if (index < 0) {
    ops.push({
      type: 'connect',
      from: { node: cameraId, socket: 'out' },
      to: { node: select.id, socket: 'cameras' },
    });
    index = listed.length;
  }
  return { ops, selectId: select.id, index };
}

/**
 * Cut to `cameraId` at `at` seconds: a key at `at`. When nothing is keyed yet, the camera on
 * screen now is keyed at 0 first, so the stretch before the cut keeps showing it (a lone key would
 * hold its own camera backwards over the whole film).
 */
export function buildCutOps(state: DagState, at: number, cameraId: string): Op[] | null {
  const before = selectActiveCameraNode(state, 0)?.id ?? null;
  const listed = ensureListed(state, cameraId);
  if (!listed) return null;
  const ops = [...listed.ops];
  let s = applied(state, ops);
  const channel = cutChannelOf(s, listed.selectId);

  if (!channel) {
    const keys: Key[] = [];
    if (at > 0 && before && before !== cameraId) {
      const held = ensureListed(s, before);
      if (!held) return null;
      ops.push(...held.ops);
      s = applied(s, held.ops);
      keys.push({ time: 0, value: held.index, easing: 'constant' });
    }
    keys.push({ time: at, value: listed.index, easing: 'constant' });
    ops.push({
      type: 'addNode',
      nodeId: `${listed.selectId}_active_channel`,
      nodeType: 'KeyframeChannelNumber',
      params: { name: 'active', target: listed.selectId, paramPath: 'active', keyframes: keys },
    });
    return ops;
  }

  const existing = (channel.params as { keyframes?: Key[] }).keyframes ?? [];
  const next = [
    ...existing.filter((k) => k.time !== at),
    { time: at, value: listed.index, easing: 'constant' },
  ].sort((a, b) => a.time - b.time);
  ops.push({ type: 'setParam', nodeId: channel.id, paramPath: 'keyframes', value: next });
  return ops;
}

/** Put the shot that starts at `start` on `cameraId` — the same as cutting there. */
export function buildSetShotCameraOps(
  state: DagState,
  start: number,
  cameraId: string,
): Op[] | null {
  return buildCutOps(state, start, cameraId);
}

/** Remove the cut at `keyTime`; the shot before it runs on through. */
export function buildRemoveCutOps(state: DagState, keyTime: number): Op[] | null {
  const select = cameraSelectOf(state);
  const channel = select ? cutChannelOf(state, select.id) : null;
  if (!channel) return null;
  const existing = (channel.params as { keyframes?: Key[] }).keyframes ?? [];
  const next = existing.filter((k) => k.time !== keyTime);
  if (next.length === existing.length) return null;
  return [{ type: 'setParam', nodeId: channel.id, paramPath: 'keyframes', value: next }];
}
