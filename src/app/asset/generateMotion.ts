// Text-to-motion ingestion surface — the HUMAN half of A1's three-way parity.
//
// Deliberately shaped as a sibling of `importBvhFromOpfs`, line for line, because
// the phase's claim is that a generated clip is indistinguishable from an
// imported one and this is the file where a director's route to it is decided. It
// dispatches ONE atomic op batch (K6), routes every failure to the asset error
// banner rather than the console, and bumps the import refresh signal AFTER the
// dispatch — the same three things the import chokepoint does, for the same
// reasons.
//
// What it does NOT do is as load-bearing: no provenance param, no "generated"
// flag, no separate store. Once the ops land, nothing in the graph can tell this
// clip from one that arrived as a file, which is the whole of A1.
//
// Invariants honored:
//   - V8: no `src/viewport/` imports. App-layer module.
//   - K6: ONE dispatchAtomic per generation.
//   - silent-failure: a licence refusal, a malformed request or an unreachable
//     service surfaces in the banner, never console-only.
//
// REF: src/app/asset/importBvhFbx.ts (the sibling, and the shared bind);
//      src/agent/tools/motionGenerate.ts
//      (the agent half); ref/architecture/ai-track.md phase A1.

import { useDagStore } from '../../core/dag/store';
import { buildGeneratedMotionOps } from '../../core/motiongen';
import { getMotionCapability } from '../boot';
import { bindImportedMotion } from './importBvhFbx';
import { useSettingsStore } from '../stores/settingsStore';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { useGeneratedMotionStore } from '../stores/generatedMotionStore';
import { useSelectionStore } from '../stores/selectionStore';
import { motionPathFromSelection, waypointsFromCurve } from './motionPathFromCurve';
import { placeCharacterAtPathStart } from './placeGeneratedMotion';
import type { Op } from '../../core/dag/types';

export interface GenerateMotionOptions {
  readonly seconds?: number;
  // No `fps`: the generator decides its own rate and the clip states it. See
  // MotionGenerationRequest.
  readonly seed?: number;
  /** Clip name — defaults to the prompt, exactly as an import defaults to the filename. */
  readonly name?: string;
  /**
   * The curve whose shape the motion should follow (#730). Defaults to the
   * SELECTED node when omitted, and to no path at all when nothing curve-shaped
   * is selected.
   *
   * An explicit override exists because a caller that is not a click — a test, a
   * script — has no selection to speak through, and the alternative is reaching
   * into the selection store to fake one.
   */
  readonly curveId?: string;
}

/** What the caller needs to render a result. `ok: false` never throws — the
 *  banner already carries the reason, and a throw would leave the surface that
 *  invoked it with no way to return to idle. */
export type GenerateMotionResult =
  | { readonly ok: true; readonly clipId: string; readonly skeletonId: string }
  | { readonly ok: false; readonly reason: string };

/** The label an error is reported under. Not a path — nothing on disk produced
 *  this — but the banner keys on a subject, and the prompt is the subject. */
function subjectOf(prompt: string, name?: string): string {
  return name ?? (prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt);
}

/**
 * Generate a clip from a prompt and put it in the scene.
 *
 * The checkpoint comes from settings rather than from the caller, matching the
 * agent tool: it is configuration, chosen once, because the licence varies per
 * checkpoint within a single release and a per-call choice would spread that
 * surface across every invocation.
 */
export async function generateMotionIntoScene(
  prompt: string,
  options: GenerateMotionOptions = {},
): Promise<GenerateMotionResult> {
  const subject = subjectOf(prompt, options.name);
  try {
    const capability = await getMotionCapability();
    const { motionGenModel } = useSettingsStore.getState();
    const dag = useDagStore.getState();

    // The curve, read BEFORE the request is built, because it is an INPUT to the
    // generation rather than a decoration applied to the result. That ordering is
    // the whole of phase A2: the generator consumes the path, so dragging a
    // control point changes the motion that comes back, not merely where it is
    // put afterwards.
    const waypoints =
      options.curveId !== undefined
        ? waypointsFromCurve(dag.state, options.curveId)
        : motionPathFromSelection(dag.state, useSelectionStore.getState().selectedNodeId);

    const { ops, clipId, skeletonId, bvh, model, worldOffsetXZ } = await buildGeneratedMotionOps(
      capability,
      {
        request: {
          prompt,
          model: motionGenModel,
          ...(options.seconds !== undefined ? { seconds: options.seconds } : {}),
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          // `constraints: { waypoints }` is the API shape. The top-level
          // `waypoints` list the server reads is the WIRE shape, and translating
          // between them is HttpMotionGenerationCapability's job — sending the
          // wire shape from here is the defect #826 records, and the request
          // schema is `.strict()`, so it refuses one for the other.
          ...(waypoints ? { constraints: { waypoints } } : {}),
        },
        ...(options.name !== undefined ? { name: options.name } : {}),
        // This road binds, so it has a character to place and may accept a world
        // offset. The agent tool cannot say this — it never binds — and keeps the
        // refusal instead of silently leaving a character at the origin.
        appliesWorldOffset: true,
      },
      dag.state,
    );

    dag.dispatchAtomic(ops, 'user', `generate motion: ${subject}`);
    // Bump AFTER dispatch, for the reason the import path does: a pre-dispatch
    // bump re-enumerates the list before the work lands, so a failure leaves it
    // stale.
    useImportRefreshStore.getState().bump();
    // The clip is in the graph, and nothing on screen has moved. A dropped file
    // takes ONE more step — the bind #807 put at `routeImportByExtension` — and
    // a generated clip that stopped short of it was measured doing exactly
    // that: a director typed a sentence, a real clip arrived, and the character
    // stood still while the same bytes dropped as a file animated it (#820).
    // The same continuation, not a second one: the bind decisions ("which
    // character", "which bridge") stay in the one place that already makes
    // them, and this road adds no step a file import does not also take.
    const bound = bindImportedMotion({ skeletonId, clipId });
    // The path's other half. The generator canonicalised frame 0 to the origin —
    // that is the model's behaviour, not a setting — so a motion asked to follow
    // a curve comes back correct in every frame and standing in the wrong place.
    // The character the bind just chose is the thing that owns where it stands,
    // so the offset goes there.
    //
    // Dispatched separately from the bind rather than folded into it: the bind is
    // a retarget-plus-bake through the mutator road, and threading a placement
    // through that would put a transform write inside an animation mutator. Two
    // undo entries, each named for what it did, beats one entry that does two
    // unrelated things to two different nodes.
    if (worldOffsetXZ !== null && bound?.ok) {
      const placed = placeCharacterAtPathStart(
        useDagStore.getState().state,
        bound.targetSkeletonId,
        worldOffsetXZ,
      );
      if (placed.ok) {
        useDagStore
          .getState()
          .dispatchAtomic(placed.ops as Op[], 'user', `place motion on path: ${subject}`);
      } else {
        // Reported, never swallowed: the clip is in the scene and playing, and
        // the ONLY thing wrong is where. That is precisely the failure that looks
        // like success in a screenshot, so it goes to the surface that persists.
        useAssetErrorStore.getState().report(subject, `motion placement: ${placed.reason}`);
      }
    }
    // Hold the bytes so the clip can be SAVED (#819). This call is the only
    // place they exist: the ops carry parsed keyframes and nothing can turn
    // those back into a file. Recorded AFTER the dispatch so a failed
    // generation never leaves an offer to save something that is not in the
    // scene.
    useGeneratedMotionStore.getState().record({ clipId, name: options.name ?? prompt, bvh, model });
    return { ok: true, clipId, skeletonId };
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report(subject, `generate failed: ${reason}`);
    return { ok: false, reason };
  }
}
