// #1448 — which nodes can be hidden: a scene object or a collection that carries the
// visibility params (#1503). The drawers honour those flags on every scene object, at any depth,
// and on collections, so a flag set anywhere else would show in the outliner and not in the
// picture.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../nodes/registerAll';
import { buildExampleProject } from '../core/project/examples';
import { applyOp, type DagState } from '../core/dag';
import { hideRefusal, isHideable } from './sceneVisibility';
import { newCollectionOps } from './collections';

let starter: DagState;

beforeAll(async () => {
  registerAllNodes();
  starter = (await buildExampleProject('example_starter')).state;
});

describe('which nodes can be hidden (#1448)', () => {
  it('the scene holds the cases below, so none of them passes by being absent', () => {
    const scene = starter.nodes[starter.outputs.scene!.node];
    expect((scene.inputs.children as { node: string }[]).map((r) => r.node)).toContain('n_box');
    expect((scene.inputs.lights as { node: string }[]).map((r) => r.node)).toContain('n_light');
    expect(starter.nodes.n_camera).toBeDefined();
    expect(starter.nodes.n_light_data).toBeDefined();
  });

  it('a direct child of the scene can be hidden', () => {
    expect(hideRefusal(starter, 'n_box')).toBeNull();
  });

  it('a light of the scene can be hidden', () => {
    expect(isHideable(starter, 'n_light')).toBe(true);
  });

  it('a camera can be hidden too: its frustum honours the flag (#1453)', () => {
    expect(hideRefusal(starter, 'n_camera')).toBeNull();
  });

  it("an object's data node cannot: it carries no flag, and the reason says what to hide", () => {
    expect(hideRefusal(starter, 'n_light_data')).toMatch(/carries no visibility of its own/);
    expect(hideRefusal(starter, 'n_light_data')).toMatch(/Hide the object that holds it/);
  });

  it('a node nested under a group can be hidden on its own (#1462)', () => {
    let s = starter;
    const op = (o: Parameters<typeof applyOp>[1]) => {
      s = applyOp(s, o).next;
    };
    op({ type: 'addNode', nodeId: 'grp', nodeType: 'Group', params: {} });
    op({
      type: 'disconnect',
      to: { node: s.outputs.scene!.node, socket: 'children' },
      from: { node: 'n_box', socket: 'out' },
    });
    op({
      type: 'connect',
      from: { node: 'n_box', socket: 'out' },
      to: { node: 'grp', socket: 'children' },
    });
    op({
      type: 'connect',
      from: { node: 'grp', socket: 'out' },
      to: { node: s.outputs.scene!.node, socket: 'children' },
    });
    expect(hideRefusal(s, 'grp')).toBeNull();
    expect(hideRefusal(s, 'n_box')).toBeNull();
  });

  it('an object outside the scene cannot: hiding it would change nothing', () => {
    const s = applyOp(starter, {
      type: 'addNode',
      nodeId: 'loose',
      nodeType: 'Group',
      params: {},
    }).next;
    expect(hideRefusal(s, 'loose')).toMatch(/is not in the scene/);
  });

  it('a collection can be hidden', () => {
    const made = newCollectionOps(starter)!;
    const s = made.ops.reduce((st, o) => applyOp(st, o).next, starter);
    expect(hideRefusal(s, made.collectionId)).toBeNull();
  });

  it('a node that does not exist is refused by name', () => {
    expect(hideRefusal(starter, 'nope')).toMatch(/"nope" is not in the scene graph/);
  });
});
