// #1716 — an Image is a still or a run of frames, and the value says which.
//
// One socket type carries both (a reference picture and a shot's frames), so the producer states
// which on the value (`ImageValue.extent`) and the consumer states which it takes on the input
// (`InputDescriptor.takes`). This module is the one place the two meet, so the evaluator, the
// readers that evaluate a producer for a socket on their own (the ComfyUI run and its dry run),
// and the node view's marker on the wire all apply the same rule:
//
//   still  → 'frames'  holds. Nothing to do: a still is the same at every time.
//   frames → 'still'   picks a frame, the FIRST of the run (frame 0 when the run is open-ended,
//                      a render pass asked for whatever time). The producer is evaluated at that
//                      frame and the value arrives as a still naming the frame.
//
// Kept free of `src/nodes/**`: the layering gate (`componentScopeChannel.gate.test.ts`) pins which
// core files reach into the node layer, and this one needs nothing from it. An Image value is
// recognised by its shape.
//
// REF: issue #1716; board 12b of the editor design ("Still at 5.60" feeding a still workflow).

import type { EvalCtx, ImageExtent, ImageTake, InputDescriptor } from './types';

/** Exhaustive read of an extent: adding an arm to {@link ImageExtent} is a compile error here and
 *  at every caller that passes both handlers. */
export function matchImageExtent<T>(
  extent: ImageExtent,
  on: {
    still: (e: Extract<ImageExtent, { kind: 'still' }>) => T;
    frames: (e: Extract<ImageExtent, { kind: 'frames' }>) => T;
  },
): T {
  switch (extent.kind) {
    case 'still':
      return on.still(extent);
    case 'frames':
      return on.frames(extent);
    default: {
      const never: never = extent;
      throw new Error(`matchImageExtent: unknown extent ${JSON.stringify(never)}`);
    }
  }
}

/** What `desc` takes, for a node holding `params`; undefined for an input that passes on
 *  whatever arrives (or no input at all). */
export function imageTakeOf(
  desc: InputDescriptor | undefined,
  params: unknown,
): ImageTake | undefined {
  const takes = desc?.takes;
  if (takes === undefined) return undefined;
  return typeof takes === 'function' ? takes(params) : takes;
}

/** An Image value as this module needs to see it: `kind: 'Image'` and an extent. */
export interface ImageValueLike {
  readonly kind: 'Image';
  readonly extent: ImageExtent;
}

export function isImageValueLike(v: unknown): v is ImageValueLike {
  if (v === null || typeof v !== 'object') return false;
  const rec = v as { kind?: unknown; extent?: { kind?: unknown } };
  return (
    rec.kind === 'Image' &&
    typeof rec.extent === 'object' &&
    rec.extent !== null &&
    (rec.extent.kind === 'still' || rec.extent.kind === 'frames')
  );
}

/**
 * The frame a still input picks out of `value`, or null when nothing is picked: the input does
 * not take a still, or the value is already one (or is not an Image at all, e.g. unwired).
 */
export function framePickedFor(take: ImageTake | undefined, value: unknown): number | null {
  if (take !== 'still' || !isImageValueLike(value)) return null;
  return matchImageExtent(value.extent, {
    still: () => null,
    frames: (e) => (e.range ? e.range.start : 0),
  });
}

/** The evaluation time of frame `frame` of `value`'s run (30 fps when the run names none). */
export function ctxForPickedFrame(value: ImageValueLike, frame: number): EvalCtx {
  const fps =
    value.extent.kind === 'frames' && value.extent.range && value.extent.range.fps > 0
      ? value.extent.range.fps
      : 30;
  return { time: { frame, seconds: frame / fps, normalized: 0 } };
}

/** `picked` (the producer's value at the picked frame) as it arrives in a still input. */
export function asPickedStill<V>(picked: V, frame: number): V {
  if (!isImageValueLike(picked)) return picked;
  return { ...picked, extent: { kind: 'still', pickedFrame: frame } };
}
