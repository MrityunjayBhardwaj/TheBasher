// #1823 — the scene draws what its own list and its collections hold, as a nested tree: each
// member under its parent, an ancestor that is not a member carried hidden, and nothing twice.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import type { RenderOutputValue, SceneChild } from '../nodes/types';
import { makeSplitCube } from '../test-utils/splitCube';
import { hiddenNodes } from './collections';
import { resolveWorldTransform } from './resolveWorldTransform';
import { isInScene, sceneChildRefs } from './sceneMembership';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
const apply = (s: DagState, ops: readonly Op[]) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);
const out = (node: string) => ({ node, socket: 'out' });
const connect = (from: string, to: string, socket: string): Op => ({
  type: 'connect',
  from: out(from),
  to: { node: to, socket },
});
const collection = (id: string, scene: string): Op[] => [
  { type: 'addNode', nodeId: id, nodeType: 'Collection', params: {} },
  connect(id, scene, 'collections'),
];
const group = (id: string, position: [number, number, number]): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'Group',
  params: { position },
});
const hang = (child: string, parent: string): Op => ({
  type: 'connect',
  from: { node: parent, socket: 'world' },
  to: { node: child, socket: 'parent' },
});

/** The node ids the render draws at the top of its scene, checked against the render's value. */
function drawnIds(s: DagState): { tops: string[] } {
  const value = evaluate(s, s.outputs.render!.node, { ctx: CTX }).value as RenderOutputValue;
  const tops = sceneChildRefs(s).map((r) => r.node);
  expect(value.scene.children).toHaveLength(tops.length);
  return { tops };
}

const scene = (s: DagState) => s.outputs.scene!.node;
const position = (s: DagState, id: string) =>
  resolveWorldTransform(s, id, CTX)?.position.map((v) => +v.toFixed(6)) ?? null;

describe('#1823 — the scene draws its collections', () => {
  it('an object only in a collection is drawn; one in no list is not', () => {
    let s = buildDefaultDagState();
    s = makeSplitCube(s, { objectId: 'inColl', position: [3, 0, 0] }).state;
    s = makeSplitCube(s, { objectId: 'nowhere', position: [5, 0, 0] }).state;
    s = apply(s, [...collection('C', scene(s)), connect('inColl', 'C', 'members')]);
    expect(isInScene(s, 'inColl')).toBe(true);
    expect(drawnIds(s).tops).toContain('inColl');
    expect(position(s, 'inColl')).toEqual([3, 0, 0]);
    expect(isInScene(s, 'nowhere')).toBe(false);
    expect(drawnIds(s).tops).not.toContain('nowhere');
    expect(position(s, 'nowhere')).toBeNull();
  });

  it('an object in two collections is drawn once', () => {
    let s = buildDefaultDagState();
    s = makeSplitCube(s, { objectId: 'twice' }).state;
    s = apply(s, [
      ...collection('A', scene(s)),
      ...collection('B', scene(s)),
      connect('twice', 'A', 'members'),
      connect('twice', 'B', 'members'),
    ]);
    expect(drawnIds(s).tops.filter((id) => id === 'twice')).toHaveLength(1);
    // And listed by the scene's own list too, still once.
    s = apply(s, [connect('twice', scene(s), 'children')]);
    expect(drawnIds(s).tops.filter((id) => id === 'twice')).toHaveLength(1);
  });

  it('a hidden collection hides what it alone holds, in the viewport and the render', () => {
    let s = buildDefaultDagState();
    s = makeSplitCube(s, { objectId: 'inColl' }).state;
    s = apply(s, [
      ...collection('C', scene(s)),
      connect('inColl', 'C', 'members'),
      { type: 'setParam', nodeId: 'C', paramPath: 'viewport', value: false },
      { type: 'setParam', nodeId: 'C', paramPath: 'render', value: false },
    ]);
    expect(hiddenNodes(s, 'viewport').has('inColl')).toBe(true);
    expect(hiddenNodes(s, 'render').has('inColl')).toBe(true);
  });

  it('a member under a parent that is not one stands at its world; the parent carries it hidden', () => {
    let s = buildDefaultDagState();
    s = makeSplitCube(s, { objectId: 'kid', position: [1, 0, 0] }).state;
    s = apply(s, [
      group('carrier', [0, 4, 0]),
      hang('kid', 'carrier'),
      ...collection('C', scene(s)),
      connect('kid', 'C', 'members'),
    ]);
    expect(isInScene(s, 'carrier')).toBe(false);
    expect(drawnIds(s).tops).toEqual(expect.arrayContaining(['carrier']));
    expect(drawnIds(s).tops).not.toContain('kid');
    expect(position(s, 'kid')).toEqual([1, 4, 0]);
    expect(hiddenNodes(s, 'viewport').has('carrier')).toBe(true);
    expect(hiddenNodes(s, 'render').has('carrier')).toBe(true);
    expect(hiddenNodes(s, 'viewport').has('kid')).toBe(false);
  });

  it('a child that is not a member is not drawn, though its parent is', () => {
    let s = buildDefaultDagState();
    s = makeSplitCube(s, { objectId: 'kid', position: [1, 0, 0] }).state;
    s = apply(s, [hang('kid', 'n_box')]);
    expect(isInScene(s, 'n_box')).toBe(true);
    expect(isInScene(s, 'kid')).toBe(false);
    const box = evaluate(s, 'n_box', { ctx: CTX }).value as { children?: SceneChild[] };
    expect(box.children ?? []).toHaveLength(0);
    expect(position(s, 'kid')).toBeNull();
    // CONTROL: listed in the scene, the same child is drawn under the box.
    s = apply(s, [connect('kid', scene(s), 'children')]);
    const listed = evaluate(s, 'n_box', { ctx: CTX }).value as { children?: SceneChild[] };
    expect(listed.children ?? []).toHaveLength(1);
    expect(position(s, 'kid')).not.toBeNull();
    expect(drawnIds(s).tops).not.toContain('kid');
  });
});
