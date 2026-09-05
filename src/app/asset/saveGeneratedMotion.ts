// Turn a generated clip into a saved asset (#819).
//
// A generated clip lands in the graph and nowhere else. It cannot be re-dragged
// onto a second character, it is not in My Imports, and it does not survive a
// reload — the bytes existed for the duration of one call. This is the gesture
// that keeps one.
//
// 🔑 IT WRITES THE BYTES AND NOTHING ELSE. It deliberately does NOT call
// `routeImportByExtension`, which is what a dropped file takes: that would parse
// the same motion a SECOND time and add a second Skeleton + AnimationClip to the
// graph, for a clip that is already in the scene. Saving is a storage act, not an
// import. This distinction is the whole file; if it ever calls the import road,
// the button silently duplicates the user's clip.
//
// 🔴 AND NOTHING DOWNSTREAM WOULD CATCH IT (#918). This note used to add "and
// attempt a second bind on a character that already carries this motion — which
// #807 correctly refuses". There is no such refusal: `BindMotionRefusal` is
// exactly `'no-character' | 'ambiguous' | 'no-bridge' | 'rejected'`
// (`bindMotionToCharacter.ts:69`). The claim was probably true once and dissolved
// on purpose when #889 removed the eager bake; the sentence stayed, promising a
// safety net a later change could lean on and get silence from. A second bind is
// ACCEPTED, and the clip that ends up driving a bone is the id-sorted-FIRST one
// (`boundClipsForAsset.ts:86`), not the one bound most recently — so a duplicate
// import would not merely add a node, it could leave the wrong motion playing.
// Pinned by `src/app/animate/secondBind.test.ts` rather than re-described here.
//
// What lands is an ORDINARY `.bvh` under `user-imports/`, indistinguishable from
// one a director dropped — same folder convention, same collision suffixing, same
// library row, and dropping it later takes the ordinary file road onto whatever
// character is selected then. That is phase A1's claim applied to storage rather
// than to the graph.
//
// V8: app-layer, no `src/viewport/` imports. No DAG mutation at all — this road
// touches storage and the refresh signal, and nothing else.
//
// REF: src/app/asset/importCommon.ts (`ingestSingleFile` — the shared write);
//      src/app/stores/generatedMotionStore.ts (what is on offer);
//      src/app/asset/generateMotion.ts (what records it); issue #819.

import { ingestSingleFile } from './importCommon';
import { formatAssetError } from '../stores/assetErrorStore';
import { useGeneratedMotionStore } from '../stores/generatedMotionStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';

/**
 * Longest prompt that becomes a folder name.
 *
 * A prompt is a sentence and a filename is not, so something has to give. Cut
 * rather than hash: `a_figure_walks_forward_and_waves` is findable in a file
 * listing six months later and `clip_8f3a` is not, and the collision case is
 * already handled by the suffixing every import shares.
 */
const MAX_SAVED_NAME = 40;

export type SaveGeneratedMotionResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/** The name a save would use — exported so the panel can show it before the
 *  gesture rather than after, and so the rule is tested in one place. */
export function savedMotionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return 'generated-motion';
  return trimmed.length > MAX_SAVED_NAME ? trimmed.slice(0, MAX_SAVED_NAME).trimEnd() : trimmed;
}

/**
 * Write the pending generated clip into the asset library.
 *
 * Never throws: a storage failure is a thing that happens to a director, and the
 * banner already carries the reason. Returns the outcome so the caller can
 * return to idle either way — the shape every asset surface here uses.
 */
export async function saveGeneratedMotionToLibrary(): Promise<SaveGeneratedMotionResult> {
  const { pending, markSaved } = useGeneratedMotionStore.getState();
  if (!pending) {
    // Not an error worth a banner: nothing was generated, or the last clip is
    // already saved. The affordance is not offered in either case, so reaching
    // here means the state changed underneath a click.
    return { ok: false, reason: 'nothing to save' };
  }

  const name = savedMotionName(pending.name);
  try {
    const path = await ingestSingleFile(
      { relativePath: `${name}.bvh`, bytes: new TextEncoder().encode(pending.bvh) },
      name,
      { failurePrefix: 'save failed:' },
    );
    // Bump AFTER the write, for the reason every other road here bumps after its
    // work: a pre-write bump re-enumerates the list before the file exists, so a
    // failure leaves it claiming a row that is not there.
    useImportRefreshStore.getState().bump();
    markSaved(path);
    return { ok: true, path };
  } catch (err) {
    // `ingestSingleFile` already reported to the banner with the save's own
    // wording; returning the reason is for the caller, not for a second message.
    return { ok: false, reason: formatAssetError(err) };
  }
}
