// springBody — a spring's sub-network and its Solver (#300 S, #1559).
//
// A leaf module, importing types only: the built-in Spring template (`builtinTemplates.ts`) is
// made from it, and `buildSpringOps` (`solverBind.ts`) places that template, so neither has to
// import the other's dependencies.
//
// REF: src/app/solverBind.ts (`buildSpringOps`); src/app/builtinTemplates.ts; issue #1559.

import type { NodeRef, Op } from '../core/dag/types';

export type SpringNodeKey =
  | 'in'
  | 'pp'
  | 'pv'
  | 'e'
  | 'ke'
  | 'cv'
  | 'acc'
  | 'nv'
  | 'np'
  | 'solver'
  | 'driver';

/**
 * A spring's sub-network and its Solver: the leaves, the five Vec3Math steps and the Solver
 * over `[newPos, newVel]` trailing `controllerId`. Shared by the spring preset's definition
 * (`builtinTemplates.ts`), so the preset is the network this builder has always written.
 */
export function springBodyOps(req: {
  controllerId: string;
  stiffness: number;
  damping: number;
  seedFrame: number;
  idFor: (key: SpringNodeKey) => string;
}): Op[] {
  const { controllerId, idFor } = req;
  const k = req.stiffness;
  const c = req.damping;
  const seedFrame = req.seedFrame;
  const id = idFor;
  const out = (n: string): NodeRef => ({ node: n, socket: 'out' });
  const wire = (from: NodeRef, to: NodeRef): Op => ({ type: 'connect', from, to });

  return [
    // Leaves (#1548): the live target (`inputVec`) + the two feedback slots (`prevVec`).
    {
      type: 'addNode',
      nodeId: id('in'),
      nodeType: 'BodyInputVec',
      params: { input: 'inputVec', slot: 0 },
    },
    {
      type: 'addNode',
      nodeId: id('pp'),
      nodeType: 'BodyInputVec',
      params: { input: 'prevVec', slot: 0 },
    },
    {
      type: 'addNode',
      nodeId: id('pv'),
      nodeType: 'BodyInputVec',
      params: { input: 'prevVec', slot: 1 },
    },
    // e = target − prevPos
    { type: 'addNode', nodeId: id('e'), nodeType: 'Vec3Math', params: { op: 'sub' } },
    wire(out(id('in')), { node: id('e'), socket: 'a' }),
    wire(out(id('pp')), { node: id('e'), socket: 'b' }),
    // ke = e · k
    { type: 'addNode', nodeId: id('ke'), nodeType: 'Vec3Math', params: { op: 'scale', scalar: k } },
    wire(out(id('e')), { node: id('ke'), socket: 'a' }),
    // cv = prevVel · c
    { type: 'addNode', nodeId: id('cv'), nodeType: 'Vec3Math', params: { op: 'scale', scalar: c } },
    wire(out(id('pv')), { node: id('cv'), socket: 'a' }),
    // accel = ke − cv
    { type: 'addNode', nodeId: id('acc'), nodeType: 'Vec3Math', params: { op: 'sub' } },
    wire(out(id('ke')), { node: id('acc'), socket: 'a' }),
    wire(out(id('cv')), { node: id('acc'), socket: 'b' }),
    // newVel = prevVel + accel  (slot 1)
    { type: 'addNode', nodeId: id('nv'), nodeType: 'Vec3Math', params: { op: 'add' } },
    wire(out(id('pv')), { node: id('nv'), socket: 'a' }),
    wire(out(id('acc')), { node: id('nv'), socket: 'b' }),
    // newPos = prevPos + newVel  (slot 0)
    { type: 'addNode', nodeId: id('np'), nodeType: 'Vec3Math', params: { op: 'add' } },
    wire(out(id('pp')), { node: id('np'), socket: 'a' }),
    wire(out(id('nv')), { node: id('np'), socket: 'b' }),
    // The Solver: bodies = [newPos(slot0), newVel(slot1)]; live target = the controller.
    {
      type: 'addNode',
      nodeId: id('solver'),
      nodeType: 'Solver',
      params: { seedFrame, sourceTransformVec: { node: controllerId } },
    },
    wire(out(id('np')), { node: id('solver'), socket: 'bodies' }),
    wire(out(id('nv')), { node: id('solver'), socket: 'bodies' }),
  ];
}
