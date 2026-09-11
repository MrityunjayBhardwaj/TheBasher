// The critic — what a plan ACTUALLY DID, as distinct from whether it was legal (#733).
//
// The five validator gates prove a graph is well-formed: the type exists, the params
// match the schema, nothing still-consumed is being deleted, no cycle closes. They
// have never proven the graph is the one that was ASKED for, and nothing else did
// either. Measured twice, from opposite directions:
//
//   - the product side, recorded on #733 in August: "nothing compares the fork's diff
//     against the stated intent."
//   - the measurement side, in September: the interface gate scored a plan `valid` for
//     adding a `Scatter` with all five params correct and wired to NOTHING. Every gate
//     passed, the graph changed (a node appeared), and the cube never moved. That one
//     row was enough to withdraw the gate's conclusion.
//
// So this module answers a different question from the gates: given the state before,
// the state after, and the ops, WHAT MOVED — and is any of it connected to anything?
//
// ── IT REPORTS. IT DOES NOT REFUSE. ───────────────────────────────────────────────
// Two legitimate counter-examples were measured before this was written, and either
// one would have made a blocking rule wrong:
//   - `mutator.nla.createAction` mints an Action wired to nothing ON PURPOSE; a later
//     `mutator.nla.addStrip` wires it. An unwired addition is a two-step authoring
//     flow, not a defect.
//   - `Shot` has no consumer anywhere in the product today — its render-graph
//     integration is deferred (`src/nodes/Shot.ts`) — so a correct Shot is
//     unconsumed by construction.
// A rule saying "unwired is wrong" would be false about the product. The findings
// here are therefore descriptions handed to the reader, never a gate.
//
// ── REACH SPANS BOTH HALVES OF THE GRAPH, DELIBERATELY ────────────────────────────
// Basher's dependencies travel two ways: wired edges in `node.inputs`, and the
// edge-LESS sidecars that name their subject by id in params (keyframe channels,
// constraints, drivers, NLA strips). A walker that sees only the first is blind to
// the second, and that blindness has its own history — a delete-cascade that walks
// only input edges orphans a channel, an overlay resolved by walking the render tree
// silently no-ops at depth. A critic built on the edge walk alone would inherit that
// blindness and then certify it, which is worse than not having one.
//
// So reach here consults `idRefSweep` — the one declaration-driven walker over the
// id-reference universe — alongside `edges`, and it respects what a reference MEANS.
// A first draft treated id-refs as undirected and was caught by looking at its own
// output: it told the reader a keyframe channel "reads n_box but nothing reads IT",
// which is exactly backwards. A channel is a SIDECAR of its target (`role: 'subject'`
// — owned by the referent, meaningless without it), and its effect reaches the scene
// through that target's own resolution. An 'argument' ref is the other thing: reading
// a referent that exists independently, which is an input like any wired edge.
//
// REF: src/core/dag/idRefSweep.ts (the id-ref universe), src/core/dag/state.ts
//      (`edges`), src/nodes/Shot.ts (the unconsumed-by-design case); issue #733.

import { edges, type DagState } from '../../core/dag/state';
import { buildIdRefIndex, idRefsByRole, refIdsAt } from '../../core/dag/idRefSweep';
import { getNodeType } from '../../core/dag/registry';
import { hashValue } from '../../core/dag/hash';
import type { NodeId, Op } from '../../core/dag/types';

/** One node the plan brought into existence, and what it ended up attached to. */
export interface AddedNode {
  id: NodeId;
  type: string;
  /** Ids that point AT this node — edge consumers and id-ref namers. */
  attachedFrom: NodeId[];
  /** Ids this node points at — its edge producers and the ids it names. */
  attachedTo: NodeId[];
  /**
   * Declared id-references that name nothing reachable (#1019). `badRefs` is the
   * discriminating information the stranded sentence was missing: a sidecar reaches its
   * subject by a NAME in a param, so when the name is wrong the node is stranded for a
   * reason that has nothing to do with wiring — and most of these node types have no
   * input sockets at all, so advice to "connect it" can only be followed by inventing a
   * socket.
   *
   * `dangling` — the param holds an id no node in the scene has.
   * `empty`    — the param is declared and holds nothing.
   */
  badRefs: Array<{ path: string; names: string | null }>;
}

export interface EffectReport {
  added: AddedNode[];
  removed: NodeId[];
  /** Pre-existing nodes whose record differs before vs after. */
  changed: NodeId[];
  /** Nodes an op NAMED that survived the plan without changing. */
  namedButUnchanged: NodeId[];
  /** Did anything the project's declared outputs can see actually move? */
  reachesOutput: boolean;
  /** Did the whole plan leave the node table byte-identical? */
  vacuous: boolean;
}

/**
 * The ids an op can be EXPECTED to change.
 *
 * `from.node` of a connect is excluded on purpose: an edge is stored on the CONSUMER
 * (`node.inputs`), so wiring a producer into something leaves the producer's own record
 * byte-identical. A first draft counted it and duly reported the seed cube's data node
 * as "named but unchanged" every time anything was plugged into it — a false positive
 * on a correct plan, which is the one kind of noise that teaches a reader to ignore the
 * whole report.
 */
function namedBy(ops: readonly Op[]): NodeId[] {
  const out: NodeId[] = [];
  const push = (id: unknown) => {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  };
  for (const op of ops) {
    const o = op as unknown as Record<string, unknown>;
    push(o.nodeId);
    push((o.to as { node?: unknown } | undefined)?.node);
  }
  return out;
}

/** consumer -> producers, over wired edges only. */
function edgeProducers(state: DagState): Map<NodeId, Set<NodeId>> {
  const m = new Map<NodeId, Set<NodeId>>();
  for (const e of edges(state)) {
    (m.get(e.consumer) ?? m.set(e.consumer, new Set()).get(e.consumer)!).add(e.producer.node);
  }
  return m;
}

/** producer -> consumers, over wired edges only. */
function edgeConsumers(state: DagState): Map<NodeId, Set<NodeId>> {
  const m = new Map<NodeId, Set<NodeId>>();
  for (const e of edges(state)) {
    const p = e.producer.node;
    (m.get(p) ?? m.set(p, new Set()).get(p)!).add(e.consumer);
  }
  return m;
}

/**
 * The node ids the project's declared outputs can see — DIRECTIONALLY.
 *
 * `state.outputs` is the product's own answer to "what is this project FOR", so the
 * closure starts there rather than at a hand-picked sink. From a live node it reaches:
 *   • its wired input producers (what it reads),
 *   • the 'argument' ids it names (what it reads without a wire),
 *   • every node whose 'subject' ref names it (its sidecars — a channel overlaying a
 *     live object is itself live, which is the standing liveness rule).
 *
 * Direction matters and an earlier undirected version was wrong in a way worth naming:
 * it pulled in anything merely ADJACENT to a live node, so an ArrayModifier reading the
 * cube's data counted as reaching the render even though nothing consumed the modifier
 * and the cube on screen was unchanged.
 */
export function outputClosure(state: DagState): Set<NodeId> {
  const producers = edgeProducers(state);
  const subjectSidecars = new Map<NodeId, NodeId[]>();
  for (const node of Object.values(state.nodes)) {
    for (const target of idRefsByRole(node).subject) {
      (subjectSidecars.get(target) ?? subjectSidecars.set(target, []).get(target)!).push(node.id);
    }
  }
  const seen = new Set<NodeId>();
  const stack: NodeId[] = [];
  for (const ref of Object.values(state.outputs ?? {})) {
    if (ref?.node && state.nodes[ref.node]) stack.push(ref.node);
  }
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const p of producers.get(id) ?? []) if (!seen.has(p)) stack.push(p);
    const node = state.nodes[id];
    if (node) for (const a of idRefsByRole(node).argument) if (!seen.has(a)) stack.push(a);
    for (const sc of subjectSidecars.get(id) ?? []) if (!seen.has(sc)) stack.push(sc);
  }
  return seen;
}

/** The node table restricted to `ids`, hashed — "did anything visible here move?" */
function hashRestricted(state: DagState, ids: Set<NodeId>): string {
  const sub: Record<string, unknown> = {};
  for (const id of [...ids].sort()) if (state.nodes[id]) sub[id] = state.nodes[id];
  return hashValue(sub);
}

/** What the plan did, measured against the state it was applied to. */
export function describeEffect(
  before: DagState,
  after: DagState,
  ops: readonly Op[],
): EffectReport {
  const consumers = edgeConsumers(after);
  const idRefIndexAfter = buildIdRefIndex(after.nodes);

  const added: AddedNode[] = [];
  for (const id of Object.keys(after.nodes)) {
    if (id in before.nodes) continue;
    const node = after.nodes[id];
    const roles = idRefsByRole(node);

    // What this node READS: its wired producers, plus the referents it merely points at.
    const attachedTo: NodeId[] = [];
    for (const binding of Object.values(node.inputs ?? {})) {
      for (const ref of Array.isArray(binding) ? binding : [binding]) {
        if (ref?.node && !attachedTo.includes(ref.node)) attachedTo.push(ref.node);
      }
    }
    for (const a of roles.argument) if (!attachedTo.includes(a)) attachedTo.push(a);

    // What CONSUMES this node: wired consumers, anyone naming it, and — the case an
    // edge walk cannot see — the subject it is a sidecar of, whose own resolution is
    // what carries this node's effect to the scene.
    const attachedFrom = [
      ...new Set([
        ...(consumers.get(id) ?? []),
        ...(idRefIndexAfter.get(id) ?? []),
        ...roles.subject.filter((t) => !!after.nodes[t]),
      ]),
    ];
    // The liveness filter above already decides this; naming it is the whole fix. Read
    // off the DECLARATION so an empty ref (which `idRefsByRole` drops, an empty string
    // naming nothing) is distinguishable from a wrong one.
    const badRefs: AddedNode['badRefs'] = [];
    for (const ref of getNodeType(node.type)?.idRefs ?? []) {
      const named = refIdsAt(node.params, ref.path, ref.shape);
      if (named.length === 0) {
        badRefs.push({ path: ref.path, names: null });
        continue;
      }
      for (const t of named) if (!after.nodes[t]) badRefs.push({ path: ref.path, names: t });
    }
    added.push({ id, type: node.type, attachedFrom, attachedTo, badRefs });
  }

  const removed = Object.keys(before.nodes).filter((id) => !(id in after.nodes));
  const changed = Object.keys(before.nodes).filter(
    (id) => id in after.nodes && hashValue(before.nodes[id]) !== hashValue(after.nodes[id]),
  );

  const survived = new Set([
    ...changed,
    ...Object.keys(after.nodes).filter((i) => i in before.nodes),
  ]);
  const namedButUnchanged = namedBy(ops).filter((id) => survived.has(id) && !changed.includes(id));

  // A removal cannot show up in the AFTER closure — the node is gone — so the before
  // closure is the only thing that can say whether what was deleted was visible.
  // Computed ONCE and only when something was actually removed: calling it inside the
  // predicate walks the whole graph per removed id, which a delete-cascade turns into
  // the same per-item rescan the constraint stack was just cured of.
  const closure = outputClosure(after);
  const beforeClosure = removed.length > 0 ? outputClosure(before) : undefined;
  const reachesOutput =
    hashRestricted(before, closure) !== hashRestricted(after, closure) ||
    removed.some((id) => beforeClosure!.has(id));

  return {
    added,
    removed,
    changed,
    namedButUnchanged,
    reachesOutput,
    vacuous: hashValue(before.nodes) === hashValue(after.nodes),
  };
}

/**
 * The findings a reader should be told about. Descriptions, not verdicts — see the
 * module header for the two measured cases that make a blocking rule wrong.
 */
/** "`target` names \"Cube\", which is not a node in this scene" / "`target` is empty". */
function describeBadRefs(a: AddedNode): string {
  return a.badRefs
    .map((r) =>
      r.names === null
        ? `its \`${r.path}\` is empty, so it names nothing`
        : `its \`${r.path}\` names "${r.names}", which is not a node in this scene`,
    )
    .join('; ');
}

export function critique(report: EffectReport): string[] {
  const out: string[] = [];
  if (report.vacuous) {
    out.push(
      'This plan changed nothing at all. The graph after it is identical to the graph before it.',
    );
    return out;
  }
  const stranded = report.added.filter(
    (a) => a.attachedFrom.length === 0 && a.attachedTo.length === 0,
  );
  for (const a of stranded) {
    // A bad NAME outranks a missing WIRE. A sidecar reaches its subject through a param,
    // and telling the author to connect a node whose type declares no input sockets sends
    // them to invent one — the dominant failure on the raw-op road.
    if (a.badRefs.length > 0) {
      out.push(
        `Added ${a.id} (${a.type}), but ${describeBadRefs(a)}. It reaches its subject by ` +
          `NAME, not by a wire, so it affects nothing until that names a node that exists.`,
      );
      continue;
    }
    out.push(
      `Added ${a.id} (${a.type}) and connected it to nothing — nothing consumes it and it reads nothing, ` +
        `so it cannot affect the scene on its own. If that is deliberate (a library item wired by a later step), ignore this.`,
    );
  }
  const halfAttached = report.added.filter(
    (a) => a.attachedFrom.length === 0 && a.attachedTo.length > 0,
  );
  for (const a of halfAttached) {
    out.push(
      `Added ${a.id} (${a.type}); it reads ${a.attachedTo.join(', ')} but nothing reads IT, ` +
        `so its result is not consumed anywhere.`,
    );
  }
  if (report.namedButUnchanged.length > 0) {
    out.push(
      `Named but unchanged: ${report.namedButUnchanged.join(', ')} — the ops mention these and they are the same as before.`,
    );
  }
  // The outputs line is a SUMMARY of the per-node findings whenever those findings
  // already account for every addition — saying both is the same sentence twice, and
  // a report that repeats itself is one a reader learns to skim. Measured on the
  // mutator road: both plans that produced findings produced this line as a duplicate
  // of the one above it.
  const explained = stranded.length + halfAttached.length === report.added.length;
  if (!report.reachesOutput && !report.vacuous && !(explained && report.added.length > 0)) {
    out.push(
      "Nothing the project's outputs can see changed. The graph moved, but not anywhere the render reads from.",
    );
  }
  return out;
}

/** The critique as the block appended to a tool result, or '' when there is nothing to say. */
export function renderCritique(findings: readonly string[]): string {
  if (findings.length === 0) return '';
  return (
    `\n\nCRITIC - what this plan actually did:\n` +
    findings.map((f) => `  - ${f}`).join('\n') +
    `\nThese are observations, not rejections. If the plan does not do what was asked, revise it.`
  );
}
