// #1017 - the write that LANDS and is then overridden.
//
// #1014 covered the write that was STRIPPED: accepted, changed nothing, and the
// product already had a sentence for it. This is its sibling and the last silent
// member of the family - the write that really does land on the base value and is
// then masked by an edge-less sidecar (a keyframe channel, an NLA strip, a driver)
// naming the same (node, param) by id instead of by wire.
//
// Measured before it was written: ask the agent to move an animated cube and it
// emits exactly the right op, the op is accepted, the graph hash changes, no
// `reportable` fires, the critic sees a changed node reaching the output - and the
// cube does not move at any time on the timeline. Every surface that could have
// spoken was silent.
//
// THE QUESTION IS "DID WHAT THE SCENE SHOWS CHANGE", NOT "IS THERE AN OVERLAY".
// The first draft asked whether the resolver returned non-null and whether that
// value differed from the written one. Falsifying it showed that criterion is both
// too weak and too strong: a write to a param the node does not OWN resolves
// non-null through the object-data reach with no override in sight, and a write
// that happens to equal the channel's sample at this instant is masked at every
// other instant while comparing equal here. So the oracle is a boundary pair over
// the plan: what the scene shows at this param BEFORE, against what it shows
// AFTER. Unchanged means the write did not reach the screen, whatever the reason.
//
// "What the scene shows" is `resolveEvaluatedParam(...) ?? readBaseParam(...)` -
// the resolver's null IS the contract "nothing overrides, use the base", so the
// two together are the rendered value, and asking them absorbs channels, strips
// and drivers at once without a list of overlay kinds to keep up to date.
//
// IT REPORTS, IT NEVER REFUSES. Writing a base value underneath a channel is
// legitimate: it is the rest value a Combine-mode overlay folds onto.
//
// REF: src/app/resolveEvaluatedParam.ts (the resolver + its null contract);
//      src/app/readBaseParam.ts (the base half of the pair);
//      src/core/dag/idRefSweep.ts (`idRefsByRole` - the declaration-driven walker
//      used to NAME the overriding node); issues #1017, #1014, #1016.

import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import type { Reportable } from '../../core/dag/ops';
import { resolveEvaluatedParam } from '../../app/resolveEvaluatedParam';
import { readBaseParam } from '../../app/readBaseParam';
import { idRefsByRole } from '../../core/dag/idRefSweep';

export interface MaskedWrite {
  readonly nodeId: string;
  readonly paramPath: string;
  /** What the plan wrote. */
  readonly wrote: unknown;
  /** What the scene shows at `seconds` - the same before the plan and after it. */
  readonly rendered: unknown;
  readonly seconds: number;
  /** The node(s) doing the overriding, when the declaration names them unambiguously. */
  readonly overriddenBy: readonly string[];
}

/** What the scene shows for this param: the override if there is one, else the base. */
function renderedValue(
  state: DagState,
  nodeId: string,
  paramPath: string,
  seconds: number,
): unknown {
  if (!state.nodes[nodeId]) return undefined;
  const ctx = { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
  try {
    const resolved = resolveEvaluatedParam(state, nodeId, paramPath, ctx);
    if (resolved !== null) return resolved.value;
  } catch {
    return undefined; // an unevaluable overlay is not evidence either way
  }
  return readBaseParam(state.nodes[nodeId], paramPath);
}

/**
 * The nodes that name `nodeId` as their SUBJECT and carry this exact `paramPath`.
 *
 * `role: 'subject'` is the declared answer to "the referent was deleted, what happens
 * to me?" - a sidecar owned by the referent, which is precisely the shape of an
 * overriding overlay. Read off the declaration rather than off a list of node types,
 * so a new overlay kind is named here the moment it declares its ref.
 *
 * Deliberately narrow: a sidecar that does not carry a `paramPath` param (an NLA
 * Strip holds its channels inside its Action) matches nothing and goes unnamed. The
 * report still fires - it is driven by the boundary pair, not by this. Under-naming
 * is the safe direction; naming a rotation channel for a position write is not.
 */
function overridersOf(state: DagState, nodeId: string, paramPath: string): string[] {
  const out: string[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.id === nodeId) continue;
    if (!idRefsByRole(node).subject.includes(nodeId)) continue;
    // Read through the shared base reader, NOT an inline `as { mute?: unknown }`
    // cast. That cast is a tracked defect class here - `operatorBypass.gate.test.ts`
    // censuses every file carrying one, and this file walked straight into it on its
    // first run. The residual limit is the same one that census names and is stated
    // rather than hidden: neither form can tell "declared false" from "never
    // declared", so a sidecar kind that spells its gate differently goes unnamed.
    // Under-naming is the safe direction, and the report does not depend on it.
    if (readBaseParam(node, 'paramPath') !== paramPath) continue;
    if (readBaseParam(node, 'mute') === true) continue; // a muted sidecar overrides nothing
    out.push(node.id);
  }
  return out;
}

/**
 * Every param this plan wrote whose value the scene does not show.
 *
 * `reportable` is the index-aligned array `createFork` returns. An op that already
 * produced one belongs to #1014's class - it was stripped, so it never landed at all
 * - and two sentences about one op would say two different things. This is load
 * bearing rather than tidy: a write to a param the node does not own is stripped AND
 * leaves the rendered value unchanged, so without this skip it would be reported here
 * as overridden, which is false - nothing overrides it, it was simply never stored.
 *
 * Only the LAST write to a given (node, param) is judged: an earlier write in the same
 * plan is superseded by its own successor, not masked by an overlay.
 */
export function maskedWrites(
  before: DagState,
  after: DagState,
  ops: readonly Op[],
  reportable: ReadonlyArray<Reportable | null>,
  seconds: number,
): MaskedWrite[] {
  const lastWrite = new Map<string, { nodeId: string; paramPath: string; value: unknown }>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type !== 'setParam') continue;
    if (reportable[i] != null) continue; // #1014 already speaks for this op
    lastWrite.set(`${op.nodeId} ${op.paramPath}`, {
      nodeId: op.nodeId,
      paramPath: op.paramPath,
      value: op.value,
    });
  }

  const hits: MaskedWrite[] = [];
  for (const w of lastWrite.values()) {
    // No existence test here on purpose: `renderedValue` already returns undefined for
    // a node that is not in the state it is given, which covers BOTH a node the plan
    // removed (undefined after, a value before - they differ, so no claim) and a node
    // the plan added (undefined before, a value after - likewise). An outer guard for
    // either was dead code, and falsifying it is how that was found.
    const was = renderedValue(before, w.nodeId, w.paramPath, seconds);
    const now = renderedValue(after, w.nodeId, w.paramPath, seconds);
    // Both unreadable: the param does not exist on this node at all (a stripped write
    // to a node the plan also added). Nothing was rendered before or after, so there is
    // no masking claim - and this, not a `before.nodes` existence test, is what covers
    // a node the plan added: an added node reads `undefined` before and a real value
    // after, which differs, so it is already excluded as "the write reached the scene".
    if (was === undefined && now === undefined) continue;
    if (JSON.stringify(was) !== JSON.stringify(now)) continue; // the write reached the scene
    hits.push({
      nodeId: w.nodeId,
      paramPath: w.paramPath,
      wrote: w.value,
      rendered: now,
      seconds,
      overriddenBy: overridersOf(after, w.nodeId, w.paramPath),
    });
  }
  return hits;
}

/** The block appended to the tool result. Empty string when there is nothing to say. */
export function renderMaskedWrites(hits: readonly MaskedWrite[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((h) => {
    const by =
      h.overriddenBy.length > 0
        ? ` ${h.overriddenBy.join(', ')} drives it.`
        : ' Something else drives it.';
    return (
      `  - ${h.paramPath} on ${h.nodeId}: the scene still shows ` +
      `${JSON.stringify(h.rendered)} at ${h.seconds.toFixed(1)}s, not ` +
      `${JSON.stringify(h.wrote)}.${by}`
    );
  });
  const n = hits.length;
  return (
    `\n\nNOTE - ${n} ${n === 1 ? 'write' : 'writes'} landed on the node but did not ` +
    `change what is rendered:\n${lines.join('\n')}\n` +
    `The base value did change; an animation channel, strip or driver is what the ` +
    `viewport reads. If you meant the scene to change, edit or mute what drives it. If ` +
    `you meant to set the value underneath the animation, this is already correct.`
  );
}
