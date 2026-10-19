import { describe, it, expect } from 'vitest';
import { sceneGraphOf } from './sceneGraph';
import { nodeHeight, viewEdgesOf, viewRowsOf } from '../core/dag/layout';
import { buildDefaultDagState } from '../core/project/default';
import { applyOps } from '../core/dag/ops';
import { rawSpringOps } from '../test-utils/rawSpring';
import { plazaState } from '../test-utils/plazaGraph';
import { registerAllNodes } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';

// The references come from each node type's declared `idRefs`, so the registry has to be loaded.
registerAllNodes();

const ids = (g: { nodes: readonly { id: string }[] }) => g.nodes.map((n) => n.id).sort();

/** The default scene with a spring on its box: a Solver whose body is its own level. */
function withSpring(): DagState {
  const base = applyOps(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'ctl',
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'connect',
      from: { node: 'ctl', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ]).next;
  return applyOps(
    base,
    rawSpringOps(base, { targetId: 'n_box', controllerId: 'ctl', idFor: (k) => `s_${k}` }),
  ).next;
}

describe('sceneGraphOf — #1675 the scene as nodes', () => {
  it('draws every wire from the inputs', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: true, showAnimation: true });
    const wires = g.wires.filter((w) => !w.ref).map((w) => `${w.from}>${w.to}.${w.toSocket}`);
    expect(wires).toContain('scene>render.scene');
    expect(wires).toContain('bodyMesh>body.data');
    expect(wires).toContain('runner>scene.children');
    expect(g.nodes.find((n) => n.id === 'scene')!.inputs).toContainEqual({
      socket: 'children',
      count: 3,
      ref: false,
    });
  });

  it('draws references from the declared idRefs, pointing the way they act', () => {
    const refs = sceneGraphOf(plazaState(), { showHidden: true, showAnimation: true })
      .wires.filter((w) => w.ref)
      .map((w) => `${w.from}>${w.to}.${w.toSocket}`)
      .sort();
    // The keys animate the camera's position; the Track To turns the camera and reads its aim.
    expect(refs).toEqual([
      'body>track.aimNode',
      'camKeys>cam.position',
      'standInKeys>standIn.position',
      'track>cam.TrackTo',
    ]);
  });

  it('leaves out the stand-in whose every drawable is hidden, and what only served it', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: false, showAnimation: true });
    expect(ids(g)).toEqual(
      [
        'body',
        'bodyMesh',
        'cam',
        'camData',
        'camKeys',
        'empty',
        'render',
        'rig',
        'runner',
        'scene',
        'tile',
        'tileMesh',
        'track',
      ].sort(),
    );
    expect(g.omitted).toBe(5);
    expect(g.wires.some((w) => w.from.startsWith('standIn') || w.to.startsWith('standIn'))).toBe(
      false,
    );
  });

  it('keeps a chain of empty groups that nothing hid (the runner keeps its imported transforms)', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: false, showAnimation: true });
    expect(ids(g)).toContain('rig');
    expect(ids(g)).toContain('empty');
  });

  it('keeps a piece with a hidden part when another part still draws', () => {
    const s = plazaState();
    (s.nodes.standIn.inputs.children as unknown as { node: string; socket: string }[]).push({
      node: 'tile',
      socket: 'out',
    });
    const g = sceneGraphOf(s, { showHidden: false, showAnimation: true });
    expect(ids(g)).toContain('standIn');
    expect(ids(g)).not.toContain('standInBody');
  });

  it('shows everything, hidden flagged, when asked', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: true, showAnimation: true });
    expect(g.nodes).toHaveLength(Object.keys(plazaState().nodes).length);
    expect(g.omitted).toBe(0);
    expect(g.nodes.find((n) => n.id === 'standInBody')!.hidden).toBe(true);
  });
});

describe('sceneGraphOf — #1563 one level at a time', () => {
  it('the top level shows the owner and not what is inside it; going in shows only that', () => {
    const s = withSpring();
    const top = sceneGraphOf(s, { showHidden: true, showAnimation: true });
    const solver = top.nodes.find((n) => n.id === 's_solver')!;
    expect(solver.inside).toBeGreaterThan(3);
    expect(top.path).toEqual([]);

    const body = sceneGraphOf(s, { showHidden: true, showAnimation: true, level: 's_solver' });
    expect(body.path).toEqual(['s_solver']);
    expect(body.nodes).toHaveLength(solver.inside);
    const inside = new Set(body.nodes.map((n) => n.id));
    expect(top.nodes.some((n) => inside.has(n.id))).toBe(false);
    // Every node is shown at exactly one level.
    expect(top.nodes.length + body.nodes.length).toBe(Object.keys(s.nodes).length);
    // A line is drawn only when both its ends are at the level shown.
    for (const g of [top, body]) {
      const here = new Set(g.nodes.map((n) => n.id));
      for (const w of g.wires) expect(here.has(w.from) && here.has(w.to)).toBe(true);
    }
  });

  it('a level whose owner is gone, or that is no owner, reads as the top level', () => {
    const g = sceneGraphOf(plazaState(), {
      showHidden: true,
      showAnimation: true,
      level: 'nothing',
    });
    expect(g.path).toEqual([]);
    expect(g.nodes).toHaveLength(Object.keys(plazaState().nodes).length);
    // So does a node that is there but holds no sub-network.
    expect(sceneGraphOf(plazaState(), { showHidden: true, level: 'cam' }).path).toEqual([]);
  });
});

describe('sceneGraphOf — #1563 what the node view shows beside the nodes', () => {
  it('hides animation, constraints and drivers by default, and tints the row they drive', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: true });
    const ids = g.nodes.map((n) => n.id);
    // The keys and the Track To act only on what they name, and no wire reads them.
    for (const id of ['camKeys', 'track', 'standInKeys']) expect(ids).not.toContain(id);
    expect(g.animation).toBe(3);
    const cam = g.nodes.find((n) => n.id === 'cam')!;
    expect(cam.inputs).toContainEqual({
      socket: 'position',
      count: 1,
      ref: true,
      tint: 'KeyframeChannelVec3',
    });
    expect(cam.inputs).toContainEqual({ socket: 'TrackTo', count: 1, ref: true, tint: 'TrackTo' });
    // No line is drawn from or to a node the view left out.
    expect(g.wires.some((w) => !ids.includes(w.from) || !ids.includes(w.to))).toBe(false);
    // The Track To's aim is a read of the body: hidden with the Track To, not tinted on it.
    expect(g.nodes.find((n) => n.id === 'body')!.inputs.some((r) => r.tint)).toBe(false);
  });

  it('a tint on a row already drawn joins it, so no node is taller than the layout spaced it', () => {
    // A second channel on the camera's position that a wire reads, so it stays drawn.
    const s = plazaState();
    const both = {
      ...s,
      nodes: {
        ...s.nodes,
        camKeys2: { ...s.nodes.camKeys, id: 'camKeys2' },
        reader: {
          id: 'reader',
          type: 'Group',
          params: {},
          inputs: { children: [{ node: 'camKeys2', socket: 'out' }] },
        },
      },
    } as unknown as DagState;
    const g = sceneGraphOf(both, { showHidden: true });
    const cam = g.nodes.find((n) => n.id === 'cam')!;
    expect(cam.inputs.filter((r) => r.socket === 'position')).toEqual([
      { socket: 'position', count: 2, ref: true, tint: 'KeyframeChannelVec3' },
    ]);
    const core = viewRowsOf(viewEdgesOf(both));
    for (const n of g.nodes) {
      expect(nodeHeight(n.inputs.length, n.outputs.length), n.id).toBeLessThanOrEqual(
        nodeHeight(core.inputs.get(n.id)?.length ?? 0, core.outputs.get(n.id)?.length ?? 0),
      );
    }
  });

  it('a driver fed by a wire stays drawn: hiding it would cut the wire it ends', () => {
    const g = sceneGraphOf(withSpring(), { showHidden: true });
    expect(g.nodes.map((n) => n.id)).toContain('s_driver');
    expect(g.wires.some((w) => w.from === 's_solver' && w.to === 's_driver')).toBe(true);
    expect(g.animation).toBe(0);
  });

  it('says whose name a node follows', () => {
    const s = plazaState();
    const named = {
      ...s,
      nodes: { ...s.nodes, bodyMesh: { ...s.nodes.bodyMesh, meta: { nameFrom: 'body' } } },
    } as unknown as DagState;
    const g = sceneGraphOf(named, { showHidden: true });
    expect(g.nodes.find((n) => n.id === 'bodyMesh')!.namedAfter).toBe('body');
    expect(g.nodes.find((n) => n.id === 'tileMesh')!.namedAfter).toBeNull();
  });

  it('CONTROL: shown, they are nodes again and nothing is tinted', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: true, showAnimation: true });
    expect(g.animation).toBe(0);
    expect(g.nodes.some((n) => n.inputs.some((r) => r.tint))).toBe(false);
    expect(g.nodes.map((n) => n.id)).toContain('camKeys');
  });

  it('flags the nodes the scene and render outputs are bound to', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: true });
    const flags = Object.fromEntries(
      g.nodes.filter((n) => n.flags.length).map((n) => [n.id, n.flags]),
    );
    expect(flags).toEqual({ scene: ['scene'], render: ['render'] });
  });

  it('marks what changes with time, as the evaluator decides it', () => {
    const g = sceneGraphOf(buildDefaultDagState(), { showHidden: true });
    const timed = g.nodes.filter((n) => n.timeDependent).map((n) => n.id);
    expect(timed).toContain('n_time');
    expect(timed).not.toContain('n_box');
  });

  it('counts the lines that lead to another level, and not an owner’s own sub-network', () => {
    const s = withSpring();
    // A channel at the top level animating a node inside the Solver.
    const crossing = {
      ...s,
      nodes: {
        ...s.nodes,
        keys: {
          id: 'keys',
          type: 'KeyframeChannelVec3',
          params: { target: 's_acc', paramPath: 'b' },
          inputs: {},
        },
      },
    } as unknown as DagState;
    const top = sceneGraphOf(crossing, { showHidden: true, showAnimation: true });
    const inside = sceneGraphOf(crossing, {
      showHidden: true,
      showAnimation: true,
      level: 's_solver',
    });
    expect(top.nodes.find((n) => n.id === 'keys')!.away).toBe(1);
    expect(inside.nodes.find((n) => n.id === 's_acc')!.away).toBe(1);
    // The Solver is wired to its body; that is what "inside" means, not a line elsewhere.
    expect(top.nodes.find((n) => n.id === 's_solver')!.away).toBe(0);
    expect(
      sceneGraphOf(s, { showHidden: true, showAnimation: true }).nodes.every((n) => !n.away),
    ).toBe(true);
  });
});
