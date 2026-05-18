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
    useDiffStore
      .getState()
      .propose(baseState, ops, intent, opSources, closureSpec, warnings);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const dag = useDagStore.getState();
  acceptSelectedOps(dag.dispatchAtomic.bind(dag));
  return { ok: true };
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
function inferValueType(
  value: unknown,
): 'number' | 'vec3' | 'quat' | 'color' | null {
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
export function dispatchFirstKeyComposite(
  args: FirstKeyCompositeArgs,
): DispatchResult {
  const { targetId, paramPath, value, seconds } = args;
  const intent = `Animate ${targetId}.${paramPath}`;

  // 1 — deterministic ids (mirror addLayer.ts:131 / addChannel.ts:181).
  const layerId = `${targetId}_layer`;
  const channelId = `${targetId}_${safePath(paramPath)}_channel`;

  const base = useDagStore.getState().state;

  const addLayer = getMutator('mutator.timeline.addLayer');
  const addChannel = getMutator('mutator.timeline.addChannel');
  const keyframe = getMutator('mutator.timeline.keyframe');
  if (!addLayer || !addChannel || !keyframe) {
    return {
      ok: false,
      reason:
        'Timeline Mutators not registered (addLayer / addChannel / keyframe).',
    };
  }

  // 2 — validate addLayer against the base DAG.
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

  // 3 — fork1 = base + addLayer ops (orchestrator.ts:288 mechanism).
  let fork1: DagState;
  try {
    fork1 = createFork(base, lResult.ops).fork;
  } catch (err) {
    return { ok: false, reason: `addLayer fork failed: ${(err as Error).message}` };
  }

  // 4 — validate addChannel against the FORKED state (its closure roots
  //     on the freshly-created layer id — A2 lifecycle / RESEARCH risk #2).
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
    fork2 = createFork(base, [...lResult.ops, ...cResult.ops]).fork;
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

  // 7 — propose ALL ops as ONE diff with the COMBINED closure (union of
  //     the three Mutators' declared closure specs — replicate the
  //     orchestrator's unionClosureSpecs, do not invent), then accept.
  const combinedClosure = unionClosureSpecs(
    unionClosureSpecs(lResult.closure.spec, cResult.closure.spec),
    kResult.closure.spec,
  );
  return proposeAndAccept(
    base,
    [...lResult.ops, ...cResult.ops, ...kResult.ops],
    intent,
    [
      'user:mutator.timeline.addLayer',
      'user:mutator.timeline.addChannel',
      'user:mutator.timeline.keyframe',
    ],
    combinedClosure,
    [...lResult.warnings, ...cResult.warnings, ...kResult.warnings],
  );
}
