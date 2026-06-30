import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useTimeStore } from '../app/stores/timeStore';

/**
 * Follow an animatable object's EVALUATED value at the live playhead ([[V85]],
 * [[H132]]).
 *
 * `SceneFromDAG` evaluates the React tree at a FROZEN `ctx.time = 0` (P7.10);
 * animation reaches the viewport through per-frame `useFrame` overlays that
 * re-sample the evaluated value at the live `seconds` and update the live three.js
 * object — `DirectChannelsR` (meshes), `DirectChannelsLightR` (lights),
 * `SceneEnvChannelsR` (env), `EditorViewCamera` (the look-through camera). An
 * editor VISUAL of an animatable object that lacks such a follower freezes at frame
 * 0 while the gizmo + real object move (the render-source split [[H132]] — the
 * camera frustum #240 and the light helpers #241).
 *
 * This is the extracted, shared form of that follower. `sample(seconds)` returns
 * the evaluated value at clip-time `seconds` (it reads live DAG state itself, so
 * the closure stays valid across frames). Each frame we re-sample and, ONLY when
 * the result actually changed — a cheap `signature` compare, so a static playhead
 * causes no React churn — `setState` so the visual re-renders. Because the sample
 * reads live state, a gizmo/keyframe edit at the CURRENT frame (no playhead move)
 * is picked up on the next frame too: the sampled value changes → signature differs
 * → re-render. (The Canvas runs `frameloop="always"`, so `useFrame` ticks during
 * playback, scrub, AND a gizmo drag.)
 */
export function usePlayheadFollow<T>(
  sample: (seconds: number) => T,
  signature: (value: T) => string = (v) => JSON.stringify(v),
): T {
  const [value, setValue] = useState<T>(() => sample(useTimeStore.getState().seconds));
  const sigRef = useRef<string>(signature(value));
  useFrame(() => {
    const next = sample(useTimeStore.getState().seconds);
    const sig = signature(next);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    setValue(next);
  });
  return value;
}
