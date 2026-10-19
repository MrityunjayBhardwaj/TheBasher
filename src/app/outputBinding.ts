// #1550 — binding a named output (`scene`, `render`) to a node: the one question both doors ask,
// the agent's `mutator.setOutput` and any UI gesture. The op checks the same thing again
// (`applySetOutput`); this answers it before a plan is built, in words for a person, and picks
// the socket so neither door has to.
//
// #1674 — one scene at a time: the render output renders the scene the app shows, as Blender's
// window renders its own scene. The op binds one name and stays plain; this keeps the two names
// agreeing, so a door that binds one also moves the other in the same commit.

import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { OUTPUT_SOCKET_TYPES, type NodeId, type NodeRef, type Op } from '../core/dag/types';
import { nodeDisplayName } from './sceneTreeWalk';

/** The ops that bind `name` to `nodeId`, and keep the render output reading the scene output,
 *  or why it can't be. Already bound there, and agreeing, is an empty list: a repeat is not an
 *  edit. */
export function setOutputOps(
  state: DagState,
  name: string,
  nodeId: NodeId,
): { ok: true; ops: Op[] } | { ok: false; reason: string } {
  const wants = OUTPUT_SOCKET_TYPES[name];
  if (wants === undefined) {
    return {
      ok: false,
      reason: `There is no output "${name}"; the outputs are ${Object.keys(OUTPUT_SOCKET_TYPES).join(' and ')}.`,
    };
  }
  const node = state.nodes[nodeId];
  if (!node) return { ok: false, reason: `There is no node "${nodeId}".` };
  const outputs = getNodeType(node.type)?.outputs ?? {};
  const socket = Object.keys(outputs).find((s) => outputs[s].type === wants);
  if (socket === undefined) {
    return {
      ok: false,
      reason: `${nodeDisplayName(state.nodes, nodeId)} is a ${node.type}, and the ${name} output takes a ${wants} node.`,
    };
  }
  const ref: NodeRef = { node: nodeId, socket };
  const bound = state.outputs[name];
  const ops: Op[] =
    bound?.node === nodeId && bound.socket === socket ? [] : [{ type: 'setOutput', name, ref }];
  return { ok: true, ops: [...ops, ...oneScene(state, name, ref)] };
}

/** What keeps the render output reading the scene output once `name` is bound to `ref`. A new
 *  scene is wired into the render output; a new render output that reads a scene brings that
 *  scene with it, and one that reads none is wired to the scene the app shows. */
function oneScene(state: DagState, name: string, ref: NodeRef): Op[] {
  if (name === 'scene') {
    const render = state.outputs.render;
    const input = render && sceneInputOf(state, render.node);
    if (!render || input === undefined) return [];
    const reads = state.nodes[render.node].inputs[input];
    if (sameRef(reads, ref)) return [];
    return [
      { type: 'connect', from: ref, to: { node: render.node, socket: input }, replace: true },
    ];
  }
  if (name === 'render') {
    const input = sceneInputOf(state, ref.node);
    if (input === undefined) return [];
    const reads = state.nodes[ref.node].inputs[input];
    const scene = state.outputs.scene;
    if (reads !== undefined && !Array.isArray(reads)) {
      return sameRef(scene, reads) ? [] : [{ type: 'setOutput', name: 'scene', ref: reads }];
    }
    if (reads === undefined && scene) {
      return [{ type: 'connect', from: scene, to: { node: ref.node, socket: input } }];
    }
  }
  return [];
}

/** The single input of `nodeId` that takes a Scene: a RenderOutput's `scene`. */
function sceneInputOf(state: DagState, nodeId: NodeId): string | undefined {
  const node = state.nodes[nodeId];
  const inputs = (node && getNodeType(node.type)?.inputs) ?? {};
  return Object.keys(inputs).find(
    (s) => inputs[s].type === OUTPUT_SOCKET_TYPES.scene && inputs[s].cardinality === 'single',
  );
}

function sameRef(a: NodeRef | NodeRef[] | undefined, b: NodeRef): boolean {
  return a !== undefined && !Array.isArray(a) && a.node === b.node && a.socket === b.socket;
}
