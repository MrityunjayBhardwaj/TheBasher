import { describe, it, expect } from 'vitest';
import { sceneGraphOf } from './sceneGraph';
import { buildDefaultDagState } from '../core/project/default';
import { applyOps } from '../core/dag/ops';
import { rawSpringOps } from '../test-utils/rawSpring';
import { plazaState } from '../test-utils/plazaGraph';
import { registerAllNodes } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';

// The references come from each node type's declared `idRefs`, so the registry has to be loaded.
registerAllNodes();

const ids = (g: { nodes: readonly { id: string }[] }) => g.nodes.map((n) => n.id).sort();

describe('sceneGraphOf — #1675 the scene as nodes', () => {
  it('draws every wire from the inputs', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: true });
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
    const refs = sceneGraphOf(plazaState(), { showHidden: true })
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
    const g = sceneGraphOf(plazaState(), { showHidden: false });
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
    const g = sceneGraphOf(plazaState(), { showHidden: false });
    expect(ids(g)).toContain('rig');
    expect(ids(g)).toContain('empty');
  });

  it('keeps a piece with a hidden part when another part still draws', () => {
    const s = plazaState();
    (s.nodes.standIn.inputs.children as unknown as { node: string; socket: string }[]).push({
      node: 'tile',
      socket: 'out',
    });
    const g = sceneGraphOf(s, { showHidden: false });
    expect(ids(g)).toContain('standIn');
    expect(ids(g)).not.toContain('standInBody');
  });

  it('shows everything, hidden flagged, when asked', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: true });
    expect(g.nodes).toHaveLength(Object.keys(plazaState().nodes).length);
    expect(g.omitted).toBe(0);
    expect(g.nodes.find((n) => n.id === 'standInBody')!.hidden).toBe(true);
  });
});

describe('sceneGraphOf — #1563 one level at a time', () => {
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

  it('the top level shows the owner and not what is inside it; going in shows only that', () => {
    const s = withSpring();
    const top = sceneGraphOf(s, { showHidden: true });
    const solver = top.nodes.find((n) => n.id === 's_solver')!;
    expect(solver.inside).toBeGreaterThan(3);
    expect(top.path).toEqual([]);

    const body = sceneGraphOf(s, { showHidden: true, level: 's_solver' });
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

  it('a level whose owner is gone reads as the top level', () => {
    const g = sceneGraphOf(plazaState(), { showHidden: true, level: 'nothing' });
    expect(g.path).toEqual([]);
    expect(g.nodes).toHaveLength(Object.keys(plazaState().nodes).length);
  });
});
