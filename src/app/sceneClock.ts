// #1594 — scene time: how fast the scene runs against the playhead (bullet time).
//
// TWO CLOCKS. The playhead is FILM time: the ruler, playback, Render ▸ Animation's frames and
// the scene's End all count it. SCENE time is what everything in the scene is sampled at — the
// characters, keyed transforms, keyed lights, generated motion, follow-path. The Scene node's
// `timeSpeed` maps one to the other: scene time is the speed added up over film time,
//
//     scene(f) = ∫₀ᶠ max(0, speed(u)) du
//
// so speed 1 is real time, 0.05 is near-frozen and 0 holds the moment. This is the Houdini Warp
// CHOP's Rate Control (a rate curve of 1 leaves the input unwarped, below 1 slows it), applied
// to the whole scene; Blender's `framelen` (`scene.cc` BKE_scene_frame_to_ctime) is the constant
// case. Unlike Blender's, the camera does NOT follow it: a camera's own keys, lens and cuts run
// on film time, so it can travel a frozen moment (`activeCamera.ts`).
//
// The speed itself is read at FILM time (never at scene time — that would be circular), through
// the same channel collector every other keyed Scene value goes through.
//
// With no speed keyed and the value at 1, scene time IS film time, bit for bit, so a project
// that never slows plays exactly as before.

import type { DagState } from '../core/dag/state';
import { directChannelValuesForTarget } from './nodeChannels';

/** The Scene node the project renders (`outputs.scene`), or null. Not imported from
 *  `sceneRange.ts`: that module reaches the camera resolver, which reads this clock (a cycle). */
function sceneNodeId(state: DagState): string | null {
  const ref = state.outputs.scene;
  return ref && state.nodes[ref.node]?.type === 'Scene' ? ref.node : null;
}

/** The integration step for a keyed speed, in seconds (4× the 60 fps frame). */
const STEP = 1 / 240;

export interface SceneClock {
  /** True when scene time equals film time everywhere (speed 1, unkeyed). */
  readonly identity: boolean;
  /** Scene time at film time `film` (seconds). */
  sceneAt(film: number): number;
  /** The earliest film time at which scene time reaches `scene` — where a key at scene time
   *  `scene` is first on screen. A held stretch (speed 0) answers its start. */
  filmAt(scene: number): number;
}

const IDENTITY: SceneClock = {
  identity: true,
  sceneAt: (f) => f,
  filmAt: (s) => s,
};

function constantClock(speed: number): SceneClock {
  if (speed === 1) return IDENTITY;
  const k = Math.max(0, speed);
  return {
    identity: false,
    sceneAt: (f) => f * k,
    filmAt: (s) => (k > 0 ? s / k : 0),
  };
}

/** A keyed speed: integrate on a fixed grid, grown lazily as far as anyone asks. */
function curveClock(speedAt: (film: number) => number): SceneClock {
  const rate = (u: number) => {
    const v = speedAt(u);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  // cum[i] = scene time at film time i·STEP.
  const cum: number[] = [0];
  let lastRate = rate(0);
  const growTo = (i: number) => {
    while (cum.length <= i) {
      const n = cum.length;
      const r = rate(n * STEP);
      cum.push(cum[n - 1] + ((lastRate + r) / 2) * STEP);
      lastRate = r;
    }
  };
  const sceneAt = (f: number): number => {
    if (!(f > 0)) return 0;
    const i = Math.floor(f / STEP);
    growTo(i + 1);
    const t = f / STEP - i;
    // To the nanosecond: summing the grid drifts by ~1e-15, and a key written at scene time
    // would otherwise land at 0.9999999999999971 instead of 1.
    return Math.round((cum[i] + (cum[i + 1] - cum[i]) * t) * 1e9) / 1e9;
  };
  const filmAt = (s: number): number => {
    if (!(s > 0)) return 0;
    // Grow until the table passes `s`, capped so a speed held at 0 forever cannot run away.
    const cap = Math.ceil(3600 / STEP);
    while (cum[cum.length - 1] < s && cum.length < cap) growTo(cum.length * 2);
    if (cum[cum.length - 1] < s) return (cum.length - 1) * STEP;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    const a = cum[lo - 1];
    const b = cum[lo];
    return (lo - 1 + (b > a ? (s - a) / (b - a) : 0)) * STEP;
  };
  return { identity: false, sceneAt, filmAt };
}

// One clock per Scene node object: the DAG state is immutable, so a speed edit (param or channel)
// yields a new nodes record and the clock is rebuilt; anything else reuses it.
let memo: { nodes: DagState['nodes']; clock: SceneClock } | null = null;

/** The scene clock of `state`'s rendered Scene. Pure; memoised on the nodes record. */
export function sceneClockOf(state: DagState): SceneClock {
  if (memo && memo.nodes === state.nodes) return memo.clock;
  const clock = buildSceneClock(state);
  memo = { nodes: state.nodes, clock };
  return clock;
}

function buildSceneClock(state: DagState): SceneClock {
  const id = sceneNodeId(state);
  if (!id) return IDENTITY;
  const raw = (state.nodes[id].params as { timeSpeed?: unknown }).timeSpeed;
  const base = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
  const speedChannels = directChannelValuesForTarget(state.nodes, id).filter(
    (c) => c.paramPath === 'timeSpeed' && !c.mute,
  );
  if (speedChannels.length === 0) return constantClock(base);
  const ch = speedChannels[0];
  return curveClock((u) => {
    const v = ch.sample(u);
    return typeof v === 'number' ? v : base;
  });
}
