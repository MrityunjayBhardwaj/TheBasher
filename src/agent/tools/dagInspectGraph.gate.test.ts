// #1564 — the agent and the node view see the same graph.
//
// `dag.inspect` scope=graph prints the node view's own projection (`sceneGraphOf`), with
// nothing left out, one level at a time. Gate: on a scene with two levels, a keyframe channel
// and a line between levels, the agent's description and the view agree node for node and line
// for line at every level, and every line in the graph is accounted for: drawn at its level,
// counted as leaving it, or the wire between an owner and its own sub-network.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../../core/project/default';
import { applyOps } from '../../core/dag/ops';
import type { DagState } from '../../core/dag/state';
import { levelOf, viewEdgesOf } from '../../core/dag/layout';
import { rawSpringOps } from '../../test-utils/rawSpring';
import { sceneGraphOf } from '../../app/sceneGraph';
import { dagInspectTool } from './dagInspect';

beforeAll(() => registerAllNodes());

/** The default scene with a spring on its box, keys on the camera, and keys at the top level
 *  aimed at a node inside the Solver. */
function scene(): DagState {
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
  const s = applyOps(
    base,
    rawSpringOps(base, { targetId: 'n_box', controllerId: 'ctl', idFor: (k) => `s_${k}` }),
  ).next;
  const keys = (id: string, target: string, paramPath: string) => ({
    id,
    type: 'KeyframeChannelVec3',
    version: 1,
    params: { target, paramPath },
    inputs: {},
  });
  return {
    ...s,
    nodes: {
      ...s.nodes,
      camKeys: keys('camKeys', 'n_camera', 'position'),
      deepKeys: keys('deepKeys', 's_acc', 'b'),
    },
  } as unknown as DagState;
}

interface Described {
  level: string | null;
  path: string[];
  nodes: { id: string; flags?: string[]; inside?: number; linesToOtherLevels?: number }[];
  wires: string[];
  references: string[];
}

const describeGraph = (state: DagState, level?: string): Described =>
  JSON.parse(
    (
      dagInspectTool.handler({ scope: 'graph', level } as never, { dagState: state } as never) as {
        text: string;
      }
    ).text,
  );

const lineOf = (w: {
  from: string;
  fromSocket: string;
  to: string;
  toSocket: string;
  ref: boolean;
}) =>
  w.ref
    ? `${w.from} -> ${w.to}.${w.toSocket}`
    : `${w.from}.${w.fromSocket} -> ${w.to}.${w.toSocket}`;

describe('#1564 — dag.inspect scope=graph is the node view, everything shown', () => {
  it('agrees with the view node for node and line for line, at every level', () => {
    const s = scene();
    for (const level of [undefined, 's_solver']) {
      const agent = describeGraph(s, level);
      const view = sceneGraphOf(s, { showHidden: true, showAnimation: true, level });
      expect(agent.nodes.map((n) => n.id)).toEqual(view.nodes.map((n) => n.id));
      expect(agent.wires).toEqual(view.wires.filter((w) => !w.ref).map(lineOf));
      expect(agent.references).toEqual(view.wires.filter((w) => w.ref).map(lineOf));
      expect(agent.path).toEqual(view.path);
    }
    const top = describeGraph(s);
    expect(top.nodes.find((n) => n.id === 's_solver')!.inside).toBeGreaterThan(3);
    expect(top.nodes.find((n) => n.id === 'n_scene')!.flags).toEqual(['scene']);
    expect(top.references).toContain('camKeys -> n_camera.position');
  });

  it('accounts for every line in the graph exactly once', () => {
    const s = scene();
    const levels = levelOf(s);
    const drawn = new Set<string>();
    let away = 0;
    for (const level of [undefined, ...new Set([...levels.values()].filter((l) => l !== null))]) {
      const d = describeGraph(s, level ?? undefined);
      for (const line of [...d.wires, ...d.references]) {
        expect(drawn.has(line), line).toBe(false);
        drawn.add(line);
      }
      for (const n of d.nodes) away += n.linesToOtherLevels ?? 0;
    }
    let crossing = 0;
    let body = 0;
    for (const e of viewEdgesOf(s)) {
      const a = levels.get(e.from) ?? null;
      const b = levels.get(e.to) ?? null;
      if (a === b) expect(drawn.has(lineOf(e)), lineOf(e)).toBe(true);
      else if (a === e.to || b === e.from) body++;
      else crossing++;
    }
    // A line between levels is counted at both of its ends.
    expect(crossing).toBe(1);
    expect(away).toBe(2 * crossing);
    expect(body).toBeGreaterThan(0);
    expect(drawn.size + crossing + body).toBe(viewEdgesOf(s).length);
  });

  it('refuses a level that is not there or holds no sub-network, and says which', () => {
    const s = scene();
    const ask = (level: string) =>
      (
        dagInspectTool.handler({ scope: 'graph', level } as never, { dagState: s } as never) as {
          text: string;
        }
      ).text;
    expect(ask('nope')).toBe('Error: node "nope" not found');
    expect(ask('n_box')).toBe('Error: node "n_box" holds no sub-network');
  });
});
