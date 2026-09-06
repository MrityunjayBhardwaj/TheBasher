// The director's road to a re-cookable generated motion (#935, closing #902).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS REPLACED THE ONE-SHOT ROAD, WHICH IS NOW DELETED (#948)
// ─────────────────────────────────────────────────────────────────────────────
// `generateMotionIntoScene` called the generator, baked the clip, and discarded
// the prompt, the seed and the waypoints that produced it. The clip was correct
// and it had no producer, so editing the curve could not re-cook it — the promise
// #730 made and could not keep, for a structural reason: a call has no input
// edge. It survived #935 only because the parity claim was still written against
// it; #948 moved that claim here and retired the road.
//
// This road mints the producer instead. Everything downstream is unchanged,
// because the cook writes its keys into an ordinary `AnimationClip` node's params
// — the same node a dropped `.bvh` produces, plus one input edge.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SEED IS CHOSEN HERE, AND THAT IS NOT THE DEFAULT THE NODE REFUSES
// ─────────────────────────────────────────────────────────────────────────────
// `MotionGenerate` gives `seed` no default on purpose: a clip that cannot say
// which seed produced it is reproducible by accident rather than by construction.
// Picking one at MINT time and writing it into params satisfies that exactly —
// the node always carries an explicit seed, visible and editable in the
// inspector, and re-cooking with it returns the same motion. What the node
// refuses is a seed that is absent until something invents one at request time.
//
// The MODEL comes from settings rather than from the caller, matching both the
// imperative road and the agent tool: the licence varies per checkpoint, so a
// per-call choice would spread that surface across every invocation.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ORDER IS MINT → COOK → BIND → PLACE, AND EACH STEP NEEDS THE ONE BEFORE
// ─────────────────────────────────────────────────────────────────────────────
// The bind needs a rig, and the rig does not exist until the cook lands one — the
// minted `Skeleton` starts empty because the generator has not said what it
// produced. Placement needs the bind, because the character it moves is the
// character the bind chose. Placement last is why it is not folded into the cook.
//
// REF: src/app/asset/mintMotionGenerate.ts (the chain);
//      src/app/asset/cookMotionGenerations.ts (the cook + the placement step);
//      src/app/asset/generateMotion.ts (the one-shot road this supersedes);
//      src/app/asset/importBvhFbx.ts (`bindImportedMotion`, the shared continuation);
//      issues #935, #902, #730.

import { useDagStore } from '../../core/dag/store';
import type { Op } from '../../core/dag/types';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { bindImportedMotion } from './importBvhFbx';
import { cookMotionGenerations, placeCookedMotion } from './cookMotionGenerations';
import { chooseSeed, mintMotionGenerateOps } from './mintMotionGenerate';
import { waypointsFromCurve } from './motionPathFromCurve';

export interface GenerateMotionNodeOptions {
  readonly name?: string;
  readonly seconds?: number;
  /** Explicit seed. Omitted, one is chosen and written into the node's params. */
  readonly seed?: number;
  /** Explicit curve. Omitted, the current selection is used when it samples. */
  readonly curveObjectId?: string;
}

export type GenerateMotionNodeResult =
  | { readonly ok: true; readonly producerId: string; readonly clipId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The curve to walk, or undefined.
 *
 * Tested by SAMPLING rather than by node type: `waypointsFromCurve` already
 * refuses a degenerate curve whose control points are stacked, and a path that
 * cannot be sampled is not a path. Selecting a cube therefore generates without
 * a path rather than wiring an edge the generator cannot use.
 */
function selectedCurve(
  state: ReturnType<typeof useDagStore.getState>['state'],
): string | undefined {
  const id = useSelectionStore.getState().selectedNodeId;
  if (!id) return undefined;
  return waypointsFromCurve(state, id) ? id : undefined;
}

/**
 * Generate a clip from a prompt, as a node the graph can re-cook.
 *
 * `ok: false` never throws — the banner already carries the reason, and a throw
 * would leave the surface that invoked it with no way back to idle.
 */
export async function generateMotionAsNode(
  prompt: string,
  options: GenerateMotionNodeOptions = {},
): Promise<GenerateMotionNodeResult> {
  const subject = options.name ?? (prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt);
  try {
    const { state } = useDagStore.getState();
    const { motionGenModel } = useSettingsStore.getState();

    const mint = mintMotionGenerateOps(state, {
      prompt,
      seed: options.seed ?? chooseSeed(),
      model: motionGenModel,
      ...(options.seconds !== undefined ? { seconds: options.seconds } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(() => {
        const curve = options.curveObjectId ?? selectedCurve(state);
        return curve !== undefined ? { curveObjectId: curve } : {};
      })(),
    });
    useDagStore
      .getState()
      .dispatchAtomic(mint.ops as Op[], 'user', `add motion generator: ${subject}`);

    const cooked = await cookMotionGenerations();
    if (cooked.reason !== undefined) return { ok: false, reason: cooked.reason };
    if (cooked.generated === 0 && cooked.baked === 0) {
      // The producer refused. The resolver has already recorded that on the node
      // and reported it, so the node stays in the graph carrying a `failed` state
      // a director can see and re-cook — deliberately NOT rolled back, because a
      // generator that vanished on a server hiccup takes the prompt with it.
      return { ok: false, reason: `generation did not produce a clip for “${subject}”.` };
    }

    // The same continuation a dropped file takes (#807/#820): a generated clip
    // that stopped short of the bind was measured leaving a character standing
    // still while the same bytes dropped as a file animated it.
    bindImportedMotion({ skeletonId: mint.skeletonId, clipId: mint.clipId });
    // ...and only now can placement find the character the bind just chose.
    placeCookedMotion();

    useImportRefreshStore.getState().bump();
    return { ok: true, producerId: mint.producerId, clipId: mint.clipId };
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report(subject, `generate failed: ${reason}`);
    return { ok: false, reason };
  }
}
