// #1700 — speed lives on the shot. Setting a shot to 50% writes the film's ONE speed curve (the
// Scene's `timeSpeed`, `sceneClock.ts`) across that shot's span, and the shot gets longer: the
// scene time it covers now takes twice the playhead time. Premiere's Speed/Duration and Unreal's
// shot Time Scale both edit speed on the clip, and both lengthen it.
//
// INSERT TIME. A longer shot pushes everything on the playhead's clock that comes after it, by the
// time it gained: the later cuts, every film-time key (a camera's, a Film rig's, the speed curve's
// own), an NLA placement on a film-time thing, and the scene's End. What runs on film time is the
// graph's answer (`clockOf`), the same one the dopesheet and the keyers ask, so the cuts are found
// the way every other film-time key is — `CameraSelect` runs on the playhead — and nothing here
// reads which camera is on screen. Scene-time keys stay: scene time is never stored, it carries on
// from the shot before, so a character keeps its own timing and the camera arrives with it.
//
// Both edits are built as ops against the state they are given, for ONE `dispatchAtomic` (one Undo).

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { isKeyframeChannelNode } from './animate/paramAnimationState';
import { channelEntriesFromNodes, directChannelNodesForTarget } from './nodeChannels';
import { sceneClockOf } from './sceneClock';
import { clockOf } from './subjectClock';

/** 60 fps — the frame `Scene.frameEnd` counts. */
const FPS = 60;

type Key = { time: number; value: unknown; easing?: string };

function sceneIdOf(state: DagState): string | null {
  const ref = state.outputs.scene;
  return ref && state.nodes[ref.node]?.type === 'Scene' ? ref.node : null;
}

/**
 * Ops that re-time everything on film time through `map`, a film time to its new film time: every
 * film-time channel's keys, every film-time strip's start, and the scene's End. `map` must never
 * decrease, so keys keep their order. A key keeps every field but its time: handles are offsets
 * from their own key, so they travel with it. Empty when nothing moves.
 */
function buildRetimeOps(state: DagState, map: (t: number) => number): Op[] {
  const ops: Op[] = [];
  for (const node of Object.values(state.nodes)) {
    const p = node.params as {
      target?: unknown;
      paramPath?: unknown;
      keyframes?: Key[];
      start?: unknown;
    };
    if (typeof p.target !== 'string' || !p.target) continue;
    if (isKeyframeChannelNode(node)) {
      const path = typeof p.paramPath === 'string' ? p.paramPath : undefined;
      if (clockOf(state, p.target, path) !== 'film') continue;
      const keys = p.keyframes ?? [];
      if (!keys.some((k) => map(k.time) !== k.time)) continue;
      const moved = keys.map((k) => ({ ...k, time: map(k.time) })).sort((a, b) => a.time - b.time);
      ops.push({ type: 'setParam', nodeId: node.id, paramPath: 'keyframes', value: moved });
    } else if (node.type === 'Strip') {
      // An NLA placement is a film-time thing when what it plays on is.
      if (typeof p.start !== 'number' || map(p.start) === p.start) continue;
      if (clockOf(state, p.target) !== 'film') continue;
      ops.push({ type: 'setParam', nodeId: node.id, paramPath: 'start', value: map(p.start) });
    }
  }
  const sceneId = sceneIdOf(state);
  if (sceneId) {
    const raw = (state.nodes[sceneId].params as { frameEnd?: unknown }).frameEnd;
    const frameEnd = typeof raw === 'number' ? raw : 600;
    const next = Math.max(1, Math.round(map(frameEnd / FPS) * FPS));
    if (next !== frameEnd)
      ops.push({ type: 'setParam', nodeId: sceneId, paramPath: 'frameEnd', value: next });
  }
  return ops;
}

/**
 * Ops that move everything on film time at or after `at` seconds later by `delta` seconds (an
 * earlier time when negative), End included when it is at or after `at`. Empty when there is
 * nothing to move.
 */
export function buildInsertTimeOps(state: DagState, at: number, delta: number): Op[] {
  if (!Number.isFinite(at) || !Number.isFinite(delta) || delta === 0) return [];
  return buildRetimeOps(state, (t) => (t >= at ? t + delta : t));
}

/** The speed a stretch of the film plays at: the scene time it covers over its playhead time. */
export function speedOver(state: DagState, start: number, end: number): number {
  if (!(end > start)) return 1;
  const clock = sceneClockOf(state);
  return (clock.sceneAt(end) - clock.sceneAt(start)) / (end - start);
}

export interface ShotSpeedEdit {
  readonly ops: Op[];
  /** Where the shot ends once the edit is made. */
  readonly end: number;
}

/**
 * Play the shot `[start, end)` at `speed` (1 = real time, 0.5 = half speed). The shot keeps the
 * scene time it covers, so its length becomes that scene time over `speed`, and everything on
 * film time after it moves by the difference (`buildInsertTimeOps`). `keepLength` is the opt-out:
 * the shot stays as long as it is and simply covers less (or more) of the scene; nothing moves.
 *
 * The speed curve before the shot plays as it did, and after the shot it resumes the speed it had
 * at the shot's old end. Null when the speed cannot hold a length (≤ 0 or not finite) or there is
 * no Scene.
 */
export function buildShotSpeedOps(
  state: DagState,
  start: number,
  end: number,
  speed: number,
  opts: { keepLength?: boolean } = {},
): ShotSpeedEdit | null {
  if (!(speed > 0) || !Number.isFinite(speed) || !(end > start)) return null;
  const sceneId = sceneIdOf(state);
  if (!sceneId) return null;

  const clock = sceneClockOf(state);
  const covered = clock.sceneAt(end) - clock.sceneAt(start);
  // A cut lands on a frame, as End does. The clock sums the speed on a 1/240 s grid, so the scene
  // time it reports across a step is off by a fraction of a millisecond; snapping keeps a shot
  // re-timed back to its old speed at its old length instead of drifting by that each time.
  const newEnd = opts.keepLength ? end : Math.round((start + covered / speed) * FPS) / FPS;
  const delta = newEnd - end;

  // The speed curve as it is now: its channel (the one the clock reads), and its value at a time.
  const rawBase = (state.nodes[sceneId].params as { timeSpeed?: unknown }).timeSpeed;
  const base = typeof rawBase === 'number' && Number.isFinite(rawBase) ? rawBase : 1;
  // The channel the clock reads: the first live one on `timeSpeed`, found the same way.
  const entry = channelEntriesFromNodes(directChannelNodesForTarget(state.nodes, sceneId)).find(
    (e) => e.value.paramPath === 'timeSpeed' && !e.value.mute,
  );
  const value = entry?.value;
  const channel = entry?.node;
  const speedAt = (t: number): number => {
    const v = value?.sample(t);
    return typeof v === 'number' && Number.isFinite(v) ? v : base;
  };
  const resume = speedAt(end);

  // 1 — re-time what is on film time. Before the shot nothing moves; after it, everything moves
  //     by the shot's change in length; inside it, a key moves with the scene time it shows, so a
  //     camera move stays on the action it was keyed against (the shot plays its old scene time
  //     at one speed across the new length). The map never decreases, so no key overtakes
  //     another. With `keepLength` the shot covers different scene time and nothing moves. The
  //     speed curve is on film time too; its keys are written whole in step 2, so its move is
  //     left to that.
  const sceneStart = clock.sceneAt(start);
  const map = (t: number): number => {
    if (t < start) return t;
    if (t >= end) return t + delta;
    if (opts.keepLength || !(covered > 0)) return t;
    // On the clock's own 1/240 s grid: the clock is good to a fraction of a step, so a key
    // re-timed there and back would otherwise drift by that each time. Rounding never reorders,
    // and the new end is on a frame, so a key stays inside the shot.
    const mapped = start + ((clock.sceneAt(t) - sceneStart) / covered) * (newEnd - start);
    return Math.round(mapped * 240) / 240;
  };
  const ops = buildRetimeOps(state, map).filter(
    (op) => !(channel && op.type === 'setParam' && op.nodeId === channel.id),
  );

  // 2 — the shot's span: it holds `speed` from its start to its new end, and the film resumes the
  //     speed it had at the old end. Keys inside the old span are the old ramp, replaced.
  //     A key's easing is how the curve ARRIVES at it (destination-key-governs, keyframeInterp),
  //     so each key below carries the shape of the stretch that ends at it (#1744).
  const old: Key[] = channel
    ? [...((channel.params as { keyframes?: Key[] }).keyframes ?? [])].sort(
        (a, b) => a.time - b.time,
      )
    : [];
  const STEP = 1 / 240;
  const before = old.filter((k) => k.time < start);
  const after = old.filter((k) => k.time >= end).map((k) => ({ ...k, time: k.time + delta }));
  const keys: Key[] = [...before];
  const prev = before[before.length - 1];
  const hold = start - STEP;
  if (prev && prev.time < hold) {
    // The old curve ran from `prev` to the next key, shaped by that key. Stop it one integration
    // step before the shot with the same shape, so the shot before plays as it did.
    const next = old.find((k) => k.time > prev.time);
    keys.push({ time: hold, value: speedAt(hold), easing: next?.easing ?? 'constant' });
  } else if (!prev && start > 0) {
    keys.push({ time: 0, value: speedAt(0), easing: 'constant' });
  }
  // Arrive at the shot's speed in a step, then hold it to the new end.
  keys.push({ time: start, value: speed, easing: 'constant' });
  const first = after[0];
  if (first?.time === newEnd && first.easing !== 'constant') {
    // The old curve resumes with a key right at the new end, whose shape would govern the shot.
    // Hold the shot's speed up to one step before it instead.
    keys.push({ time: newEnd - STEP, value: speed, easing: 'constant' });
  } else if (first?.time !== newEnd) {
    // Hold to the new end, then resume the speed the film had at the old end; the next key after
    // it keeps the shape it arrived with.
    keys.push({ time: newEnd, value: resume, easing: 'constant' });
  }
  keys.push(...after);

  if (channel) {
    ops.push({ type: 'setParam', nodeId: channel.id, paramPath: 'keyframes', value: keys });
  } else {
    ops.push({
      type: 'addNode',
      nodeId: `${sceneId}_timeSpeed_channel`,
      nodeType: 'KeyframeChannelNumber',
      params: { name: 'timeSpeed', target: sceneId, paramPath: 'timeSpeed', keyframes: keys },
    });
  }
  return { ops, end: newEnd };
}
