// UI → Mutator dispatch seam (Phase 7, Wave A).
//
// THE single spine D-05 mandates: a UI gesture (a diamond click, an
// Auto-Key param edit) reaches the DAG through the SAME
// `validatePlan → useDiffStore.propose → acceptSelectedOps →
// dispatchAtomic` chain the agent uses. This is a NEW CALLER of that
// chain — NOT a parallel DAG-mutation path, NOT a bare `addNode` emitter.
//
// Interface depth (Ousterhout): the exported functions take a spec in
// and return applied-or-rejected out. Every Mutator internal
// (getMutator, safeParse, validatePlan, fork-evolve, propose,
// acceptSelectedOps) lives BEHIND this boundary. No ops / closure / fork
// / diff types leak into any exported signature — React components call
// one function and never see the agent layer.
//
// V13 (closure preservation): each propose() is passed the
// Mutator-declared `result.closure.spec` explicitly (mirrors
// orchestrator.ts:457 — the Mutator-declared closure takes precedence
// over any selection-inferred fallback). A1 pre-mortem.
//
// REF: .planning/phases/07-animation-authoring/PLAN.md Wave A;
//      THESIS.md §767/§123 (single spine); vyapti V13.

import { getMutator } from '../../agent/mutators/catalog';
import { validatePlan } from '../../agent/mutators/validate';
import { useDiffStore, acceptSelectedOps } from '../../agent/diff/store';
import { createFork } from '../../agent/diff/forkedDag';
import { useDagStore } from '../../core/dag/store';
import { gltfChannelDagId } from '../../core/import/gltfImportChain';
import type { ClosureSpec } from '../../agent/closure/types';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';

export type DispatchResult = { ok: true } | { ok: false; reason: string };

/**
 * Union two Mutator-declared closure specs. Replicates the orchestrator's
 * multi-Mutator closure threading (orchestrator.ts:882 unionClosureSpecs)
 * byte-for-byte — do NOT invent a different combination rule (A2 hard
 * constraint). Used to thread the combined closure of the first-key
 * composite (addLayer + addChannel + keyframe) into a single propose().
 */
function unionClosureSpecs(a: ClosureSpec, b: ClosureSpec): ClosureSpec {
  return {
    rootSelectors: Array.from(new Set([...a.rootSelectors, ...b.rootSelectors])),
    followedEdges: Array.from(
      new Set([...a.followedEdges, ...b.followedEdges]),
    ) as ClosureSpec['followedEdges'],
    maxDepth: a.maxDepth ?? b.maxDepth,
  };
}

/**
 * Validate ONE Mutator (catalog name + spec) and, on success, propose +
 * immediately accept the ops as a single atomic undo entry.
 *
 * Auto-accept rationale (RESEARCH U3 — PLANNER DECISION): a direct
 * manipulation gesture is not an agent proposal. Blender `I` lands the
 * key instantly. We still run propose() so the V13 closure gate fires
 * with the Mutator-declared spec; only the human DiffBar review step —
 * wrong for direct manipulation — is skipped.
 *
 * Spec shape, closure scope, ops, the fork, the diff store: all hidden.
 * Caller sees `{ ok:true }` or `{ ok:false, reason }`.
 */
export function dispatchMutatorFromUI(
  mutatorName: string,
  spec: unknown,
  intent: string,
): DispatchResult {
  // 1 — node_existence (gate 1, mirror tool.ts:81): unknown name → reject.
  const mutator = getMutator(mutatorName);
  if (!mutator) {
    return {
      ok: false,
      reason: `Unknown mutator "${mutatorName}".`,
    };
  }

  // 2 — param_schema at the boundary (gate 2, mirror tool.ts:93).
  const parsed = mutator.spec.safeParse(spec);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Mutator spec failed schema validation: ${parsed.error.message}`,
    };
  }

  // 3 — the five gates (validate.ts:46) against the LIVE DAG state.
  const state = useDagStore.getState().state;
  const result = validatePlan(mutator, parsed.data, state, intent);

  // 4 — reject: leave the DAG byte-unchanged. NO mutation.
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  // 5 — propose with the MUTATOR-DECLARED closure spec (V13; A1
  //     pre-mortem — never the selection-inferred fallback), then
  //     IMMEDIATELY accept → one dispatchAtomic → one Cmd+Z entry.
  return proposeAndAccept(
    state,
    result.ops,
    intent,
    [`user:${mutatorName}`],
    result.closure.spec,
    result.warnings,
  );
}

/** Shared propose → acceptSelectedOps tail. One atomic undo entry. */
function proposeAndAccept(
  baseState: DagState,
  ops: Op[],
  intent: string,
  opSources: string[],
  closureSpec: ClosureSpec,
  warnings: string[],
): DispatchResult {
  try {
    useDiffStore.getState().propose(baseState, ops, intent, opSources, closureSpec, warnings);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const dag = useDagStore.getState();
  acceptSelectedOps(dag.dispatchAtomic.bind(dag));
  return { ok: true };
}

export interface RetimeKeyframeArgs {
  /** The KeyframeChannel node whose sample is being retimed. */
  channelId: string;
  /**
   * The EXACT stored sample time (seconds) to move FROM. The caller
   * (TimelineCanvas pointerdown) reads this verbatim off the live DAG
   * sample — NOT a pointerup-recomputed seconds — so the exact `===`
   * compare here matches what removeKeyframes' `k.time !== fromTime`
   * filter (removeKeyframes.ts:124) will also match (D-03 / #60: ONE
   * honest discriminator, reused — no second equality rule).
   */
  fromTime: number;
  /** The sub-frame second to move TO (free seconds, D-02). */
  toTime: number;
}

/**
 * Retime composite (D-W9-7 / Phase 7.1): `removeKeyframes({scope:{time:
 * fromTime}})` → `keyframe({time:toTime,value,easing})` as ONE atomic
 * undo entry. This is a 2-Mutator PARAMETERIZATION of the existing
 * composite model (dispatchFirstKeyComposite) — NOT a new Mutator
 * (D-01). The original sample's `value` AND `easing` are captured from
 * the live DAG BEFORE the remove and passed explicitly into the
 * `keyframe` spec so the channel's per-type default-easing fallthrough
 * (keyframe.ts:105) does NOT silently change the easing (D-01
 * pre-mortem — losing easing on retime is the named defect).
 *
 * D-03 collision (last-wins) falls out of keyframe.ts:110's existing
 * replace-at-time against the post-remove fork — no new collision code.
 * Any validate `!ok` → abort, mutate nothing (mirrors
 * dispatchFirstKeyComposite's abort discipline; V13 closure gate fires).
 */
export function dispatchRetimeKeyframe(args: RetimeKeyframeArgs): DispatchResult {
  const { channelId, fromTime, toTime } = args;
  const intent = `Retime keyframe on ${channelId}`;

  const base = useDagStore.getState().state;

  // 1 — locate the sample at fromTime using the SAME exact compare the
  //     Mutators use (removeKeyframes.ts:124 / keyframe.ts:110). fromTime
  //     is the exact stored float (caller read it off the live sample),
  //     so this matches by construction — no new equality rule (D-03).
  const channel = base.nodes[channelId];
  if (!channel) {
    return { ok: false, reason: `channelId "${channelId}" not in DAG.` };
  }
  const params = (channel.params ?? {}) as {
    keyframes?: Array<{ time: number; value: unknown; easing: 'linear' | 'cubic' }>;
  };
  const sample = (params.keyframes ?? []).find((k) => k.time === fromTime);
  if (!sample) {
    return { ok: false, reason: `no keyframe at fromTime ${fromTime}` };
  }

  // 2 — capture value + easing BEFORE anything else (D-01 pre-mortem).
  const value = sample.value;
  const easing = sample.easing;

  const removeKeyframes = getMutator('mutator.timeline.removeKeyframes');
  const keyframe = getMutator('mutator.timeline.keyframe');
  if (!removeKeyframes || !keyframe) {
    return {
      ok: false,
      reason: 'Timeline Mutators not registered (removeKeyframes / keyframe).',
    };
  }

  // 3 — validate removeKeyframes({scope:{time:fromTime}}) vs base.
  const rParsed = removeKeyframes.spec.safeParse({
    channelId,
    scope: { time: fromTime },
  });
  if (!rParsed.success) {
    return {
      ok: false,
      reason: `removeKeyframes spec invalid: ${rParsed.error.message}`,
    };
  }
  const rResult = validatePlan(removeKeyframes, rParsed.data, base, intent);
  if (!rResult.ok) {
    return { ok: false, reason: `removeKeyframes rejected: ${rResult.reason}` };
  }

  // 4 — fork1 = base + removeKeyframes ops.
  let fork1: DagState;
  try {
    fork1 = createFork(base, rResult.ops).fork;
  } catch (err) {
    return {
      ok: false,
      reason: `removeKeyframes fork failed: ${(err as Error).message}`,
    };
  }

  // 5 — validate keyframe({time:toTime,value,easing}) vs the FORKED
  //     post-remove state (so D-03 last-wins lands via keyframe.ts:110's
  //     existing replace-at-time against the post-remove occupant).
  const kParsed = keyframe.spec.safeParse({
    channelId,
    time: toTime,
    value,
    easing,
  });
  if (!kParsed.success) {
    return { ok: false, reason: `keyframe spec invalid: ${kParsed.error.message}` };
  }
  const kResult = validatePlan(keyframe, kParsed.data, fork1, intent);
  if (!kResult.ok) {
    return { ok: false, reason: `keyframe rejected: ${kResult.reason}` };
  }

  // 6 — propose ALL ops as ONE diff with the COMBINED closure (union of
  //     the two Mutators' declared closure specs — reuse the existing
  //     helper, do not invent), then accept → one Cmd+Z entry.
  const combinedClosure = unionClosureSpecs(rResult.closure.spec, kResult.closure.spec);
  return proposeAndAccept(
    base,
    [...rResult.ops, ...kResult.ops],
    intent,
    ['user:mutator.timeline.removeKeyframes', 'user:mutator.timeline.keyframe'],
    combinedClosure,
    [...rResult.warnings, ...kResult.warnings],
  );
}

export interface BakeThenRetimeArgs {
  /** The owning GltfAsset's assetRef. */
  assetRef: string;
  /** The bone's childName (the clip-track key). */
  childName: string;
  /** Which TRS component row was dragged (position/rotation/scale). */
  component: 'position' | 'rotation' | 'scale';
  /** The clip keyframe time the drag started FROM (exact, read off the clip). */
  fromTime: number;
  /** The sub-frame second to move the key TO. */
  toTime: number;
}

/**
 * Copy-on-write composite (Phase 7.12 / D2): the FIRST timeline edit of a
 * clip-backed bone BAKES the bone's clip track into editable KeyframeChannel
 * nodes (D1's `mutator.timeline.bakeGltfChannel`) and THEN retimes the dragged
 * key on the now-real baked channel — both as ONE atomic undo entry (K6).
 *
 * Mirrors dispatchFirstKeyComposite's fork-evolve discipline: bake validates
 * against the base; the retime (removeKeyframes → keyframe) validates against the
 * FORKED post-bake state (the baked channel only exists in the fork). The baked
 * channel id is DETERMINISTIC (D1 / gltfChannelDagId), so the retime references
 * it without an intervening DAG round-trip. All ops are proposed in ONE diff →
 * one dispatchAtomic → one Cmd+Z reverts BOTH the bake and the edit.
 *
 * Any validate `!ok` → abort, mutate nothing (V13 closure gate fires per step).
 */
export function dispatchBakeThenRetime(args: BakeThenRetimeArgs): DispatchResult {
  const { assetRef, childName, component, fromTime, toTime } = args;
  const intent = `Edit imported clip: ${childName}.${component}`;

  const base = useDagStore.getState().state;

  const bake = getMutator('mutator.timeline.bakeGltfChannel');
  const removeKeyframes = getMutator('mutator.timeline.removeKeyframes');
  const keyframe = getMutator('mutator.timeline.keyframe');
  if (!bake || !removeKeyframes || !keyframe) {
    return {
      ok: false,
      reason: 'Timeline Mutators not registered (bakeGltfChannel / removeKeyframes / keyframe).',
    };
  }

  // 1 — validate the bake against the base DAG.
  const bParsed = bake.spec.safeParse({ assetRef, childName });
  if (!bParsed.success) {
    return { ok: false, reason: `bakeGltfChannel spec invalid: ${bParsed.error.message}` };
  }
  const bResult = validatePlan(bake, bParsed.data, base, intent);
  if (!bResult.ok) {
    return { ok: false, reason: `bakeGltfChannel rejected: ${bResult.reason}` };
  }

  // 2 — fork1 = base + bake ops (the baked channels now exist in the fork).
  let fork1: DagState;
  try {
    fork1 = createFork(base, bResult.ops).fork;
  } catch (err) {
    return { ok: false, reason: `bake fork failed: ${(err as Error).message}` };
  }

  // 3 — the dragged component's baked channel id (deterministic, D1).
  const channelId = gltfChannelDagId(assetRef, childName, component);
  const channel = fork1.nodes[channelId];
  if (!channel) {
    return { ok: false, reason: `baked channel "${channelId}" missing after bake.` };
  }
  // Read the sample at fromTime off the FORKED baked channel — its keyframes
  // were seeded from the clip at the clip times, so the dragged key exists.
  const cParams = (channel.params ?? {}) as {
    keyframes?: Array<{ time: number; value: unknown; easing: 'linear' | 'cubic' }>;
  };
  const sample = (cParams.keyframes ?? []).find((k) => k.time === fromTime);
  if (!sample) {
    return { ok: false, reason: `no baked keyframe at fromTime ${fromTime} on ${channelId}.` };
  }
  const value = sample.value;
  const easing = sample.easing;

  // 4 — validate removeKeyframes({time:fromTime}) against fork1.
  const rParsed = removeKeyframes.spec.safeParse({ channelId, scope: { time: fromTime } });
  if (!rParsed.success) {
    return { ok: false, reason: `removeKeyframes spec invalid: ${rParsed.error.message}` };
  }
  const rResult = validatePlan(removeKeyframes, rParsed.data, fork1, intent);
  if (!rResult.ok) {
    return { ok: false, reason: `removeKeyframes rejected: ${rResult.reason}` };
  }

  // 5 — fork2 = fork1 + removeKeyframes ops.
  let fork2: DagState;
  try {
    fork2 = createFork(fork1, rResult.ops).fork;
  } catch (err) {
    return { ok: false, reason: `removeKeyframes fork failed: ${(err as Error).message}` };
  }

  // 6 — validate keyframe({time:toTime,value,easing}) against fork2.
  const kParsed = keyframe.spec.safeParse({ channelId, time: toTime, value, easing });
  if (!kParsed.success) {
    return { ok: false, reason: `keyframe spec invalid: ${kParsed.error.message}` };
  }
  const kResult = validatePlan(keyframe, kParsed.data, fork2, intent);
  if (!kResult.ok) {
    return { ok: false, reason: `keyframe rejected: ${kResult.reason}` };
  }

  // 7 — propose ALL ops (bake + remove + keyframe) as ONE diff with the COMBINED
  //     closure, then accept → one dispatchAtomic → one Cmd+Z (K6).
  const combinedClosure = unionClosureSpecs(
    unionClosureSpecs(bResult.closure.spec, rResult.closure.spec),
    kResult.closure.spec,
  );
  return proposeAndAccept(
    base,
    [...bResult.ops, ...rResult.ops, ...kResult.ops],
    intent,
    [
      'user:mutator.timeline.bakeGltfChannel',
      'user:mutator.timeline.removeKeyframes',
      'user:mutator.timeline.keyframe',
    ],
    combinedClosure,
    [...bResult.warnings, ...rResult.warnings, ...kResult.warnings],
  );
}

export interface RevertGltfChannelArgs {
  /** The owning GltfAsset's assetRef. */
  assetRef: string;
  /** The bone's childName. */
  childName: string;
}

/**
 * Revert a baked glTF bone to its imported clip (Phase 7.12 / D3). Structural,
 * NOT value-equality (R-4): DELETE the bone's baked KeyframeChannel node(s) →
 * the resolver's presence-based pick (resolveGltfChildTrs) finds no bakedChannel
 * present → falls through to the clip on BOTH the renderer (C2) AND the
 * read-side (C3). The clip was never deleted (D-02 coexist), so revert is
 * lossless. ONE atomic deleteNode op set = ONE undo (mirrors the import chain's
 * K6 atomicity).
 *
 * The baked-channel ids are deterministic (D1 / gltfChannelDagId), so the
 * targets are known without a scan — we only delete the ones that actually
 * exist in the DAG (a bone may carry 1–3 component channels). No-op (ok, zero
 * ops) when the bone has no baked channels (already on the clip).
 */
export function dispatchRevertGltfChannel(args: RevertGltfChannelArgs): DispatchResult {
  const { assetRef, childName } = args;
  const base = useDagStore.getState().state;

  // Collect the deterministic baked-channel ids that EXIST for this bone.
  const targets = (['position', 'rotation', 'scale'] as const)
    .map((component) => gltfChannelDagId(assetRef, childName, component))
    .filter((id) => base.nodes[id]);

  // Nothing baked → already on the clip; revert is a no-op (not an error).
  if (targets.length === 0) return { ok: true };

  return dispatchMutatorFromUI(
    'mutator.deleteNode',
    { targetSelectors: targets },
    `Revert ${childName} to imported clip`,
  );
}

export interface FirstKeyCompositeArgs {
  /** The SceneChild node whose param is being animated (e.g. n_box). */
  targetId: string;
  /** Param path on the target — 'position', 'rotation', 'material.color'. */
  paramPath: string;
  /** The first sample's value (vec3 for position/rotation). */
  value: unknown;
  /** Playhead in SECONDS (NEVER a frame — single conversion rule). */
  seconds: number;
}

/**
 * Sanitize a paramPath into an id fragment EXACTLY as
 * addChannel.ts:180 defaultChannelId does (`[^a-zA-Z0-9_-]` → `_`).
 * Byte-for-byte match is load-bearing: the deterministic channelId we
 * compute here must equal the id addChannel's build() would derive, so
 * the subsequent keyframe op targets the channel that actually lands
 * (A2 pre-mortem).
 */
function safePath(paramPath: string): string {
  return paramPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Map a paramPath + value to the addChannel valueType enum. The
 * inspector passes the actual current param value so the shape is
 * authoritative: a number → scalar, a string → color, a 3-tuple →
 * vec3, a 4-tuple → quat.
 */
function inferValueType(value: unknown): 'number' | 'vec3' | 'quat' | 'color' | null {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'color';
  if (Array.isArray(value)) {
    if (value.length === 3 && value.every((x) => typeof x === 'number')) {
      return 'vec3';
    }
    if (value.length === 4 && value.every((x) => typeof x === 'number')) {
      return 'quat';
    }
  }
  return null;
}

/**
 * First-key composite: addLayer → addChannel → keyframe as ONE atomic
 * undo entry, via the fork-evolve sequence the orchestrator uses for
 * multi-round op accumulation (orchestrator.ts:288 createFork mechanism;
 * :882 unionClosureSpecs — replicated above, not invented).
 *
 * addChannel MUST validate against addLayer's FORKED state (its closure
 * roots on the layer id that does not exist in the base DAG yet);
 * keyframe MUST validate against the twice-forked state. Deterministic
 * ids are derived to match addLayer.ts:131 (`${target}_layer`) /
 * addChannel.ts:181 (`${target}_${safe}_channel`) byte-for-byte so each
 * later Mutator can reference the earlier one's product without a DAG
 * round-trip (RESEARCH Boundary 1; A2 pre-mortem).
 *
 * The composite `addLayer` performs the full consumer rewire
 * (addLayer.ts:95-123) — that is the H34 orphan fix; it is NOT
 * reimplemented here. Any validate `!ok` → abort, mutate nothing.
 */
export function dispatchFirstKeyComposite(args: FirstKeyCompositeArgs): DispatchResult {
  const { targetId, paramPath, value, seconds } = args;
  const intent = `Animate ${targetId}.${paramPath}`;

  const base = useDagStore.getState().state;

  // 1 — deterministic channel id (mirror addChannel.ts:181). The LAYER id is
  //     resolved below: reuse the layer already wrapping the target if one
  //     exists, else mint the deterministic `${target}_layer`. #149 — keying a
  //     SECOND band on an already-wrapped target (the whole-transform K, or any
  //     later diamond key) must ADD a channel to the existing layer, NOT addLayer
  //     a duplicate (addLayer mints a new node id → collision; addLayer also only
  //     reuses-vs-rejects on wrapping-a-wrapper). One layer per target.
  const channelId = `${targetId}_${safePath(paramPath)}_channel`;
  const existingLayerId = ((): string | null => {
    for (const node of Object.values(base.nodes)) {
      if (node.type !== 'AnimationLayer') continue;
      const tb = (node.inputs ?? {}).target as unknown;
      const refs = Array.isArray(tb) ? tb : tb ? [tb] : [];
      if (refs.some((r) => (r as { node?: string } | undefined)?.node === targetId)) {
        return node.id;
      }
    }
    return null;
  })();
  const layerId = existingLayerId ?? `${targetId}_layer`;

  const addLayer = getMutator('mutator.timeline.addLayer');
  const addChannel = getMutator('mutator.timeline.addChannel');
  const keyframe = getMutator('mutator.timeline.keyframe');
  if (!addLayer || !addChannel || !keyframe) {
    return {
      ok: false,
      reason: 'Timeline Mutators not registered (addLayer / addChannel / keyframe).',
    };
  }

  // 2 — validate addLayer against the base DAG — ONLY when the target is not yet
  //     wrapped. When reusing an existing layer, addLayer is skipped entirely
  //     (empty ops / closure) so addChannel validates against base directly.
  let lOps: Op[] = [];
  let lClosureSpec: ReturnType<typeof unionClosureSpecs> | null = null;
  let lWarnings: string[] = [];
  let lLabels: string[] = [];
  if (!existingLayerId) {
    const lParsed = addLayer.spec.safeParse({
      targetSelectors: [targetId],
      layerName: 'Layer',
      layerIds: [layerId],
    });
    if (!lParsed.success) {
      return { ok: false, reason: `addLayer spec invalid: ${lParsed.error.message}` };
    }
    const lResult = validatePlan(addLayer, lParsed.data, base, intent);
    if (!lResult.ok) {
      return { ok: false, reason: `addLayer rejected: ${lResult.reason}` };
    }
    lOps = lResult.ops;
    lClosureSpec = lResult.closure.spec;
    lWarnings = lResult.warnings;
    lLabels = ['user:mutator.timeline.addLayer'];
  }

  // 3 — fork1 = base + addLayer ops (orchestrator.ts:288 mechanism). When the
  //     layer is reused, lOps is empty → fork1 === base content.
  let fork1: DagState;
  try {
    fork1 = createFork(base, lOps).fork;
  } catch (err) {
    return { ok: false, reason: `addLayer fork failed: ${(err as Error).message}` };
  }

  // 4 — validate addChannel against the FORKED state (its closure roots
  //     on the layer id — freshly created OR the reused existing one).
  const valueType = inferValueType(value);
  if (!valueType) {
    return {
      ok: false,
      reason: `Cannot infer channel valueType for paramPath "${paramPath}".`,
    };
  }
  const cParsed = addChannel.spec.safeParse({
    layerId,
    target: targetId,
    paramPath,
    valueType,
    channelId,
  });
  if (!cParsed.success) {
    return { ok: false, reason: `addChannel spec invalid: ${cParsed.error.message}` };
  }
  const cResult = validatePlan(addChannel, cParsed.data, fork1, intent);
  if (!cResult.ok) {
    return { ok: false, reason: `addChannel rejected: ${cResult.reason}` };
  }

  // 5 — fork2 = base + addLayer ops + addChannel ops.
  let fork2: DagState;
  try {
    fork2 = createFork(base, [...lOps, ...cResult.ops]).fork;
  } catch (err) {
    return { ok: false, reason: `addChannel fork failed: ${(err as Error).message}` };
  }

  // 6 — validate keyframe against the twice-forked state; time = SECONDS.
  const kParsed = keyframe.spec.safeParse({ channelId, time: seconds, value });
  if (!kParsed.success) {
    return { ok: false, reason: `keyframe spec invalid: ${kParsed.error.message}` };
  }
  const kResult = validatePlan(keyframe, kParsed.data, fork2, intent);
  if (!kResult.ok) {
    return { ok: false, reason: `keyframe rejected: ${kResult.reason}` };
  }

  // 7 — propose ALL ops as ONE diff with the COMBINED closure (union of the
  //     Mutators' declared closure specs — replicate the orchestrator's
  //     unionClosureSpecs, do not invent), then accept. When the layer was
  //     reused, the addLayer op set / closure / label are omitted.
  const channelKeyClosure = unionClosureSpecs(cResult.closure.spec, kResult.closure.spec);
  const combinedClosure = lClosureSpec
    ? unionClosureSpecs(lClosureSpec, channelKeyClosure)
    : channelKeyClosure;
  return proposeAndAccept(
    base,
    [...lOps, ...cResult.ops, ...kResult.ops],
    intent,
    [...lLabels, 'user:mutator.timeline.addChannel', 'user:mutator.timeline.keyframe'],
    combinedClosure,
    [...lWarnings, ...cResult.warnings, ...kResult.warnings],
  );
}
