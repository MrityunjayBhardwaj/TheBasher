// #1559 — Lag and Spring as Solver presets: each built-in instance computes exactly what the Lag
// node and the spring network compute today, on every frame.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOps } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import { syncTemplateTypes, templatesOf } from '../core/dag/templates';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { builtinDefinition, placeBuiltin } from './builtinTemplates';
import { buildSpringOps } from './solverBind';

const FRAMES = Array.from({ length: 61 }, (_, f) => f);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string): Op =>
  ({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket } }) as Op;
const value = (s: DagState, id: string, frame: number, socket?: string) => {
  const v = evaluate(s, id, {
    ctx: { time: { frame, seconds: frame / 60, normalized: 0 } },
    ...(socket ? { socket } : {}),
  }).value;
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'out' in v
    ? (v as { out: unknown }).out
    : v;
};
const store = () => useDagStore.getState();
const dag = () => store().state;

/** A Null swept along x and y, so both a channel and a whole position move. */
const sweep: Op[] = [
  node('nul', 'Null', { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
  wire('nul', 'n_scene', 'children'),
  node('nul_tx', 'KeyframeChannelVec3', {
    name: 'position',
    target: 'nul',
    paramPath: 'position',
    keyframes: [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 0.3, value: [6, 2, 0], easing: 'linear' },
      { time: 0.7, value: [-3, 4, 1], easing: 'linear' },
      { time: 1, value: [1, -1, 0], easing: 'linear' },
    ],
  }),
];

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  store().reset();
  syncTemplateTypes({ nodes: {} });
  store().hydrate(applyOps(buildDefaultDagState(), sweep).next);
});

/** Add the built-in `name` as `id`, holding `params`, through the store. */
function place(name: 'Lag' | 'Spring', id: string, params: Record<string, unknown>) {
  const r = placeBuiltin(dag(), name, id, params);
  if (!r.ok) throw new Error(r.reason);
  store().dispatchAtomic(r.ops, 'user', `add ${name}`);
}

describe('#1559 — the Lag preset is the Lag node', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['the default factor', {}],
    ['factor 0.25', { factor: 0.25 }],
    ['a start frame of 10', { factor: 0.3, seedFrame: 10 }],
    ['a factor above 1, clamped', { factor: 1.5 }],
    ['a factor below 0, clamped', { factor: -0.3 }],
  ];
  for (const [label, params] of cases) {
    it(`frame for frame, ${label}`, () => {
      const source = { node: 'nul', channel: 'tx' };
      store().dispatchAtomic([node('lag', 'Lag', { ...params, sourceTransform: source })]);
      place('Lag', 'pre', { ...params, sourceTransform: source });
      const s = dag();
      const lag = FRAMES.map((f) => value(s, 'lag', f));
      // A factor clamped to 0 holds the seed, so only a moving Lag has to move.
      if (((params.factor as number | undefined) ?? 0.2) > 0)
        expect(new Set(lag).size).toBeGreaterThan(10);
      expect(FRAMES.map((f) => value(s, 'pre', f))).toEqual(lag);
    });
  }

  it('with a remapped controller channel', () => {
    const source = {
      node: 'nul',
      channel: 'ty',
      remap: { inMin: 0, inMax: 4, outMin: 10, outMax: 20 },
    };
    store().dispatchAtomic([node('lag', 'Lag', { factor: 0.4, sourceTransform: source })]);
    place('Lag', 'pre', { factor: 0.4, sourceTransform: source });
    const s = dag();
    expect(FRAMES.map((f) => value(s, 'pre', f))).toEqual(FRAMES.map((f) => value(s, 'lag', f)));
  });

  it('trailing what is wired into its `in` when it names no controller', () => {
    store().dispatchAtomic([
      node('four', 'Fit', { outMin: 4, outMax: 4 }),
      node('lag', 'Lag', { factor: 0.5 }),
      wire('four', 'lag', 'in'),
    ]);
    place('Lag', 'pre', { factor: 0.5 });
    store().dispatchAtomic([wire('four', 'pre', 'in')]);
    const s = dag();
    expect(FRAMES.map((f) => value(s, 'pre', f))).toEqual(FRAMES.map((f) => value(s, 'lag', f)));
    expect(value(s, 'pre', 30)).toBe(4);
  });
});

describe('#1559 — the Spring preset is the spring network', () => {
  /** Today's spring on the box, from `buildSpringOps`, and a preset instance beside it. */
  function both(stiffness?: number, damping?: number) {
    const built = buildSpringOps(dag(), {
      targetId: 'n_box',
      controllerId: 'nul',
      idFor: (k) => `sp_${k}`,
      ...(stiffness !== undefined ? { stiffness } : {}),
      ...(damping !== undefined ? { damping } : {}),
    });
    if (!built.ok) throw new Error(built.reason);
    store().dispatchAtomic(built.ops);
    place('Spring', 'pre', {
      sourceTransformVec: { node: 'nul' },
      ...(stiffness !== undefined ? { stiffness } : {}),
      ...(damping !== undefined ? { damping } : {}),
    });
    const s = dag();
    return {
      network: FRAMES.map((f) => value(s, 'sp_solver', f, 'outVec')),
      preset: FRAMES.map((f) => value(s, 'pre', f)),
    };
  }

  it('frame for frame, at the default feel', () => {
    const { network, preset } = both();
    expect(new Set(network.map((v) => JSON.stringify(v))).size).toBeGreaterThan(10);
    expect(preset).toEqual(network);
  });

  it('frame for frame, at a stiffness and damping of its own', () => {
    const { network, preset } = both(0.3, 0.05);
    expect(preset).toEqual(network);
  });
});

describe('#1559 — a built-in is copied into the project once', () => {
  it('the first use adds its definition, the second reuses it', () => {
    place('Lag', 'a', {});
    place('Lag', 'b', {});
    const holders = Object.values(dag().nodes).filter((n) => n.type === 'TemplateDefinition');
    expect(holders).toHaveLength(1);
    expect(templatesOf(dag()).get('template.Lag')!.definition).toEqual(builtinDefinition('Lag'));
  });

  it('one undo takes the first use back, definition and all', () => {
    const before = Object.keys(dag().nodes).length;
    place('Lag', 'a', {});
    store().undo();
    expect(Object.keys(dag().nodes)).toHaveLength(before);
    expect(templatesOf(dag()).size).toBe(0);
  });

  it('a project with its own template of that name is refused, not overwritten', () => {
    const own = {
      ...builtinDefinition('Lag'),
      label: 'mine',
      body: builtinDefinition('Spring').body,
    };
    store().dispatchAtomic([
      node('tpl_own', 'TemplateDefinition', {
        definition: { ...own, output: builtinDefinition('Spring').output },
        keep: true,
      }),
    ]);
    const r = placeBuiltin(dag(), 'Lag', 'x', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('its own template.Lag');
  });
});
