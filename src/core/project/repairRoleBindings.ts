// #608 — the LOAD boundary for the one-producer-per-role rule.
//
// WHY THIS EXISTS AT ALL. The rule is enforced at the connect op, which covers
// every graph built by the editor, the agent mutators and the tools — because all
// of those emit ops. It does NOT cover a graph that arrives already assembled, and
// project load is exactly that: parse → migrate → parse, with no semantic check
// anywhere in it. Every project saved before the rule existed is a legitimate file
// that may contain two depth passes on one job, and hand-edited or
// externally-generated files can contain anything at all.
//
// So without this pass the invariant would be true of graphs the editor makes and
// false of graphs it opens — which is the worst of both, because the reader would
// have been simplified on the strength of a guarantee that does not hold.
//
// REPAIR, NOT REFUSE. Refusing the load turns a recoverable authoring mistake into
// an unopenable project, and this constraint has never been enforced before, so
// files predating it are not corrupt — they are old. The later duplicate is
// dropped, the first binding wins (matching the reader's previous first-wins
// behaviour, so a repaired project answers exactly as it did before), and every
// drop is warned about by name. No silent loss.
//
// REF: issue #608; `src/core/dag/ops.ts` (the connect-time gate this backstops);
// `src/core/dag/passRole.ts` (the one role lookup, shared with the live graph).

import { passRoleOf } from '../dag/passRole';
import type { NodeId, SocketId } from '../dag/types';
import type { Project } from './schema';

export interface RoleBindingRepair {
  /** The consumer whose socket held the duplicate. */
  node: NodeId;
  socket: SocketId;
  role: string;
  /** The binding that stays — the first one seen, so reads are unchanged. */
  kept: NodeId;
  /** The binding that was dropped. */
  dropped: NodeId;
}

/**
 * Drop bindings that repeat a role already bound on the same list socket.
 *
 * Pure: returns a new project when anything changed, and the SAME object when
 * nothing did, so the common case allocates nothing and a caller can compare by
 * identity to know whether a repair happened.
 */
export function repairDuplicateRoleBindings(project: Project): {
  project: Project;
  repairs: RoleBindingRepair[];
} {
  const repairs: RoleBindingRepair[] = [];
  const nextNodes: Record<NodeId, (typeof project.state.nodes)[NodeId]> = {};
  let changed = false;

  for (const [nodeId, node] of Object.entries(project.state.nodes)) {
    let nextInputs: Record<SocketId, unknown> | undefined;

    for (const [socket, binding] of Object.entries(node.inputs ?? {})) {
      if (!Array.isArray(binding)) continue;
      const seen = new Map<string, NodeId>();
      const kept: typeof binding = [];

      for (const ref of binding) {
        const role = passRoleOf(project.state, ref);
        const incumbent = role === undefined ? undefined : seen.get(role);
        if (role !== undefined && incumbent !== undefined) {
          repairs.push({ node: nodeId, socket, role, kept: incumbent, dropped: ref.node });
          continue;
        }
        if (role !== undefined) seen.set(role, ref.node);
        kept.push(ref);
      }

      if (kept.length !== binding.length) {
        nextInputs = { ...(nextInputs ?? node.inputs), [socket]: kept };
      }
    }

    if (nextInputs) {
      changed = true;
      nextNodes[nodeId] = { ...node, inputs: nextInputs } as (typeof project.state.nodes)[NodeId];
    } else {
      nextNodes[nodeId] = node;
    }
  }

  if (!changed) return { project, repairs };
  return {
    project: { ...project, state: { ...project.state, nodes: nextNodes } },
    repairs,
  };
}

/** Apply the repair and surface every drop by name (the V38 no-silent-loss rule). */
export function repairAndWarn(project: Project): Project {
  const { project: repaired, repairs } = repairDuplicateRoleBindings(project);
  for (const r of repairs) {
    console.warn(
      `[repairRoleBindings] ${r.node}.${r.socket} bound two "${r.role}" producers; ` +
        `kept "${r.kept}", dropped "${r.dropped}". A role may be bound once (#608). ` +
        `Re-wire the dropped node to another job if it was intentional.`,
    );
  }
  return repaired;
}
