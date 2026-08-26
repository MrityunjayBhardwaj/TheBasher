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
// REF: src/app/asset/importBvhFbx.ts (the sibling); src/agent/tools/motionGenerate.ts
//      (the agent half); ref/architecture/ai-track.md phase A1.

import { useDagStore } from '../../core/dag/store';
import { buildGeneratedMotionOps } from '../../core/motiongen';
import { getMotionCapability } from '../boot';
import { useSettingsStore } from '../stores/settingsStore';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';

export interface GenerateMotionOptions {
  readonly seconds?: number;
  readonly fps?: number;
  readonly seed?: number;
  /** Clip name — defaults to the prompt, exactly as an import defaults to the filename. */
  readonly name?: string;
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

    const { ops, clipId, skeletonId } = await buildGeneratedMotionOps(
      capability,
      {
        request: {
          prompt,
          model: motionGenModel,
          ...(options.seconds !== undefined ? { seconds: options.seconds } : {}),
          ...(options.fps !== undefined ? { fps: options.fps } : {}),
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
        },
        ...(options.name !== undefined ? { name: options.name } : {}),
      },
      dag.state,
    );

    dag.dispatchAtomic(ops, 'user', `generate motion: ${subject}`);
    // Bump AFTER dispatch, for the reason the import path does: a pre-dispatch
    // bump re-enumerates the list before the work lands, so a failure leaves it
    // stale.
    useImportRefreshStore.getState().bump();
    return { ok: true, clipId, skeletonId };
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report(subject, `generate failed: ${reason}`);
    return { ok: false, reason };
  }
}
