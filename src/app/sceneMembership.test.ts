// #1820 — the membership list is real (every wire exists on its node type) and rule 3 of
// docs/GRAPH.md quotes it exactly.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getNodeType } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import {
  HOP_TYPES,
  MEMBERSHIP_WIRES,
  isInScene,
  keepInSceneOps,
  membershipSocketsOf,
  sceneMembersOf,
  type MembershipWire,
} from './sceneMembership';
import { hierarchySocketsOf } from './sceneHierarchy';
import { applyOp, type DagState } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { makeSplitCube } from '../test-utils/splitCube';
import { makeSplitLight } from '../test-utils/splitLight';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { buildSceneTreeRows } from './sceneTreeWalk';
import { getViewportSelectableIds } from './selectableNodes';
import { enumerateCameraNodeIds } from './activeCamera';
import { resolveRigLightSources } from './resolveRigLightSources';
import { chainSocketOfType } from './operatorChain';
import { collectableNodes } from './collections';
import { buildDeleteNodesOps } from './sceneNodeActions';

beforeAll(() => registerAllNodes());

const ALL = MEMBERSHIP_WIRES;
const key = (w: Pick<MembershipWire, 'nodeType' | 'socket'>) => `${w.nodeType}.${w.socket}`;

/** The `Type.socket` names rule 3 quotes, in order. */
function rule3Wires(markdown: string): string[] {
  const start = markdown.indexOf('3. **Membership is reachability.**');
  const end = markdown.indexOf('4. **Time lives inside values.**', start);
  expect(start, 'rule 3 heading').toBeGreaterThan(-1);
  expect(end, 'rule 4 heading').toBeGreaterThan(start);
  const rule = markdown.slice(start, end);
  return [...rule.matchAll(/`([A-Z]\w*)\.([a-z]\w*)`/g)].map((m) => `${m[1]}.${m[2]}`);
}

describe('#1820 — one list of the membership wires', () => {
  it('every listed wire is an input its node type declares', () => {
    const missing = ALL.filter((w) => !getNodeType(w.nodeType)?.inputs[w.socket]).map(key);
    expect(missing).toEqual([]);
  });

  it('no wire is listed twice', () => {
    const keys = ALL.map(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rule 3 in docs/GRAPH.md quotes the list, in order', () => {
    const md = readFileSync(resolve(__dirname, '../../docs/GRAPH.md'), 'utf8');
    expect(rule3Wires(md)).toEqual(ALL.map(key));
  });

  it('parenting is not on the list: no parenting socket is a membership wire', () => {
    // #1823 — `Scene.children` was the one overlap until the scene drew its collections: it is now
    // the scene collection's own objects, and the Scene parents nothing.
    const overlap = MEMBERSHIP_WIRES.filter((w) =>
      hierarchySocketsOf({ type: w.nodeType }).includes(w.socket),
    ).map(key);
    expect(overlap).toEqual([]);
    expect(hierarchySocketsOf({ type: 'Scene' })).toEqual([]);
    expect(membershipSocketsOf('Scene')).toContain('children');
  });

  it('the three disagreements #1820 measured are each answered', () => {
    // A rig's lights are in the scene.
    expect(membershipSocketsOf('Scene')).toContain('lightRig');
    expect(membershipSocketsOf('LightRig')).toEqual(['lights']);
    // Collections are listed (and drawn, #1823).
    const collectionWires = MEMBERSHIP_WIRES.filter(
      (w) => w.nodeType === 'Collection' || w.socket === 'collections',
    );
    expect(collectionWires.map(key)).toEqual([
      'Scene.collections',
      'Collection.members',
      'Collection.collections',
    ]);
    // A Transform's chain input parents; it does not put anything in the scene.
    expect(membershipSocketsOf('Transform')).toEqual([]);
    expect(membershipSocketsOf('MaterialOverride')).toEqual([]);
  });
});

const run = (s: DagState, ops: object[]) => {
  for (const op of ops) s = applyOp(s, op as never).next;
  return s;
};

/**
 * One scene holding every case where the surfaces used to disagree (#1821, measured on main
 * `79dbee62`): an object only in a collection, an object under a Transform wrapper, a light on the
 * active lighting profile and one on an inactive profile, two cameras on a CameraSelect, and a
 * child nested under an object. The scene light, the active rig's light and one camera are also in
 * the collection (#1505), which the outliner lists them under.
 */
function disagreementScene(): DagState {
  let s = buildDefaultDagState();
  const scene = s.outputs.scene!.node;
  const SC = { node: scene, socket: 'children' };
  s = makeSplitCube(s, { objectId: 'inCh', connectTo: SC }).state;
  s = makeSplitCube(s, {
    objectId: 'nested',
    connectTo: { node: 'inCh', socket: 'children' },
  }).state;
  s = makeSplitCube(s, { objectId: 'onlyColl' }).state;
  s = makeSplitCube(s, { objectId: 'wrapped' }).state;
  s = makeSplitLight(s, {
    lightKind: 'Point',
    objectId: 'onLights',
    connectTo: { node: scene, socket: 'lights' },
  }).state;
  s = makeSplitLight(s, { lightKind: 'Point', objectId: 'activeRigLight' }).state;
  s = makeSplitLight(s, { lightKind: 'Point', objectId: 'idleRigLight' }).state;
  s = makeSplitCamera(s, { objectId: 'camA' }).state;
  s = makeSplitCamera(s, { objectId: 'camB' }).state;
  const chain = chainSocketOfType('Transform')!;
  const to = (node: string, socket: string) => ({ node, socket });
  const out = (node: string) => ({ node, socket: 'out' });
  return run(s, [
    { type: 'addNode', nodeId: 'C', nodeType: 'Collection', params: {} },
    { type: 'connect', from: out('C'), to: to(scene, 'collections') },
    { type: 'connect', from: out('onlyColl'), to: to('C', 'members') },
    // #1505 — a light on the scene's lights, a light on the active rig and a camera, each also in
    // the collection: the outliner lists them under it, and still lists them.
    { type: 'connect', from: out('onLights'), to: to('C', 'members') },
    { type: 'connect', from: out('camB'), to: to('C', 'members') },
    { type: 'addNode', nodeId: 'T', nodeType: 'Transform', params: {} },
    { type: 'connect', from: out('wrapped'), to: to('T', chain) },
    { type: 'connect', from: out('T'), to: SC },
    { type: 'addNode', nodeId: 'R1', nodeType: 'LightRig', params: { name: 'day' } },
    { type: 'addNode', nodeId: 'R2', nodeType: 'LightRig', params: { name: 'night' } },
    { type: 'connect', from: out('activeRigLight'), to: to('R1', 'lights') },
    { type: 'connect', from: out('idleRigLight'), to: to('R2', 'lights') },
    { type: 'connect', from: out('activeRigLight'), to: to('C', 'members') },
    {
      type: 'addNode',
      nodeId: 'P',
      nodeType: 'LightProfileSelect',
      params: { selectedProfile: 'day' },
    },
    { type: 'connect', from: out('R1'), to: to('P', 'rigs') },
    { type: 'connect', from: out('R2'), to: to('P', 'rigs') },
    { type: 'connect', from: out('P'), to: to(scene, 'lightRig') },
    { type: 'addNode', nodeId: 'S', nodeType: 'CameraSelect', params: { active: 'camA' } },
    { type: 'connect', from: out('camA'), to: to('S', 'cameras') },
    { type: 'connect', from: out('camB'), to: to('S', 'cameras') },
    // Displacing the seed's camera the way the camera doors do: it stays in the scene (#1518).
    { type: 'connect', from: out('n_camera'), to: SC },
    { type: 'connect', from: out('S'), to: to(scene, 'camera') },
  ]);
}

const OBJECTS = [
  'inCh',
  'nested',
  'onlyColl',
  'wrapped',
  'onLights',
  'activeRigLight',
  'idleRigLight',
  'camA',
  'camB',
];

describe('#1821 — one answer to "is this object in the scene"', () => {
  it('answers each case as rule 3 does', () => {
    const s = disagreementScene();
    const answer = Object.fromEntries(OBJECTS.map((id) => [id, isInScene(s, id)]));
    expect(answer).toEqual({
      inCh: true,
      nested: true,
      // The scene draws its collections (#1823): one listed by a collection alone is in.
      onlyColl: true,
      wrapped: true,
      onLights: true,
      activeRigLight: true,
      // Only the selected profile's lights are drawn and listed.
      idleRigLight: false,
      camA: true,
      camB: true,
    });
  });

  it('every surface gives the same answer', () => {
    const s = disagreementScene();
    const members = sceneMembersOf(s);
    const outliner = new Set(buildSceneTreeRows(s).map((r) => r.nodeId));
    const collectable = collectableNodes(s);
    const disagree = (name: string, has: (id: string) => boolean) =>
      OBJECTS.filter((id) => has(id) !== members.has(id)).map((id) => `${name}: ${id}`);
    expect([
      ...disagree('outliner', (id) => outliner.has(id)),
      ...disagree('collectable', (id) => collectable.has(id)),
    ]).toEqual([]);
    // The narrower lists ask a narrower question; each stays inside the answer.
    const outside = (name: string, ids: readonly string[]) =>
      ids.filter((id) => !members.has(id)).map((id) => `${name}: ${id}`);
    expect([
      ...outside('box-select', getViewportSelectableIds(s)),
      ...outside('camera list', enumerateCameraNodeIds(s)),
      ...outside('rig lights', resolveRigLightSources(s)),
    ]).toEqual([]);
  });

  it('the outliner lists a collection’s light, rig light and camera under it, once (#1505)', () => {
    const s = disagreementScene();
    const rows = buildSceneTreeRows(s);
    const colKey = rows.find((r) => r.nodeId === 'C')!.key;
    const where = (id: string) =>
      rows
        .filter((r) => r.nodeId === id)
        .map((r) => (r.key.startsWith(`${colKey}/`) ? 'C' : 'top'));
    expect(['onLights', 'activeRigLight', 'camB', 'camA'].map(where)).toEqual([
      ['C'],
      ['C'],
      ['C'],
      ['top'],
    ]);
    // The idle rig's light is on no wire the scene follows, so it is listed nowhere.
    expect(where('idleRigLight')).toEqual([]);
  });

  it('collectable is the answer less the nodes the wires pass through', () => {
    const s = disagreementScene();
    const expected = [...sceneMembersOf(s)].filter((id) => !HOP_TYPES.has(s.nodes[id].type));
    expect([...collectableNodes(s)].sort()).toEqual(expected.sort());
    expect(['R1', 'P', 'S'].every((id) => isInScene(s, id))).toBe(true);
  });

  it('no scene, no members', () => {
    const s = disagreementScene();
    expect(sceneMembersOf({ ...s, outputs: {} } as DagState).size).toBe(0);
  });

  it('a camera nothing wires is not in the scene: being a camera is no reason (#1518)', () => {
    const s0 = buildDefaultDagState();
    const { state: s, objectId } = makeSplitCamera(s0, { objectId: 'floating' });
    expect(isInScene(s, objectId)).toBe(false);
  });

  it('a door that replaces the active camera keeps the old one in the scene (#1518)', () => {
    const s = buildDefaultDagState();
    const scene = s.outputs.scene!.node;
    const old = (s.nodes[scene].inputs.camera as { node: string }).node;
    const unhook = {
      type: 'disconnect',
      from: { node: old, socket: 'out' },
      to: { node: scene, socket: 'camera' },
    } as const;
    expect(keepInSceneOps(s, [unhook])).toEqual([
      {
        type: 'connect',
        from: { node: old, socket: 'out' },
        to: { node: scene, socket: 'children' },
      },
    ]);
    // What the ops take away is theirs to say: a node they remove is not put back.
    expect(keepInSceneOps(s, [unhook, { type: 'removeNode', nodeId: old }])).toEqual([]);
  });
});

describe('the doors that move a camera keep it in the scene (#1517 with #1518)', () => {
  it('deleting the group holding a camera hands the camera up into the scene, in place', () => {
    let s = buildDefaultDagState();
    const scene = s.outputs.scene!.node;
    s = run(s, [
      { type: 'addNode', nodeId: 'G', nodeType: 'Group', params: { position: [1, 2, 3] } },
      {
        type: 'connect',
        from: { node: 'G', socket: 'out' },
        to: { node: scene, socket: 'children' },
      },
    ]);
    s = makeSplitCamera(s, {
      objectId: 'cam',
      position: [4, 0, 0],
      connectTo: { node: 'G', socket: 'children' },
    }).state;
    expect(isInScene(s, 'cam')).toBe(true);
    const after = run(s, buildDeleteNodesOps(s, ['G']));
    expect(after.nodes.G).toBeUndefined();
    expect(isInScene(after, 'cam')).toBe(true);
    expect(after.nodes.cam.params.position).toEqual([5, 2, 3]);
  });
});
