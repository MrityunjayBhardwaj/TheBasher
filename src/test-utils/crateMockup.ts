// crateMockup — the Crate scene of the #1815 mockup, built with real nodes and real doors (#1817).
//
//   Crate · Object
//     constraints: Mix (Matrix) of Track-To A and Track-To B, which share one Follow Path on the
//                  object's own transform; its factor is a Lag template ← Curve Remap ← Noise
//                  (the mockup's Time → Noise wire has no converter in Basher: nothing turns Time
//                  into a number, so Noise stands alone)
//     data:        Mirror ← Array ← Bevel ← Box
//   Barrel · Object: a wired chain, Follow Path under a Track-To with influence 0.5
//   Hero (aimed at by name) and Rail (the curve, followed by name)
//
// Everything goes into the scene through Add's own door, so it is in a collection the way a person
// would have it. The Lag is the built-in one, added through Add ▸ Lag.
//
// REF: issue #1815 (mockup comment); src/app/addPrimitives.ts; src/core/dag/chainEdit.ts.

import { applyOps, type DagState } from '../core/dag';
import { addStepOps, setInfluenceOps } from '../core/dag/chainEdit';
import type { NodeRef, Op } from '../core/dag/types';
import { buildAddPrimitiveOps } from '../app/addPrimitives';

const node = (id: string, nodeType: string, params: object = {}): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType,
  params: params as Record<string, unknown>,
});
const wire = (from: string, to: string, socket: string, out = 'out'): Op => ({
  type: 'connect',
  from: { node: from, socket: out },
  to: { node: to, socket },
});
const name = (nodeId: string, value: string): Op => ({ type: 'setMeta', nodeId, name: value });

export interface CrateMockup {
  readonly state: DagState;
  readonly crate: NodeRef;
  readonly barrel: NodeRef;
  /** The Lag instance on the blend's factor. */
  readonly lag: string;
}

/** Adds the Crate scene to `start` (the default project, or anything with a scene). */
export function buildCrateMockup(start: DagState): CrateMockup {
  let s = start;
  const run = (ops: readonly Op[]) => {
    s = applyOps(s, ops).next;
  };
  const added = (
    kind: Parameters<typeof buildAddPrimitiveOps>[1],
    pos: [number, number, number],
  ) => {
    const result = buildAddPrimitiveOps(s, kind, pos);
    if (!result) throw new Error(`Add ▸ ${kind} refused`);
    run(result.ops);
    return result.newNodeId;
  };

  const hero = added('Null', [4, 1, 0]);
  run([name(hero, 'Hero')]);
  const rail = added('Curve', [0, 0, 0]);
  run([name(rail, 'Rail')]);

  const crate = added('Cube', [0, 2, 0]);
  run([name(crate, 'Crate')]);
  const box = (s.nodes[crate].inputs.data as NodeRef).node;
  run([
    node('bevel', 'BevelModifier', { amount: 0.1 }),
    node('array', 'ArrayModifier', { count: 3, offset: [2, 0, 0] }),
    node('mirror', 'MirrorModifier'),
    { type: 'disconnect', from: { node: box, socket: 'out' }, to: { node: crate, socket: 'data' } },
    wire(box, 'bevel', 'target'),
    wire('bevel', 'array', 'target'),
    wire('array', 'mirror', 'target'),
    wire('mirror', crate, 'data'),
  ]);

  const lag = added('Lag', [0, 0, 0]);
  run([
    node('own', 'OwnWorld', { object: crate }),
    node('follow', 'FollowPath', { target: crate, curve: rail, evalTime: 0.25 }),
    node('aimA', 'TrackTo', { target: crate, aimNode: hero }),
    node('aimB', 'TrackTo', { target: crate, aimNode: hero, up: [0, 0, 1], roll: 15 }),
    node('blend', 'Mix', { dataType: 'Matrix', factor: 0.5 }),
    node('noise', 'Noise'),
    node('remap', 'CurveRemap'),
    name('aimA', 'Track-To A'),
    name('aimB', 'Track-To B'),
    name('follow', 'Follow Path'),
    wire('own', 'follow', 'in', 'world'),
    wire('follow', 'aimA', 'in', 'world'),
    wire('follow', 'aimB', 'in', 'world'),
    wire('aimA', 'blend', 'aMatrix', 'world'),
    wire('aimB', 'blend', 'bMatrix', 'world'),
    wire('blend', crate, 'constraints', 'outMatrix'),
    wire('noise', 'remap', 'in'),
    wire('remap', lag, 'in'),
    wire(lag, 'blend', 'factor'),
  ]);

  // Two more Lags elsewhere, so the template is shared, as the mockup's "3 instances" is.
  added('Lag', [0, 0, 0]);
  added('Lag', [0, 0, 0]);

  const barrel = added('Cube', [-3, 0, 0]);
  run([name(barrel, 'Barrel')]);
  run(addStepOps(s, barrel, 'barrelFollow', 'FollowPath', { curve: rail })!);
  run(addStepOps(s, barrel, 'barrelAim', 'TrackTo', { aimNode: hero })!);
  run(setInfluenceOps(s, barrel, 'barrelAim', 0.5)!);

  return {
    state: s,
    crate: { node: crate, socket: 'out' },
    barrel: { node: barrel, socket: 'out' },
    lag,
  };
}
