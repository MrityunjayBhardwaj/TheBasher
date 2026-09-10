// The cook affordance's callee (#935) — the one thing that runs the resolver.
//
// Before this, `resolvePendingMotionGenerations` was a function nobody invoked,
// so every `MotionGenerate` in a graph stayed `pending` forever. This is the
// trigger, and the shape it takes IS the re-cook policy #902 left open.
//
// ─────────────────────────────────────────────────────────────────────────────
// EXPLICIT COOK, NOT DEBOUNCE — AND THE DATA MODEL ALREADY ENFORCES IT
// ─────────────────────────────────────────────────────────────────────────────
// A generation is a paid, several-second call. Firing it from a render reaction
// would spend a director's money on every drag of a control point, and a debounce
// only moves that decision behind a timer nobody chose. So the cook is a call, and
// a director makes it.
//
// What makes that safe rather than merely deferred is that a stale clip keeps
// playing: the band reads the sink clip's params, and `bakeGeneratedClipOps` only
// ever writes a `ready` result. So the interval between an edit and a cook is a
// clip that is out of date, never a character standing still.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO DISPATCHES, NOT ONE, AND NOT THREE
// ─────────────────────────────────────────────────────────────────────────────
// The generation itself writes nothing to the graph — it lands in the content
// store — so there is exactly one batch of ops here, the bake. It goes out as a
// single atomic dispatch so a cook is ONE undo entry covering every clip it
// refreshed. Undoing a cook returns every clip to its previous keys together,
// which is what a director means by "undo that".
//
// REF: src/app/asset/resolveMotionGenerate.ts (performs the call);
//      src/app/asset/bakeGeneratedClip.ts (turns a landed result into Ops);
//      src/app/render/runWorkflow.ts (the same cook shape for images);
//      issues #935, #902.

import { useDagStore } from '../../core/dag/store';
import type { DagState } from '../../core/dag/state';
import { getMotionCapability } from '../boot';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useGeneratedMotionStore } from '../stores/generatedMotionStore';
import { bakeGeneratedClipOps, clipBakeStates } from './bakeGeneratedClip';
import { placeCookedMotionOps } from './placeGeneratedMotion';
import { resolvePendingMotionGenerations } from './resolveMotionGenerate';
import { assetRefOfSkeleton, riggedSkeletonsForClip } from '../animate/boundClipsForAsset';
import { channelSeedRows } from '../animate/clipSeedProvenance';
import type { BakedComponent } from '../../agent/mutators/builders/bakeChannelOps';

export interface CookOutcome {
  /** How many producers this pass generated for. */
  readonly generated: number;
  /** How many refused, each already recorded as a terminal state on its node. */
  readonly failed: number;
  /** How many sink clips had their params refreshed. */
  readonly baked: number;
  /** Set only when the pass could not START — no capability, no settings. */
  readonly reason?: string;
}

/**
 * Whether anything in the graph is waiting to be cooked — the affordance's
 * enabled state.
 *
 * 🔴 DO NOT CALL THIS ON A RENDER PATH WITHOUT MEMOIZING. Answering "is anything
 * stale" means comparing each producer's CURRENT request hash against the hash
 * its clip was baked from, and computing that hash means resolving the producer's
 * inputs — which walks the curve. `evaluate` with no `cache` gets a fresh
 * per-call memo, so nothing is shared between calls.
 *
 * Measured: 4 producers on a 64-point curve cost 2.2ms per call — 13% of a 60fps
 * frame, on every pointer move of a drag, and the drag is exactly when it changes.
 * The same shape `retargetFromNodes` memoizes on operand identity for the same
 * reason. Nothing calls this yet, so it is documented rather than solved; the
 * surface that wires it should memoize or pass a shared cache.
 */
export function hasStaleGenerations(): boolean {
  const { state } = useDagStore.getState();
  return clipBakeStates(state).some((c) => c.stale || c.status === 'pending');
}

/**
 * Resolve every pending generation and write the results into their clips.
 *
 * Never throws. A generation that refuses is recorded ON the node as a `failed`
 * state by the resolver, which is a thing the graph can show; throwing would
 * leave the surface that invoked this with no way back to idle, and the reason
 * would live only in a console.
 */
export async function cookMotionGenerations(
  /**
   * Cook only this producer. Omit to cook the whole graph.
   *
   * 🔴 THE PER-NODE BUTTON MUST PASS IT (#964). The affordance lives on the node
   * because — as this file's neighbour says — "a global cook-everything button
   * would make a director's money a property of the scene rather than of the
   * node they are looking at". The button was on the node and the spend was on
   * the scene: measured at two paid calls for one press, the second regenerating
   * a clip that was up to date, non-deterministically, over motion the director
   * had accepted.
   */
  producerId?: string,
): Promise<CookOutcome> {
  let capability;
  try {
    capability = await getMotionCapability();
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report('motion generation', reason);
    return { generated: 0, failed: 0, baked: 0, reason };
  }

  // Read the state fresh at each step rather than once: the resolver awaits, and
  // a director can edit the graph while a several-second call is out. Baking a
  // state captured before the await would write into a graph that has moved.
  const resolutions = await resolvePendingMotionGenerations(
    useDagStore.getState().state,
    capability,
    producerId,
  );

  const ops = bakeGeneratedClipOps(useDagStore.getState().state);
  const baked = ops.filter((o) => o.type === 'setParam' && o.paramPath === 'sourceHash').length;
  if (ops.length > 0) {
    useDagStore
      .getState()
      .dispatchAtomic(ops, 'user', `cook motion: ${baked} clip${baked === 1 ? '' : 's'}`);
  }

  const state = useDagStore.getState().state;

  // Hold the bytes so a cooked clip can be SAVED (#819). This is the only place
  // they exist: the content store keeps parsed keyframes, and nothing can turn
  // those back into a file. Recorded AFTER the dispatch, so a cook that failed to
  // land never leaves an offer to save something that is not in the scene.
  //
  // Keyed to the SINK clip rather than the producer, because the sink is what a
  // director sees and what the save road writes out.
  const sinkOf = new Map(clipBakeStates(state).map((c) => [c.producerId, c.clipId]));
  for (const r of resolutions) {
    if (r.outcome !== 'generated' || r.bvh === undefined) continue;
    const clipId = sinkOf.get(r.nodeId);
    if (!clipId) continue;
    const params = state.nodes[clipId]?.params as { name?: string } | undefined;
    useGeneratedMotionStore.getState().record({
      clipId,
      name: params?.name ?? '',
      bvh: r.bvh,
      model: r.model ?? '',
    });
  }

  for (const r of resolutions) {
    if (r.outcome === 'failed' && r.reason) {
      useAssetErrorStore.getState().report('motion generation', r.reason);
    }
  }

  return {
    generated: resolutions.filter((r) => r.outcome === 'generated').length,
    failed: resolutions.filter((r) => r.outcome === 'failed').length,
    baked,
  };
}

/**
 * Move every cooked character to the start of the path it walks.
 *
 * 🔴 SEPARATE FROM THE COOK, AND THE SEQUENCE IS WHY. Placement needs the clip
 * already bound to a character rig — that is how it finds the node that owns
 * where the thing stands. On a FIRST generation the bind has not happened yet
 * when the cook returns, so a cook that placed would refuse, and report a
 * refusal for a state that is merely early rather than wrong. The imperative
 * road drew the same line: the character the BIND just chose is the thing to
 * move, so placement follows the bind rather than the generation.
 *
 * Safe to call whenever, including twice: the target is absolute, so a second
 * call writes the same position rather than walking the character further.
 *
 * Returns how many characters moved.
 */
export function placeCookedMotion(): number {
  const { ops, refusals } = placeCookedMotionOps(useDagStore.getState().state);
  if (ops.length > 0) {
    useDagStore.getState().dispatchAtomic(ops, 'user', 'place motion on path');
  }
  for (const r of refusals) {
    // Reported, never swallowed: the motion plays correctly and only its
    // POSITION is wrong, which is the failure that looks like success.
    useAssetErrorStore.getState().report('motion placement', r.reason);
  }
  return ops.length;
}

/** What the inspector's cook affordance should say and whether it is live. */
export interface MotionCookOffer {
  readonly label: string;
  readonly disabled: boolean;
  /** `ready` | `pending` | `failed`, or null when the node has no clip wired. */
  readonly status: string | null;
  /** True when the clip's keys are behind the producer's current request. */
  readonly stale: boolean;
  /**
   * Bones on this producer's character whose edited channel is still playing the
   * motion a PREVIOUS cook produced (#1001), sorted by name.
   *
   * 🔴 IT BELONGS HERE, BESIDE THE BUTTON THAT CAUSES IT. The cook is the gesture
   * that strands them: the clip refreshes, every untouched bone follows it, and
   * every bone the director edited keeps the old motion. A moment later this
   * affordance says "Up to date" — true of the clip, false of the character — so
   * without this the one surface a director is looking at is the surface that
   * lies to them. `stale` and this are opposite halves of the same word: `stale`
   * is the clip behind its request, this is the channels behind the clip.
   *
   * Empty is the ordinary case and must stay quiet. A director who edited no
   * bones can never see it, which is what keeps it from becoming the alarm on a
   * healthy bind that #923 had to remove.
   */
  readonly stranded: readonly StrandedBone[];
}

/**
 * One bone left behind by a cook, and every channel an action would remove to
 * put it back on the clip (#1002).
 *
 * The name is deduplicated across the characters this clip drives, because a
 * director reading the card recognises `LeftArm` once; the targets are not,
 * because two characters carry two channels under that one name and an action
 * that removed only one would leave the card saying exactly what it said before.
 */
export interface StrandedBone {
  /** What the director reads. Unique within an offer, sorted. */
  readonly childName: string;
  /** Every channel behind the clip under that name — per character, per
   *  component. Never empty: a bone with no stale channel is not stranded.
   *
   *  WHOLE addresses, `childName` repeated on each, so a surface hands them
   *  straight to the act. Reassembling them in JSX would put the last step of
   *  "which channel" in the one place this project cannot write a row against. */
  readonly targets: readonly {
    readonly assetRef: string;
    readonly childName: string;
    readonly component: BakedComponent;
  }[];
}

/**
 * The cook affordance's state for one producer node.
 *
 * A PURE function of the graph rather than a piece of the component, because
 * this project has no React Testing Library — a decision that lives in JSX is a
 * decision no row can reach. Same reason `motionSaveOffer` is a function.
 *
 * Scoped to ONE node, so the inspector never pays the whole-graph cost the
 * warning on `hasStaleGenerations` is about.
 */
export function motionCookOffer(state: DagState, producerId: string): MotionCookOffer {
  const row = clipBakeStates(state).find((c) => c.producerId === producerId);
  if (!row) {
    // A producer with no clip wired cannot be cooked into anything. Said out
    // loud rather than shown as a live button that would silently do nothing.
    return {
      label: 'No clip wired',
      disabled: true,
      status: null,
      stale: false,
      stranded: [],
    };
  }
  const stranded = strandedBonesForClip(state, row.clipId);
  if (row.status === 'failed') {
    return {
      label: 'Retry generation',
      disabled: false,
      status: row.status,
      stale: row.stale,
      stranded,
    };
  }
  if (!row.stale) {
    return { label: 'Up to date', disabled: true, status: row.status, stale: false, stranded };
  }
  // Stale AND already baked is the drag: the clip keeps playing its last result,
  // and the label says the inputs moved rather than offering a bare "Generate"
  // that hides the fact there is something to lose.
  if (row.baked) {
    return {
      label: 'Re-cook (inputs changed)',
      disabled: false,
      status: row.status,
      stale: true,
      stranded,
    };
  }
  return { label: 'Generate', disabled: false, status: row.status, stale: true, stranded };
}

/**
 * The bones left behind on old motion across every character this clip drives,
 * each carrying the channels an action would have to remove.
 *
 * Asked of the GRAPH rather than of a cook's return value, for the reason
 * `riggedSkeletonsForClip` states: a re-cook has no bind result in hand, and the
 * graph still knows.
 *
 * 🔴 THE NAME IS WHAT A DIRECTOR READS AND THE ADDRESS IS WHAT AN ACTION NEEDS,
 * AND THEY ARE NOT THE SAME COUNT (#1002). So the name is deduplicated for the
 * message and every target is kept underneath it.
 *
 * The reachable-and-gated half of that is the COMPONENT split below. The other
 * half is the character: `riggedSkeletonsForClip` returns a SET — measured, it
 * returns both rigs when a second character retargets the same clip — so one
 * name can stand for channels on two characters, and an action driven by the
 * deduplicated name would fix one and leave the other warned with the same
 * sentence still on the card. ⚠️ THAT SECOND HALF IS NOT GATED HERE: the row
 * needs a `RetargetClip` with real source and target bone tables, which is a
 * fixture of its own. It is stated as the reason the shape is a LIST, not as a
 * claim this file proves.
 *
 * 🔴 AND PER COMPONENT, NOT PER BONE. Measured over two real cooks of the same
 * character: 9 bones of 78 come back with their POSITION track unchanged and
 * their ROTATION track moved — 77 of 78 bones carry a constant position track,
 * so that is the ordinary case rather than the exotic one. Those position
 * channels are `current`: the clip has not moved under them and the director's
 * edit is still driving. Removing them along with the bone would discard a live
 * edit nobody was warned about, which is a worse failure than the one this
 * whole band exists to report.
 */
function strandedBonesForClip(state: DagState, clipId: string): StrandedBone[] {
  const byName = new Map<
    string,
    { assetRef: string; childName: string; component: BakedComponent }[]
  >();
  for (const skeletonId of riggedSkeletonsForClip(state.nodes, clipId)) {
    const assetRef = assetRefOfSkeleton(state.nodes, skeletonId);
    if (!assetRef) continue;
    for (const row of channelSeedRows(state, assetRef)) {
      if (row.state !== 'stale') continue;
      const bucket = byName.get(row.childName);
      const target = { assetRef, childName: row.childName, component: row.component };
      if (bucket) bucket.push(target);
      else byName.set(row.childName, [target]);
    }
  }
  return [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([childName, targets]) => ({ childName, targets }));
}
