// useAnimatableField — the ONE shared spine for an animatable inspector field
// (the H104 affordance), so any custom control composes keyframing without
// re-implementing it. The diamond is already a standalone component
// (ParamDiamond); this hook owns the OTHER half of the affordance that was being
// copy-pasted per control:
//   - the EVALUATED read (resolveEvaluatedParam → the value the renderer shows:
//     transient → channel → base), so the field displays what is rendered (H40);
//   - the read-only-while-playing gate (`playing && resolved !== null` — a channel
//     actively drives the field, the VectorField D-02 gate);
//   - the single-write edit seam (routeAnimatedGrab → caller's source write →
//     autoKeyCommit — the H36/H104 chokepoint: an animated edit routes to the
//     channel/transient and SKIPS the source write; an un-animated edit writes the
//     source, then Auto-Key ON creates the free-floating first key).
//
// Custom controls (MaterialNumberRow / MaterialColorRow, the Light Studio + Scene
// Environment fields) keep their OWN chrome and render <ParamDiamond/> themselves;
// they call this hook for the spine. Generic over the value type (number | string)
// so one hook serves scalar AND colour fields — H104's "wire the affordance once".
//
// REF: src/app/resolveEvaluatedParam.ts; src/app/animate/autoKeyCommit.ts;
//      src/app/ParamDiamond.tsx; vyapti V57; hetvabhasa H40/H104.

import { useMemo } from 'react';
import { useDagStore } from '../../core/dag/store';
import { useTimeStore } from '../stores/timeStore';
import { resolveEvaluatedParam } from '../resolveEvaluatedParam';
import { routeAnimatedGrab, autoKeyCommit } from './autoKeyCommit';

export interface AnimatableField<T> {
  /** The evaluated value the renderer shows (transient → channel → base). */
  readonly effective: T;
  /** True iff a channel actively drives this field during playback → read-only. */
  readonly readOnly: boolean;
  /** Commit an edit through the single-write seam: animated → channel/transient;
   *  un-animated → caller's source write, then an Auto-Key first key. */
  readonly onEdit: (next: T) => void;
}

/**
 * The animatable-field spine for one (nodeId, paramPath). `base` is the authored
 * value (the diamond's first key + the fallback when no channel/transient drives
 * the field); `onSource` is the caller's un-animated source write (a setParam Op,
 * or the glTF whole-array replace). The diamond is rendered by the caller via
 * <ParamDiamond nodeId paramPath value={base} />.
 */
export function useAnimatableField<T extends number | string>(
  nodeId: string,
  paramPath: string,
  base: T,
  onSource: (next: T) => void,
): AnimatableField<T> {
  const frame = useTimeStore((s) => s.frame);
  const seconds = useTimeStore((s) => s.seconds);
  const normalized = useTimeStore((s) => s.normalized);
  const playing = useTimeStore((s) => s.playing);
  const dagState = useDagStore((s) => s.state);
  const resolved = useMemo(
    () =>
      resolveEvaluatedParam(dagState, nodeId, paramPath, {
        time: { frame, seconds, normalized },
      }),
    [dagState, nodeId, paramPath, frame, seconds, normalized],
  );
  // Match the resolved value to the field's type (a number field ignores a string
  // channel and vice-versa), exactly like the per-row code it replaces.
  const effective = typeof resolved?.value === typeof base ? (resolved!.value as T) : base;
  const readOnly = playing && resolved !== null;
  const onEdit = (next: T) => {
    if (routeAnimatedGrab(nodeId, paramPath, next)) return;
    onSource(next);
    autoKeyCommit(nodeId, paramPath, next);
  };
  return { effective, readOnly, onEdit };
}
