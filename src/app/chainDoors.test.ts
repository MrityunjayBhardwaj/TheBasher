// The doors a constrained or hung object goes through, each with the plain case as its control:
// #1846 duplicate and the agent on a blended chain, #1847 a hung hierarchy into a template, #1848 a
// follower through a parent change. Everything goes through the store's commit step.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { evaluate, type DagState } from '../core/dag';
import { chainFollowUpOps, chainNodeIds, readChain, setInfluenceOps } from '../core/dag/chainEdit';
import { applyOps } from '../core/dag/ops';
import { buildDefaultDagState } from '../core/project/default';
import { deleteNodeMutator } from '../agent/mutators/builders/deleteNode';
import { duplicateMutator } from '../agent/mutators/builders/duplicate';
import { validatePlan } from '../agent/mutators/validate';
import { registerAllNodes } from '../nodes/registerAll';
import { withIds } from '../test-utils/curvePoints';
import { makeSplitCube } from '../test-utils/splitCube';
import { buildClearParentOps, buildParentToOps, type MoveResult } from './keepPlaceReparent';
import { buildDuplicateNodesOps, planDeleteNodes } from './sceneNodeActions';
import { planCollapseToTemplate, planTemplateInstance } from './templates';

beforeAll(() => registerAllNodes());
const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };

const commit = (s: DagState, ops: readonly unknown[]) => {
  const next = applyOps(s, ops as never).next;
  const more = chainFollowUpOps(s, next);
  return more.length ? applyOps(next, more).next : next;
};
const run = (s: DagState, ops: readonly unknown[]) => {
  for (const op of ops) s = commit(s, [op]);
  return s;
};
const wire = (from: string, socket: string, to: string, toSocket: string) => ({
  type: 'connect',
  from: { node: from, socket },
  to: { node: to, socket: toSocket },
});
const set = (nodeId: string, paramPath: string, value: unknown) => ({
  type: 'setParam',
  nodeId,
  paramPath,
  value,
});
const at = (s: DagState, id: string) => {
  const m = evaluate(s, id, { ctx: CTX, socket: 'world' }).value as number[];
  return new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(m)).toArray();
};
const close = (got: readonly number[], want: readonly number[]) =>
  got.forEach((x, i) => expect(x, `axis ${i} of [${got}]`).toBeCloseTo(want[i], 6));
const ok = (r: MoveResult) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};

/** n_box on a line to (10, 0, 0) at 0.5, aimed; the aim blended at 0.5 when asked. */
function follower(blend: boolean) {
  let s = run(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'cd',
      nodeType: 'CurveData',
      params: {
        points: withIds([
          [0, 0, 0],
          [10, 0, 0],
        ]),
        closed: false,
        resolution: 32,
      },
    },
    { type: 'addNode', nodeId: 'c', nodeType: 'Object', params: {} },
    wire('cd', 'out', 'c', 'data'),
    wire('c', 'out', 'n_scene', 'children'),
    {
      type: 'addNode',
      nodeId: 'fp',
      nodeType: 'FollowPath',
      params: { target: 'n_box', curve: 'c', evalTime: 0.5 },
    },
    {
      type: 'addNode',
      nodeId: 'tt',
      nodeType: 'TrackTo',
      params: { target: 'n_box', aimNode: '', aimPoint: [5, 9, 5], up: [0, 0, 1] },
    },
  ]);
  if (blend) s = commit(s, setInfluenceOps(s, 'n_box', 'tt', 0.5, true) ?? []);
  return s;
}

describe('#1846 — a blended chain belongs to its object', () => {
  for (const blend of [false, true]) {
    const name = blend ? 'blended' : 'not blended (control)';
    const duplicated = () => {
      const s0 = follower(blend);
      const r = buildDuplicateNodesOps(s0, ['n_box'], {})!;
      return { s: commit(s0, r.ops), copy: r.newRootIds[0], before: s0 };
    };

    it(`${name}: the copy has its own whole chain, none of it shared`, () => {
      const { s, copy, before } = duplicated();
      const chain = readChain(s, copy)!;
      expect(chain.steps).toHaveLength(2);
      expect(chain.own).not.toBeNull();
      expect((s.nodes[chain.own!].params as { object: string }).object).toBe(copy);
      const ids = chainNodeIds(s, copy);
      expect(ids.length).toBe(chainNodeIds(before, 'n_box').length);
      expect(ids.filter((id) => before.nodes[id])).toEqual([]);
      for (const step of chain.steps)
        expect((s.nodes[step.id].params as { target: string }).target).toBe(copy);
    });

    it(`${name}: the copy and the original no longer move each other`, () => {
      const { s, copy } = duplicated();
      close(at(s, copy), [5, 0, 0]);
      const movedCopy = commit(s, [set(copy, 'position', [0, 7, 0])]);
      close(at(movedCopy, copy), [5, 7, 0]);
      close(at(movedCopy, 'n_box'), [5, 0, 0]);
      const movedOriginal = commit(s, [set('n_box', 'position', [0, 3, 0])]);
      close(at(movedOriginal, 'n_box'), [5, 3, 0]);
      close(at(movedOriginal, copy), [5, 0, 0]);
      const alongPath = commit(s, [set('fp', 'evalTime', 1)]);
      close(at(alongPath, 'n_box'), [10, 0, 0]);
      close(at(alongPath, copy), [5, 0, 0]);
    });

    for (const [label, mutator, spec] of [
      ['delete', deleteNodeMutator, { targetSelectors: ['n_box'] }],
      ['duplicate', duplicateMutator, { targetSelectors: ['n_box'], offset: [1, 0, 0] }],
    ] as const) {
      it(`${name}: the agent's ${label} passes the gate and does the job`, () => {
        const s = follower(blend);
        const r = validatePlan(mutator as never, spec as never, s, 'p') as {
          ok: boolean;
          ops?: unknown[];
        };
        expect(r, JSON.stringify(r).slice(0, 300)).toMatchObject({ ok: true });
        const after = commit(s, r.ops!);
        if (label === 'delete')
          for (const id of chainNodeIds(s, 'n_box')) expect(after.nodes[id]).toBeUndefined();
        else expect(chainNodeIds(after, 'n_box_copy').length).toBe(chainNodeIds(s, 'n_box').length);
      });
    }
  }

  it('the outliner delete still takes the whole chain (control)', () => {
    const s = follower(true);
    const r = ok(planDeleteNodes(s, ['n_box'], { ctx: CTX }));
    const after = commit(s, r.ops);
    for (const id of chainNodeIds(s, 'n_box')) expect(after.nodes[id]).toBeUndefined();
  });
});

describe('#1847 — a hung hierarchy into a template', () => {
  const hierarchy = () => {
    const s = makeSplitCube(buildDefaultDagState(), {
      objectId: 'kid',
      position: [0, 2, 0],
    }).state;
    return run(s, [
      set('n_box', 'position', [3, 0, 0]),
      wire('n_box', 'world', 'kid', 'parent'),
      wire('kid', 'out', 'n_scene', 'children'),
    ]);
  };
  const SEL = ['n_box', 'n_box_data', 'kid', 'kid_data'];
  const collapse = () => {
    const s = hierarchy();
    const plan = planCollapseToTemplate(s, SEL, 'Probe', 'inst');
    if (!plan.ok) throw new Error(plan.reason);
    return { before: s, plan, after: commit(s, plan.ops) };
  };

  it('the parent, its child and their data collapse, as on main', () => {
    const { after } = collapse();
    const list = (after.nodes.n_scene.inputs.children as { node: string }[]).map((r) => r.node);
    expect(list).toContain('inst');
    expect(list).not.toContain('n_box');
    expect(list).not.toContain('kid');
  });

  it('both stand where they stood', () => {
    const { after } = collapse();
    close(at(after, 'n_box'), [3, 0, 0]);
    close(at(after, 'kid'), [3, 2, 0]);
  });

  it('the instance carries the child: its value holds it', () => {
    const { after } = collapse();
    const v = evaluate(after, 'inst', { ctx: CTX }).value as { children?: unknown[] };
    expect(v.children).toHaveLength(1);
  });

  it('a second instance carries its own copy of the child', () => {
    const { after, plan } = collapse();
    const s = commit(after, planTemplateInstance(after, plan.definition, 'inst2'));
    const v = evaluate(s, 'inst2', { ctx: CTX }).value as { children?: unknown[] };
    expect(v.children).toHaveLength(1);
  });

  it('deleting the instance takes the child with it', () => {
    const { after } = collapse();
    const r = ok(planDeleteNodes(after, ['inst'], { ctx: CTX }));
    const gone = commit(after, r.ops);
    for (const id of SEL) expect(gone.nodes[id], id).toBeUndefined();
  });

  it('duplicating the instance gives it its own child', () => {
    const { after } = collapse();
    const r = buildDuplicateNodesOps(after, ['inst'], {})!;
    const s = commit(after, r.ops);
    const copy = r.newRootIds[0];
    const v = evaluate(s, copy, { ctx: CTX }).value as { children?: unknown[] };
    expect(v.children).toHaveLength(1);
    const kids = Object.values(s.nodes).filter(
      (n) => n.id !== 'kid' && n.id.includes('kid') && n.type === 'Object',
    );
    expect(kids).toHaveLength(1);
    expect(kids[0].inputs.parent).not.toEqual({ node: 'n_box', socket: 'world' });
  });

  it('a child left out, reading the parent from outside, is still a second output', () => {
    const s = hierarchy();
    const plan = planCollapseToTemplate(s, ['n_box', 'n_box_data'], 'Probe', 'inst');
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/outputs of the selection/);
  });

  it('a child taken without its parent is one output, as ever (control)', () => {
    const plan = planCollapseToTemplate(hierarchy(), ['kid', 'kid_data'], 'Probe', 'inst');
    expect(plan.ok).toBe(true);
  });

  it('two unrelated objects are still two outputs (control)', () => {
    const s = run(
      makeSplitCube(buildDefaultDagState(), { objectId: 'b', position: [1, 0, 0] }).state,
      [wire('b', 'out', 'n_scene', 'children')],
    );
    const plan = planCollapseToTemplate(s, ['n_box', 'n_box_data', 'b', 'b_data'], 'Probe', 'inst');
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/outputs of the selection/);
  });
});

describe('#1848 — a follower through a parent change', () => {
  const withGroup = (params: object = { position: [0, 0, 5] }) =>
    run(follower(false), [
      { type: 'addNode', nodeId: 'G', nodeType: 'Object', params },
      wire('G', 'out', 'n_scene', 'children'),
    ]);

  it("Ctrl+P keeps it where it's drawn, and the parent then carries it, as Blender's default does", () => {
    const s = withGroup();
    const after = commit(s, ok(buildParentToOps(s, ['n_box'], 'G', { ctx: CTX })).ops);
    close(at(after, 'n_box'), [5, 0, 0]);
    const moved = commit(after, [set('G', 'position', [0, 3, 5])]);
    close(at(moved, 'n_box'), [5, 3, 0]);
  });

  it('under a turned, scaled parent it still keeps its place', () => {
    const s = withGroup({ position: [1, 2, 3], rotation: [0, 0, 90], scale: [2, 2, 2] });
    const after = commit(s, ok(buildParentToOps(s, ['n_box'], 'G', { ctx: CTX })).ops);
    close(at(after, 'n_box'), [5, 0, 0]);
  });

  it('Alt+P keeps it too', () => {
    const s = withGroup();
    const hung = commit(s, ok(buildParentToOps(s, ['n_box'], 'G', { ctx: CTX })).ops);
    const cleared = commit(hung, ok(buildClearParentOps(hung, ['n_box'], { ctx: CTX })).ops);
    close(at(cleared, 'n_box'), [5, 0, 0]);
    expect(cleared.nodes.n_box.inputs.parent).toBeUndefined();
  });

  it('deleting its parent keeps it', () => {
    const s = run(withGroup(), [wire('G', 'world', 'n_box', 'parent')]);
    close(at(s, 'n_box'), [5, 0, 5]);
    const after = commit(s, ok(planDeleteNodes(s, ['G'], { ctx: CTX })).ops);
    close(at(after, 'n_box'), [5, 0, 5]);
  });

  it('a position that really is keyed is still refused', () => {
    const s = run(withGroup(), [
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          target: 'n_box',
          paramPath: 'position',
          keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
        },
      },
    ]);
    const r = buildParentToOps(s, ['n_box'], 'G', { ctx: CTX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/animated/);
  });
});
