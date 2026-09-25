// The `PoseOverride` chain hanging off a `RetargetClip` — ONE walk, shared (#1156).
//
// It lived inside the poseBone mutator, which was right while the mutator was the only
// road into the pose lane. It is not any more: the inspector now offers the same gesture
// to a director, and the two must agree about which overrides already exist for a bone.
// Two spellings of this walk would be two answers to "does this bone already carry an
// override" — the shape that cost #1088 and #1141, where a bind's hide and a path
// placement each grew their own answer to one question and drifted apart.
//
// REF: src/agent/mutators/builders/poseBone.ts (the mutator that appends to the tip);
//      src/app/animate/poseTargetForBone.ts (the inspector's lookup); issues #993, #1156.

import { edgeTarget, type GraphNodeLike } from './graphNodes';

export interface OverrideNode {
  readonly id: string;
  readonly bone: string;
  readonly overridden: { position?: boolean; rotation?: boolean };
}

/**
 * The chain of `PoseOverride`s hanging off `retargetId`, nearest first.
 *
 * Walked consumer-side one hop at a time: at each step, the override whose `pose`
 * input names the current node. Bounded by the node count so a malformed graph
 * cannot spin, and by taking the FIRST match at each hop it reports a single
 * chain even if a previous road (or a hand-edited file) left a fork — `build`
 * appends to the tip of what it reports, which keeps a fork from widening.
 */
export function overrideChain(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  retargetId: string,
): OverrideNode[] {
  const ids = Object.keys(nodes).sort();
  const out: OverrideNode[] = [];
  let cur = retargetId;
  const seen = new Set<string>([retargetId]);
  for (let hops = 0; hops < ids.length; hops++) {
    const nextId = ids.find(
      (id) =>
        nodes[id].type === 'PoseOverride' && edgeTarget(nodes[id], 'pose') === cur && !seen.has(id),
    );
    if (nextId === undefined) break;
    const p = (nodes[nextId].params ?? {}) as {
      bone?: unknown;
      overridden?: { position?: boolean; rotation?: boolean };
    };
    out.push({
      id: nextId,
      bone: typeof p.bone === 'string' ? p.bone : '',
      overridden: p.overridden ?? {},
    });
    seen.add(nextId);
    cur = nextId;
  }
  return out;
}
