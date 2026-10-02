// #1448 — which nodes can be hidden: a direct child or light of the scene, never a camera,
// never something nested under a top-level object. The renderer skips a hidden node in
// exactly those two bands, so a flag set anywhere else would show in the outliner and not
// in the picture.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../nodes/registerAll';
import { buildExampleProject } from '../core/project/examples';
import { applyOp, type DagState } from '../core/dag';
import { hideRefusal, isHideable } from './sceneVisibility';

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
  });

  it('a direct child of the scene can be hidden', () => {
    expect(hideRefusal(starter, 'n_box')).toBeNull();
  });

  it('a direct light of the scene can be hidden', () => {
    expect(isHideable(starter, 'n_light')).toBe(true);
  });

  it('a camera cannot: it is chosen, not hidden', () => {
    // The camera's own reason, not the generic one: its id contains "camera", so a looser match
    // would pass on the id alone.
    expect(hideRefusal(starter, 'n_camera')).toMatch(/cameras are chosen with Set Active Camera/);
  });

  it("a top-level object's data node cannot: the band holds the object", () => {
    expect(hideRefusal(starter, 'n_light_data')).toMatch(/not a direct child or light/);
  });

  it('a node nested under a group cannot, and the reason says what to hide instead', () => {
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
    expect(hideRefusal(s, 'n_box')).toMatch(/top-level object that holds it/);
  });

  it('a node that does not exist is refused by name', () => {
    expect(hideRefusal(starter, 'nope')).toMatch(/"nope" is not in the scene graph/);
  });
});
