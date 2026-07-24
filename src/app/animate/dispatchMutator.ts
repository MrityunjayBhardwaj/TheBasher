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
import {
  importComfyGraph,
  parseComfyParamPath,
  type ComfyApiJson,
  type ComfyGraphMeta,
  type ComfyValueKind,
} from '../../core/comfy/comfyGraph';
import {
  parseComfyControllerPath,
  scanBasherControllers,
  type BasherControllerKind,
} from '../../core/comfy/basherControllers';
import { bareChannelNodesForSubject } from '../nodeChannels';
import { linkedDataNodeId } from '../resolveDataParamOwner';
import { ActionChannelSchema, type ActionChannel } from '../../nodes/Action';
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
function inferValueType(value: unknown): 'number' | 'vec2' | 'vec3' | 'quat' | 'color' | null {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'color';
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((x) => typeof x === 'number')) {
      return 'vec2';
    }
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
/** Camera node types (#190). Wired into scene.camera, outside the AnimationLayer
 *  machinery — their channels target the camera node directly, no layer. */
function isCameraNodeType(type: string | undefined): boolean {
  return type === 'PerspectiveCamera' || type === 'OrthographicCamera';
}

/** GltfChild (#188). NOT a scene producer (no `out` socket, no scene edge), so it
 *  CANNOT be wrapped in an AnimationLayer — its material channels target the child
 *  dagId directly, exactly like a camera (the glTF direct-channel road, V57). */
function isGltfChildNodeType(type: string | undefined): boolean {
  return type === 'GltfChild';
}

/** The KeyframeChannel* node type + default easing for a value type. */
function channelNodeFor(valueType: 'number' | 'vec2' | 'vec3' | 'color' | 'quat'): {
  nodeType: string;
  easing: 'linear' | 'cubic';
} {
  switch (valueType) {
    case 'vec2':
      return { nodeType: 'KeyframeChannelVec2', easing: 'cubic' };
    case 'vec3':
      return { nodeType: 'KeyframeChannelVec3', easing: 'cubic' };
    case 'color':
      return { nodeType: 'KeyframeChannelColor', easing: 'cubic' };
    case 'quat':
      return { nodeType: 'KeyframeChannelQuat', easing: 'cubic' };
    default:
      return { nodeType: 'KeyframeChannelNumber', easing: 'linear' };
  }
}

/**
 * The DIRECT first-key (#190 camera, #188 glTF material) — ONE free-floating
 * channel targeting a node that sits OUTSIDE the AnimationLayer machinery (V20,
 * V57). A camera is wired via scene.camera; a GltfChild is not a scene producer —
 * neither can be wrapped by the addLayer+addChannel composite (the layer is
 * Mesh-typed and patchTarget clones a SceneChild). Instead create a SINGLE
 * KeyframeChannel* targeting the node, the first sample baked into params; the
 * resolver finds it by target scan (resolveActiveCameraPoseAt for the camera,
 * directChannelNodesForTarget / GltfAssetR's material useFrame for the child).
 * Subsequent keys flow through the EXISTING channel-id keyframe path (autoKey's
 * 'animated' branch), so only this first step is node-specific.
 *
 * Routed through the SAME propose→accept spine (one atomic undo entry, V13),
 * mirroring the composite's fresh-node closure-root pattern.
 *
 * @param allowed   the value types this surface can key (camera: number/vec3;
 *                  glTF material: number/color) — guards the unsupported case.
 */
function dispatchDirectFirstKey(
  args: FirstKeyCompositeArgs,
  base: DagState,
  opts: {
    allowed: readonly ('number' | 'vec2' | 'vec3' | 'color' | 'quat')[];
    intentTag: string;
    surface: string;
  },
): DispatchResult {
  const { targetId, paramPath, value, seconds } = args;
  const intent = `Animate ${targetId}.${paramPath}`;
  const valueType = inferValueType(value);
  if (!valueType || !opts.allowed.includes(valueType)) {
    return {
      ok: false,
      reason: `${opts.surface} param "${paramPath}" is not keyframe-able (expected ${opts.allowed.join(' or ')}).`,
    };
  }
  const { nodeType, easing } = channelNodeFor(valueType);
  const channelId = `${targetId}_${safePath(paramPath)}_channel`;
  // First-key only fires for an un-animated param, so the channel should not yet
  // exist; guard rather than emit a colliding addNode.
  if (base.nodes[channelId]) {
    return { ok: false, reason: `Channel "${channelId}" already exists.` };
  }
  const op: Op = {
    type: 'addNode',
    nodeId: channelId,
    nodeType,
    params: {
      name: paramPath,
      target: targetId,
      paramPath,
      keyframes: [{ time: seconds, value, easing }],
    },
  };
  const closureSpec: ClosureSpec = { rootSelectors: [channelId], followedEdges: [] };
  return proposeAndAccept(base, [op], intent, [opts.intentTag], closureSpec, []);
}

/** A ComfyUIWorkflow param's KeyframeChannel* type, dispatched EXPLICITLY by the
 *  manifest `valueKind` (design §7.1). This is the load-bearing difference from the
 *  native road: `inferValueType` maps a string → 'color' (KeyframeChannelColor),
 *  which is WRONG for a comfy prompt (it must be a STEP text channel). The compiler
 *  was deliberately not taught a 'text'/'image' JS-type guess, so the manifest's
 *  declared kind is the only honest source. Returns null for kinds that can't be a
 *  per-frame schedule (bool/enum — structural / non-schedulable). */
function comfyChannelNodeFor(
  kind: ComfyValueKind,
): { nodeType: string; easing: 'linear' | 'cubic' } | null {
  switch (kind) {
    case 'float':
    case 'int':
      return { nodeType: 'KeyframeChannelNumber', easing: 'linear' };
    case 'string':
      return { nodeType: 'KeyframeChannelText', easing: 'linear' };
    case 'image':
      return { nodeType: 'KeyframeChannelImage', easing: 'linear' };
    default:
      return null; // bool / enum — not a schedulable per-frame value
  }
}

/** The declared valueKind of one imported-graph param, or null if the node carries
 *  no graph / the param is no longer present. Derived (never stored) so it can't go
 *  stale against the json — the SAME importComfyGraph the decode read uses. */
function comfyParamValueKind(
  graphParam: unknown,
  nodeId: string,
  inputName: string,
): ComfyValueKind | null {
  const gp = graphParam as { apiJson?: ComfyApiJson; meta?: ComfyGraphMeta } | null | undefined;
  if (!gp?.apiJson) return null;
  const meta: ComfyGraphMeta = gp.meta ?? { name: 'workflow', importedAt: '', fps: 30, frames: 1 };
  const param = importComfyGraph(gp.apiJson, meta).params.find(
    (p) => p.nodeId === nodeId && p.inputName === inputName,
  );
  return param ? param.valueKind : null;
}

/**
 * The first-key for a ComfyUIWorkflow graph param (Inc 3 Slice D). A free-floating
 * channel targeting the ComfyUIWorkflow node directly (the post-#199 road, V57), the
 * channel TYPE chosen by the manifest `valueKind` — NOT inferValueType (string→color
 * would silently mis-type the prompt). The decode resolves the param at the playhead
 * via the render-identical resolveEvaluatedParam (H40), so an authored key shows in
 * the composite for free (Slice C read path). Subsequent keys flow through the
 * existing channel-id keyframe path (autoKey's 'animated' branch).
 */
function dispatchComfyFirstKey(
  args: FirstKeyCompositeArgs,
  base: DagState,
  parsed: { nodeId: string; inputName: string },
): DispatchResult {
  const { targetId, paramPath, value, seconds } = args;
  const intent = `Animate ${targetId}.${paramPath}`;
  const node = base.nodes[targetId];
  const kind = comfyParamValueKind(
    (node?.params as { graph?: unknown } | undefined)?.graph,
    parsed.nodeId,
    parsed.inputName,
  );
  if (!kind) {
    return { ok: false, reason: `ComfyUI param "${paramPath}" is not in the workflow.` };
  }
  const channel = comfyChannelNodeFor(kind);
  if (!channel) {
    return {
      ok: false,
      reason: `ComfyUI param "${paramPath}" (${kind}) can't be animated (structural / non-schedulable).`,
    };
  }
  const channelId = `${targetId}_${safePath(paramPath)}_channel`;
  if (base.nodes[channelId]) {
    return { ok: false, reason: `Channel "${channelId}" already exists.` };
  }
  // Coerce the first sample to the channel's stored shape: a number channel needs a
  // number; text/image need a string (the comfy literal already matches, this is
  // belt-and-suspenders against a stray string-typed numeric field).
  const sample = channel.nodeType === 'KeyframeChannelNumber' ? Number(value) : String(value);
  const op: Op = {
    type: 'addNode',
    nodeId: channelId,
    nodeType: channel.nodeType,
    params: {
      name: paramPath,
      target: targetId,
      paramPath,
      keyframes: [{ time: seconds, value: sample, easing: channel.easing }],
    },
  };
  const closureSpec: ClosureSpec = { rootSelectors: [channelId], followedEdges: [] };
  return proposeAndAccept(base, [op], intent, ['user:comfy.firstKey'], closureSpec, []);
}

/** A `basher_controller`'s KeyframeChannel* type, chosen EXPLICITLY by the controller's
 *  declared `kind` — the same H124 discipline as comfyChannelNodeFor (never infer from
 *  the value, which would mis-type a string as a colour). float/int → Number, string →
 *  Text. Returns null for kinds that aren't a keyframeable per-frame scalar (bool — a
 *  constant toggle; image/video — media binds, a later slice). */
function controllerChannelNodeFor(
  kind: BasherControllerKind,
): { nodeType: string; easing: 'linear' | 'cubic' } | null {
  switch (kind) {
    case 'float':
    case 'int':
      return { nodeType: 'KeyframeChannelNumber', easing: 'linear' };
    case 'string':
      return { nodeType: 'KeyframeChannelText', easing: 'linear' };
    default:
      return null; // bool / image / video — not a keyframeable scalar here
  }
}

/**
 * The first-key for a `basher_controller` (the two-node contract, Mode A). A
 * free-floating channel targeting the ComfyUIWorkflow node at paramPath
 * `controller:<nodeId>`, the channel TYPE chosen by the controller's DECLARED kind
 * (controllerChannelNodeFor — never inferValueType). The render bake + the decode read
 * the controller channel through the SAME resolveEvaluatedParam (H40), so an authored
 * key drives the coherent clip. Subsequent keys flow through the generic channel-id
 * path. Mirrors dispatchComfyFirstKey, but the kind comes from the declared controller,
 * not the inferred manifest.
 */
function dispatchControllerFirstKey(
  args: FirstKeyCompositeArgs,
  base: DagState,
  controllerNodeId: string,
): DispatchResult {
  const { targetId, paramPath, value, seconds } = args;
  const intent = `Animate ${targetId}.${paramPath}`;
  const node = base.nodes[targetId];
  const gp = (node?.params as { graph?: { apiJson?: ComfyApiJson } } | undefined)?.graph;
  if (!gp?.apiJson) return { ok: false, reason: `No workflow on "${targetId}".` };
  const decl = scanBasherControllers(gp.apiJson).find((d) => d.nodeId === controllerNodeId);
  if (!decl) {
    return { ok: false, reason: `Controller "${paramPath}" is not in the workflow.` };
  }
  const channel = controllerChannelNodeFor(decl.kind);
  if (!channel) {
    return {
      ok: false,
      reason: `Controller "${decl.name}" (${decl.kind}) can't be keyframed (not a scalar value).`,
    };
  }
  const channelId = `${targetId}_${safePath(paramPath)}_channel`;
  if (base.nodes[channelId]) {
    return { ok: false, reason: `Channel "${channelId}" already exists.` };
  }
  const sample = channel.nodeType === 'KeyframeChannelNumber' ? Number(value) : String(value);
  const op: Op = {
    type: 'addNode',
    nodeId: channelId,
    nodeType: channel.nodeType,
    params: {
      name: paramPath,
      target: targetId,
      paramPath,
      keyframes: [{ time: seconds, value: sample, easing: channel.easing }],
    },
  };
  const closureSpec: ClosureSpec = { rootSelectors: [channelId], followedEdges: [] };
  return proposeAndAccept(base, [op], intent, ['user:comfy.controllerFirstKey'], closureSpec, []);
}

export function dispatchFirstKeyComposite(args: FirstKeyCompositeArgs): DispatchResult {
  const { targetId, paramPath } = args;

  const base = useDagStore.getState().state;

  // The two-node contract (Mode A): a `controller:<nodeId>` paramPath on a
  // ComfyUIWorkflow target keys a free-floating channel whose TYPE is the declared
  // controller kind. Routed before the legacy comfy: param road below.
  const controllerNodeId = parseComfyControllerPath(paramPath);
  if (controllerNodeId && base.nodes[targetId]?.type === 'ComfyUIWorkflow') {
    return dispatchControllerFirstKey(args, base, controllerNodeId);
  }

  // Inc 3 Slice D — a ComfyUIWorkflow graph param (paramPath `comfy:<nodeId>.<input>`)
  // keys a free-floating channel whose TYPE is dispatched by the manifest valueKind,
  // NOT inferValueType (which would mis-type a string prompt as a colour). Routed
  // before the native road below; only fires for a ComfyUIWorkflow target.
  const comfyParsed = parseComfyParamPath(paramPath);
  if (comfyParsed && base.nodes[targetId]?.type === 'ComfyUIWorkflow') {
    return dispatchComfyFirstKey(args, base, comfyParsed);
  }

  // #190 — a camera is wired via scene.camera (a single Camera-typed ref), NOT
  // scene.children, so it sits OUTSIDE the AnimationLayer machinery. Its first
  // key is a single free-floating channel targeting the camera node, NOT the
  // addLayer composite (which would wrap the Camera in a Mesh-typed layer and
  // break selectActiveCameraNode). Same propose→accept spine, camera-specific
  // op set. Subsequent keys flow through the existing channel-id keyframe path.
  if (isCameraNodeType(base.nodes[targetId]?.type)) {
    return dispatchDirectFirstKey(args, base, {
      allowed: ['number', 'vec3'],
      intentTag: 'user:camera.firstKey',
      surface: 'Camera',
    });
  }

  // #188 — a GltfChild is NOT a scene producer (no `out` socket), so the addLayer
  // composite below can't wrap it. Its material channels (materials.<slot>.<lobe>.
  // <field>) target the child dagId directly — the SAME free-floating direct-channel
  // road as the camera (V57). number = a scalar lobe (metalness/roughness/…), color
  // = a hex lobe (base.color/emission.color).
  if (isGltfChildNodeType(base.nodes[targetId]?.type)) {
    return dispatchDirectFirstKey(args, base, {
      allowed: ['number', 'color'],
      intentTag: 'user:gltfMaterial.firstKey',
      surface: 'glTF material',
    });
  }

  // Native target. #199 (Phase 5) — a native mesh first-key mints a FREE-FLOATING
  // direct channel targeting the node's dagId (V57), the SAME road as the camera
  // (#190) and glTF material (#188). No AnimationLayer wrapper exists any more
  // (retired at load by migrateAnimationLayers): the channel is rendered by
  // DirectChannelsR and read by resolveEvaluatedTransform (#197), both via
  // overlayChannels.
  return dispatchDirectFirstKey(args, base, {
    allowed: ['number', 'vec2', 'vec3', 'color', 'quat'],
    intentTag: 'user:mesh.firstKey',
    surface: 'Mesh',
  });
}

// ── "Push down" (epic #283 Phase 5, inc 5E — UI-SPEC §2.7) ──────────────────

/** Bare KeyframeChannel* node type → the ActionChannelSchema discriminant
 *  (the exact inverse of layeredChannels' `channelNodeType`). A type outside
 *  this map has no Action-channel equivalent → refuse, never guess. */
const ACTION_VALUE_TYPE_BY_NODE: Record<string, ActionChannel['valueType']> = {
  KeyframeChannelNumber: 'number',
  KeyframeChannelVec2: 'vec2',
  KeyframeChannelVec3: 'vec3',
  KeyframeChannelQuat: 'quat',
  KeyframeChannelColor: 'color',
  KeyframeChannelText: 'text',
  KeyframeChannelImage: 'image',
};

export type PushDownChannelResult =
  | { ok: true; channel: ActionChannel }
  | { ok: false; reason: string };

/**
 * Map ONE bare channel node to an `ActionChannelSchema` spec (Action.ts:34-43):
 * strip `target`, keep paramPath/keyframes (times/values/easing/handles all
 * survive verbatim), add the `valueType` discriminant.
 *
 * HONESTY GUARD (H70 — refuse, never silently drop fidelity): the strip fold
 * OVERRIDES the per-channel identity/blend fields at enumeration
 * (`layeredChannels.ts` syntheticChannelValue sets mute:false, weight:influence,
 * blendMode:strip.blendMode, order:orderBase) and clamps sample time to the
 * placed span ('hold' forced, `layeredChannels.ts:96-103`) — so a channel
 * carrying a NON-DEFAULT value in any of those fields, a non-'hold' extend
 * mode, an F-Modifier stack, or per-axis data would render DIFFERENTLY after
 * push-down (outside the key span, or in the fold). Each refusal names the
 * channel so the director knows exactly what blocked the conversion.
 * Defaults are read with `??` — the schemas differ per value type (text/image
 * carry no extend/modifier fields), and an absent field IS its default.
 */
export function bareChannelToActionChannel(node: {
  id: string;
  type: string;
  params?: unknown;
}): PushDownChannelResult {
  const valueType = ACTION_VALUE_TYPE_BY_NODE[node.type];
  if (!valueType) {
    return {
      ok: false,
      reason: `channel "${node.id}" (${node.type}) has no Action-channel equivalent — cannot push down.`,
    };
  }
  const p = (node.params ?? {}) as Record<string, unknown>;
  const refuse = (what: string): PushDownChannelResult => ({
    ok: false,
    reason: `channel "${node.id}" ${what} — the strip placement cannot hold it losslessly; push down refused.`,
  });
  if ((p.mute ?? false) !== false) return refuse('is muted (a strip folds its channels live)');
  if ((p.weight ?? 1) !== 1)
    return refuse(
      `carries weight ${String(p.weight)} (the Strip's influence replaces per-channel weight)`,
    );
  if ((p.blendMode ?? 'replace') !== 'replace')
    return refuse(`carries blendMode "${String(p.blendMode)}" (the Strip's blendMode replaces it)`);
  if ((p.order ?? 0) !== 0)
    return refuse(`carries fold order ${String(p.order)} (the strip assigns its own fold order)`);
  if ((p.extendBefore ?? 'hold') !== 'hold' || (p.extendAfter ?? 'hold') !== 'hold')
    return refuse(
      `carries extrapolation "${String(p.extendBefore ?? 'hold')}"/"${String(p.extendAfter ?? 'hold')}" (a strip holds outside its placed span)`,
    );
  if (Array.isArray(p.modifiers) && p.modifiers.length > 0)
    return refuse(
      'carries an F-Modifier stack (modifiers sample raw time; a strip clamps time to its span)',
    );
  if (
    Array.isArray(p.axisModifiers) &&
    p.axisModifiers.some((a) => Array.isArray(a) && a.length > 0)
  )
    return refuse('carries per-axis modifiers (same span-clamp fidelity limit)');
  if (p.childName !== undefined || p.assetRef !== undefined)
    return refuse('is a baked glTF clip channel (the bake/revert lifecycle owns it)');

  const rest = { ...p };
  delete rest.target;
  const parsed = ActionChannelSchema.safeParse({ ...rest, valueType });
  if (!parsed.success) {
    return {
      ok: false,
      reason: `channel "${node.id}" does not fit ActionChannelSchema: ${parsed.error.message}`,
    };
  }
  return { ok: true, channel: parsed.data };
}

/** Next free `${base}_${n}` node id (the shotCreate.ts/createAction.ts discipline —
 *  copied, not coupled), so the composite can hand createAction an EXPLICIT
 *  actionId (createAction.ts:34-36) that addStrip references without a DAG
 *  round-trip. */
function nextFreshNodeId(prefix: string, state: DagState): string {
  let n = 1;
  while (state.nodes[`${prefix}_${n}`]) n++;
  return `${prefix}_${n}`;
}

/**
 * "Push down" composite (UI-SPEC §2.7 LOCKED mechanism; Blender's term): convert
 * `targetId`'s bare KeyframeChannel* nodes into ONE Action + ONE Strip placing it
 * back at the channels' min key time, and DELETE the bare channels — all as ONE
 * atomic undo entry. The fork-evolve discipline mirrors dispatchBakeThenRetime
 * (`:295-393`): createAction validates vs base; addStrip vs the fork (the Action
 * only exists there); deleteNode vs the twice-evolved fork; all ops proposed in
 * ONE diff with the UNIONED closure → one dispatchAtomic → one Cmd+Z.
 *
 * Why the channels MUST be deleted in the SAME entry: bare channels fold BELOW
 * strips (`layeredChannels.ts:224-226` concatenates bare first) — leaving them
 * would double-drive the params; deleting them in a SECOND dispatch would split
 * undo (half-revertable — the K21 violation).
 *
 * Why `start = min key time`: actStart == start makes the strip's time remap the
 * IDENTITY inside the key span, so render is byte-identical before/after (the
 * honesty guard above refuses everything that could differ outside the span).
 *
 * NOT a new mutator (V14/H36): assembles the shipped createAction / addStrip /
 * deleteNode vocabulary; registers nothing.
 */
export function dispatchPushDownToStrip(targetId: string): DispatchResult {
  const base = useDagStore.getState().state;
  const target = base.nodes[targetId];
  if (!target) return { ok: false, reason: `target "${targetId}" not in DAG.` };

  // 1 — the target's bare channels: the SAME enumerator the fold's bare seam
  //     consumes (layeredChannels.ts:224 → directChannelValuesForTarget wraps
  //     this exact predicate) — one predicate, no drift.
  //     #386 — INCLUDING the data half's. Post-split a light's intensity/colour channel
  //     targets its LightData while the user selects the Object, so an exact-id scan finds
  //     nothing and push-down refuses on a visibly animated light. The Strip still targets
  //     the OBJECT (a Strip carries one `target`, and V112 forbids a data-node strip lane).
  const bare = bareChannelNodesForSubject(base.nodes, targetId, linkedDataNodeId(base, targetId));
  if (bare.length === 0) {
    return { ok: false, reason: `"${targetId}" has no bare keyframe channels to push down.` };
  }

  // 2 — map each to an ActionChannel spec; REFUSE (naming the channel) on any
  //     state the placement cannot hold losslessly (H70).
  const channels: ActionChannel[] = [];
  let minKeyTime = Infinity;
  for (const node of bare) {
    const mapped = bareChannelToActionChannel(node);
    if (!mapped.ok) return mapped;
    channels.push(mapped.channel);
    for (const k of mapped.channel.keyframes) {
      if (k.time < minKeyTime) minKeyTime = k.time;
    }
  }
  if (minKeyTime === Infinity) {
    return { ok: false, reason: `"${targetId}"'s channels carry no keyframes to push down.` };
  }

  const createAction = getMutator('mutator.nla.createAction');
  const addStrip = getMutator('mutator.nla.addStrip');
  const deleteNode = getMutator('mutator.deleteNode');
  if (!createAction || !addStrip || !deleteNode) {
    return {
      ok: false,
      reason: 'Mutators not registered (nla.createAction / nla.addStrip / deleteNode).',
    };
  }

  const targetName = ((target.params ?? {}) as { name?: string }).name || targetId;
  const intent = `Push down ${targetName}'s channels to an NLA strip`;
  // EXPLICIT actionId (createAction.ts:34-36) so addStrip can reference the
  // Action without an intervening DAG round-trip.
  const actionId = nextFreshNodeId('nla_action', base);

  // 3 — validate createAction vs base.
  const aParsed = createAction.spec.safeParse({
    name: `${targetName} action`,
    actionId,
    channels,
  });
  if (!aParsed.success) {
    return { ok: false, reason: `createAction spec invalid: ${aParsed.error.message}` };
  }
  const aResult = validatePlan(createAction, aParsed.data, base, intent);
  if (!aResult.ok) return { ok: false, reason: `createAction rejected: ${aResult.reason}` };

  // 4 — fork1 = base + the Action; validate addStrip vs the fork (the Action
  //     only exists there). start = min key time (identity remap, see above).
  let fork1: DagState;
  try {
    fork1 = createFork(base, aResult.ops).fork;
  } catch (err) {
    return { ok: false, reason: `createAction fork failed: ${(err as Error).message}` };
  }
  const sParsed = addStrip.spec.safeParse({
    name: `${targetName} strip`,
    action: actionId,
    target: targetId,
    start: minKeyTime,
  });
  if (!sParsed.success) {
    return { ok: false, reason: `addStrip spec invalid: ${sParsed.error.message}` };
  }
  const sResult = validatePlan(addStrip, sParsed.data, fork1, intent);
  if (!sResult.ok) return { ok: false, reason: `addStrip rejected: ${sResult.reason}` };

  // 5 — fork2 = fork1 + the placement; validate deleteNode(all bare channel ids)
  //     vs it. The channels MUST go in this same entry — bare channels fold
  //     below strips (layeredChannels.ts:224-226), so leaving them double-drives.
  let fork2: DagState;
  try {
    fork2 = createFork(fork1, sResult.ops).fork;
  } catch (err) {
    return { ok: false, reason: `addStrip fork failed: ${(err as Error).message}` };
  }
  const dParsed = deleteNode.spec.safeParse({ targetSelectors: bare.map((n) => n.id) });
  if (!dParsed.success) {
    return { ok: false, reason: `deleteNode spec invalid: ${dParsed.error.message}` };
  }
  const dResult = validatePlan(deleteNode, dParsed.data, fork2, intent);
  if (!dResult.ok) return { ok: false, reason: `deleteNode rejected: ${dResult.reason}` };

  // 6 — ONE propose with the UNIONED closure → ONE dispatchAtomic → ONE undo.
  const combinedClosure = unionClosureSpecs(
    unionClosureSpecs(aResult.closure.spec, sResult.closure.spec),
    dResult.closure.spec,
  );
  return proposeAndAccept(
    base,
    [...aResult.ops, ...sResult.ops, ...dResult.ops],
    intent,
    ['user:mutator.nla.createAction', 'user:mutator.nla.addStrip', 'user:mutator.deleteNode'],
    combinedClosure,
    [...aResult.warnings, ...sResult.warnings, ...dResult.warnings],
  );
}
