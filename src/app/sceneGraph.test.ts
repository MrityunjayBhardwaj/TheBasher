import { describe, it, expect } from 'vitest';
import { layoutGraph, sceneGraphOf } from './sceneGraph';
import { registerAllNodes } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';

// The references come from each node type's declared `idRefs`, so the registry has to be loaded.
registerAllNodes();

// The plaza run in miniature: a camera aimed at the runner by a Track To and pushed in by keys,
// the runner (a group holding a meshed object and a chain of empty transforms), a ground tile, and a
// stand-in character left in the file with its only drawable hidden.
function plazaState(): DagState {
  return {
    nodes: {
      render: {
        id: 'render',
        type: 'RenderOutput',
        params: {},
        inputs: { scene: { node: 'scene', socket: 'out' } },
      },
      scene: {
        id: 'scene',
        type: 'Scene',
        params: {},
        inputs: {
          camera: { node: 'cam', socket: 'out' },
          children: [
            { node: 'runner', socket: 'out' },
            { node: 'tile', socket: 'out' },
            { node: 'standIn', socket: 'out' },
          ],
        },
      },
      cam: {
        id: 'cam',
        type: 'Object',
        params: {},
        inputs: { data: { node: 'camData', socket: 'out' } },
      },
      camData: { id: 'camData', type: 'CameraData', params: {}, inputs: {} },
      camKeys: {
        id: 'camKeys',
        type: 'KeyframeChannelVec3',
        params: { target: 'cam', paramPath: 'position' },
        inputs: {},
      },
      track: {
        id: 'track',
        type: 'TrackTo',
        params: { target: 'cam', aimNode: 'body' },
        inputs: {},
      },
      runner: {
        id: 'runner',
        type: 'Group',
        params: {},
        inputs: {
          children: [
            { node: 'rig', socket: 'out' },
            { node: 'body', socket: 'out' },
          ],
        },
      },
      // An imported transform chain that holds no geometry, as glTF imports carry.
      rig: {
        id: 'rig',
        type: 'Group',
        params: {},
        inputs: { children: [{ node: 'empty', socket: 'out' }] },
      },
      empty: { id: 'empty', type: 'Group', params: {}, inputs: {} },
      body: {
        id: 'body',
        type: 'Object',
        params: {},
        inputs: { data: { node: 'bodyMesh', socket: 'out' } },
      },
      bodyMesh: { id: 'bodyMesh', type: 'PolyMeshData', params: {}, inputs: {} },
      tile: {
        id: 'tile',
        type: 'Object',
        params: {},
        inputs: { data: { node: 'tileMesh', socket: 'out' } },
      },
      tileMesh: { id: 'tileMesh', type: 'PolyMeshData', params: {}, inputs: {} },
      standIn: {
        id: 'standIn',
        type: 'Group',
        params: {},
        inputs: {
          children: [
            { node: 'standInEmpty', socket: 'out' },
            { node: 'standInBody', socket: 'out' },
          ],
        },
      },
      standInEmpty: { id: 'standInEmpty', type: 'Group', params: {}, inputs: {} },
      standInBody: {
        id: 'standInBody',
        type: 'Object',
        params: { viewport: false },
        inputs: { data: { node: 'standInMesh', socket: 'out' } },
      },
      standInMesh: { id: 'standInMesh', type: 'PolyMeshData', params: {}, inputs: {} },
      standInKeys: {
        id: 'standInKeys',
        type: 'KeyframeChannelVec3',
        params: { target: 'standIn', paramPath: 'position' },
        inputs: {},
      },
    },
    outputs: { scene: { node: 'scene', socket: 'out' }, render: { node: 'render', socket: 'out' } },
  } as unknown as DagState;
}

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

describe('layoutGraph — #1675 data flows left to right', () => {
  const O = { width: 200, colGap: 80, rowGap: 12 };
  const laid = () => {
    const g = sceneGraphOf(plazaState(), { showHidden: true });
    const boxes = g.nodes.map((n) => ({ id: n.id, height: 40 + n.inputs.length * 18 }));
    return { g, boxes, l: layoutGraph(boxes, g.wires, O) };
  };

  it('never runs a wire right to left', () => {
    const { g, l } = laid();
    for (const w of g.wires)
      expect(l.pos.get(w.from)!.x, `${w.from} → ${w.to}`).toBeLessThan(l.pos.get(w.to)!.x);
  });

  it('puts the render in the last column', () => {
    const { l } = laid();
    expect(l.pos.get('render')!.x).toBe(Math.max(...[...l.pos.values()].map((p) => p.x)));
  });

  it('never overlaps two nodes in a column', () => {
    const { boxes, l } = laid();
    const h = new Map(boxes.map((b) => [b.id, b.height]));
    const byX = new Map<number, string[]>();
    for (const [id, p] of l.pos) byX.set(p.x, [...(byX.get(p.x) ?? []), id]);
    for (const col of byX.values()) {
      const sorted = col.sort((a, b) => l.pos.get(a)!.y - l.pos.get(b)!.y);
      for (let i = 1; i < sorted.length; i++) {
        expect(l.pos.get(sorted[i])!.y).toBeGreaterThanOrEqual(
          l.pos.get(sorted[i - 1])!.y + h.get(sorted[i - 1])! + O.rowGap - 1e-6,
        );
      }
    }
  });

  it('pulls a source beside its reader rather than leaving it at the far left', () => {
    // The camera sits deep (the runner's body → the Track To → the camera); its lens has no
    // inputs, so a plain longest-path ranking would leave it in the first column.
    const { l } = laid();
    expect(l.pos.get('cam')!.x).toBeGreaterThan(O.width + O.colGap);
    expect(l.pos.get('camData')!.x).toBe(l.pos.get('cam')!.x - (O.width + O.colGap));
  });

  it('survives a cycle and still places every node', () => {
    const l = layoutGraph(
      [
        { id: 'a', height: 40 },
        { id: 'b', height: 40 },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
      O,
    );
    expect(l.pos.size).toBe(2);
  });
});
