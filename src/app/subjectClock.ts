// #1594 / #1688 — which clock a thing is keyed and read on: the scene's, or the playhead's.
//
// Everything in the scene runs on SCENE time (`useTimeStore.seconds`), which the Scene's speed
// slows. A camera does not: its own keys, lens and cuts run on FILM time (the playhead), so it
// keeps moving through a slowed moment. A key written on a thing therefore has to land on the
// clock that thing plays on, or it would play back somewhere else. Equal clocks until the scene's
// speed is changed, so this decides nothing in a scene that never slows.
//
// #1688 — the answer is the graph's, not a list of types. A node runs on film time when it is a
// camera or a cut, when it is set to `film` (`clockParams`: a camera rig), or when the node it
// hangs from does: the clock is inherited down the parent chain, so a child of a camera follows
// the camera, and a camera on a film rig keeps moving with the rig. A data half (a camera's lens,
// a light's shading) runs on the clock of the object that poses it.
//
// The Scene's own `timeSpeed` is on film time too: it DEFINES scene time, so it is read at the
// playhead (`sceneClock.ts`) and must be keyed there.

import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import { isCameraNode } from './cameraNode';
import { sceneClockOf } from './sceneClock';
import { hierarchyChildIds } from './sceneHierarchy';
import { useTimeStore } from './stores/timeStore';

export type Clock = 'scene' | 'film';

/** Who holds each node: its scene-graph parent, and the object posing each data half. One pass
 *  per nodes record — the state is immutable, so a structural edit yields a new record. */
interface Owners {
  readonly parent: ReadonlyMap<string, string>;
  readonly poser: ReadonlyMap<string, string>;
}

const ownersCache = new WeakMap<DagState['nodes'], Owners>();

function ownersOf(state: DagState): Owners {
  const hit = ownersCache.get(state.nodes);
  if (hit) return hit;
  const parent = new Map<string, string>();
  const poser = new Map<string, string>();
  for (const [id, node] of Object.entries(state.nodes)) {
    // The Scene holds its top-level children; the top of the chain is scene time, so it is
    // simply not recorded as a parent.
    if (node.type !== 'Scene') {
      for (const child of hierarchyChildIds(node)) if (!parent.has(child)) parent.set(child, id);
    }
    const data = (node.inputs as Record<string, unknown> | undefined)?.data as
      | { node?: unknown }
      | undefined;
    if (typeof data?.node === 'string' && !poser.has(data.node)) poser.set(data.node, id);
  }
  const owners = { parent, poser };
  ownersCache.set(state.nodes, owners);
  return owners;
}

/** True when `id` itself is on the playhead, before anything is inherited: a camera, a cut, or a
 *  node set to `film`. */
function ownFilm(state: DagState, id: string): boolean {
  const node = state.nodes[id];
  if (!node) return false;
  if (node.type === 'CameraSelect') return true;
  if (
    isCameraNode(state, id) ||
    node.type === 'PerspectiveCamera' ||
    node.type === 'OrthographicCamera'
  )
    return true;
  return (node.params as { clock?: unknown }).clock === 'film';
}

/** The clock `id` runs on (its own animation, and — when given — its `paramPath`). */
export function clockOf(state: DagState, id: string, paramPath?: string): Clock {
  const node = state.nodes[id];
  if (!node) return 'scene';
  if (node.type === 'Scene') return paramPath === 'timeSpeed' ? 'film' : 'scene';
  const { parent, poser } = ownersOf(state);
  // A data half answers for the object posing it.
  let at: string | undefined = poser.get(id) ?? id;
  const seen = new Set<string>();
  while (at && !seen.has(at)) {
    if (ownFilm(state, at)) return 'film';
    seen.add(at);
    at = parent.get(at);
  }
  return 'scene';
}

/** True when `id`'s own animation (or its `paramPath`, when given) runs on the playhead. */
export function runsOnFilmTime(state: DagState, id: string, paramPath?: string): boolean {
  return clockOf(state, id, paramPath) === 'film';
}

/** The time (seconds and frame) at which `id`'s `paramPath` is keyed and read right now. */
export function clockFor(
  state: DagState,
  id: string,
  paramPath?: string,
): { seconds: number; frame: number } {
  const t = useTimeStore.getState();
  return runsOnFilmTime(state, id, paramPath)
    ? { seconds: t.filmSeconds, frame: t.filmFrame }
    : { seconds: t.seconds, frame: t.frame };
}

/** A context that says which scene time and which playhead time it was taken at; `time` is on
 *  whichever of the two clocks the node being read runs on. A plain `EvalCtx` is scene time.
 *
 *  Both times stay out of `EvalCtx` itself: that shape is pinned
 *  (`determinismContract.gate.test.ts`), and a node reading a field its cache key leaves out would
 *  collide. Only the resolvers that pose a node read them. */
export interface ClockedCtx extends EvalCtx {
  readonly scene?: number;
  readonly film?: number;
}

/** The scene time `ctx` was taken at. */
export function sceneSecondsOf(ctx: ClockedCtx): number {
  return typeof ctx.scene === 'number' ? ctx.scene : ctx.time.seconds;
}

/** The playhead time `ctx` was taken at: the `film` it carries when its maker knew it; else the
 *  live playhead when `ctx` is at the live scene time (every UI reader builds its context from
 *  the time store, and a stretch held at speed 0 cannot be worked back — many playhead times map
 *  to one scene time, and a film rig must keep moving through it); else worked back through the
 *  scene clock, which is exact wherever the scene is not held. */
export function filmSecondsOf(state: DagState, ctx: ClockedCtx): number {
  if (typeof ctx.film === 'number') return ctx.film;
  const scene = sceneSecondsOf(ctx);
  const live = useTimeStore.getState();
  if (live.seconds === scene) return live.filmSeconds;
  return sceneClockOf(state).filmAt(scene);
}

/** A context on `clock`, taken at scene time `scene` and playhead time `film`. */
export function clockedCtx(scene: number, film: number, clock: Clock = 'scene'): ClockedCtx {
  const seconds = clock === 'film' ? film : scene;
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 }, scene, film };
}

/** The live playhead as a context on `clock` (scene time unless asked). */
export function liveCtx(clock: Clock = 'scene'): ClockedCtx {
  const t = useTimeStore.getState();
  return clockedCtx(t.seconds, t.filmSeconds, clock);
}

/** `ctx` re-timed onto `clock`; the same object when it is already there and needs nothing.
 *  An absent `ctx` stays absent: some readers pass none and let `evaluate` take its default time
 *  (`resolveEvaluatedMesh`), so there is no playhead to re-time. */
export function ctxOnClock(state: DagState, clock: Clock, ctx: ClockedCtx): ClockedCtx {
  if (!ctx) return ctx;
  const scene = sceneSecondsOf(ctx);
  const film = filmSecondsOf(state, ctx);
  const seconds = clock === 'film' ? film : scene;
  if (seconds === ctx.time.seconds && (film === scene || ctx.film === film)) return ctx;
  return clockedCtx(scene, film, clock);
}

/** `ctx` re-timed onto the clock `id` runs on. */
export function ctxOnClockOf(state: DagState, id: string, ctx: ClockedCtx): ClockedCtx {
  return ctxOnClock(state, clockOf(state, id), ctx);
}
