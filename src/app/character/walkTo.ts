// character.walkTo — pure macro: state + characterId + worldPoint → Op[].
//
// Click-to-move emits a Character → WalkPath chain via dispatchAtomic
// (THESIS.md §40, krama K7 — mirror of K6 asset-drop chain). One Cmd+Z
// reverts the entire chain because dispatchAtomic stores it as a single
// atomic group on the undo stack.
//
// Ops (atomic):
//   1. (if existing path is connected to loco.path) disconnect it
//   2. addNode(WalkPath) with from/to/sampleCount + pre-wired navmesh input
//   3. connect(newWalkPath.out → loco.path)
//
// Pre-conditions (caller responsibility — macro returns [] if violated):
//   - characterId resolves to a Character node
//   - that Character's `locomotion` input is connected to a LocomotionState
//   - a Navmesh node exists in the DAG (for the new WalkPath's input)
//
// The ORPHANED previous WalkPath stays in the DAG. P2 trade-off: the
// op-only mutation discipline (V1) means the macro emits exactly the
// ops it intends to. A "garbage-collect orphans" pass lands as a
// post-P2 hygiene phase if the orphans become user-visible.
//
// REF: THESIS.md §40, §50, vyapti V1, krama K7.

import type { DagState } from '../../core/dag/state';
import type { NodeId, NodeRef, Op } from '../../core/dag/types';

export type Vec3 = readonly [number, number, number];

export interface WalkToOptions {
  /** Number of samples in the new WalkPath. */
  readonly sampleCount?: number;
}

/**
 * Find the first node of `nodeType` in `state`, or null if absent. Used to
 * discover the navmesh + LocomotionState the macro should attach to.
 */
function findFirstNodeOfType(state: DagState, nodeType: string): NodeId | null {
  for (const [id, node] of Object.entries(state.nodes)) {
    if (node.type === nodeType) return id;
  }
  return null;
}

/**
 * Resolve the character's existing locomotion ref, or null if not wired.
 */
function getLocomotionRef(state: DagState, characterId: NodeId): NodeRef | null {
  const char = state.nodes[characterId];
  if (!char || char.type !== 'Character') return null;
  const binding = char.inputs.locomotion;
  if (!binding || Array.isArray(binding)) return null;
  return binding;
}

/**
 * Resolve the WalkPath currently feeding the locomotion's `path` input,
 * or null if none.
 */
function getCurrentPathRef(state: DagState, locomotionId: NodeId): NodeRef | null {
  const loco = state.nodes[locomotionId];
  if (!loco) return null;
  const binding = loco.inputs.path;
  if (!binding || Array.isArray(binding)) return null;
  return binding;
}

function getCurrentPositionFromLocomotion(state: DagState, locomotionId: NodeId): Vec3 {
  const path = getCurrentPathRef(state, locomotionId);
  if (path) {
    const wp = state.nodes[path.node];
    if (wp && wp.type === 'WalkPath') {
      const params = wp.params as { to?: Vec3 } | null;
      if (params?.to) return params.to;
    }
  }
  // Fallback: origin. The first walkTo from the default Character starts at [0,0,0].
  return [0, 0, 0];
}

/**
 * Build the atomic Op chain. Caller dispatches via `useDagStore.getState().dispatchAtomic(ops, 'user', description)`.
 */
export function buildWalkToOps(
  state: DagState,
  characterId: NodeId,
  worldPoint: Vec3,
  options: WalkToOptions = {},
): { ops: Op[]; description: string; newWalkPathId: NodeId } | null {
  const locoRef = getLocomotionRef(state, characterId);
  if (!locoRef) return null;
  const navmeshId = findFirstNodeOfType(state, 'Navmesh');
  if (!navmeshId) return null;

  const sampleCount = options.sampleCount ?? 16;
  const from = getCurrentPositionFromLocomotion(state, locoRef.node);

  // Deterministic id derived from existing-node count so dispatchAtomic's
  // validator never collides with a previously-emitted id within the same
  // atomic batch. The store assigns its own ids if we omit, but explicit ids
  // keep the macro testable in isolation.
  const newWalkPathId = `wp_${characterId}_${Object.keys(state.nodes).length}`;

  const ops: Op[] = [];

  const existingPath = getCurrentPathRef(state, locoRef.node);
  if (existingPath) {
    ops.push({
      type: 'disconnect',
      from: existingPath,
      to: { node: locoRef.node, socket: 'path' },
    });
  }

  ops.push({
    type: 'addNode',
    nodeId: newWalkPathId,
    nodeType: 'WalkPath',
    params: { from, to: worldPoint, sampleCount },
    inputs: {
      navmesh: { node: navmeshId, socket: 'out' },
    },
  });

  ops.push({
    type: 'connect',
    from: { node: newWalkPathId, socket: 'out' },
    to: { node: locoRef.node, socket: 'path' },
  });

  return {
    ops,
    description: `walkTo: ${characterId} → [${worldPoint.map((n) => n.toFixed(2)).join(', ')}]`,
    newWalkPathId,
  };
}
