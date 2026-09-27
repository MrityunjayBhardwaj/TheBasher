// v0.6 #4 W4 (D-W4-SEED) — examples are REAL DAGs. These assertions are the V34
// substrate-purity proof: every example composes to a Project whose state.nodes are
// genuine DAG nodes (each with a type), wired to a Scene + RenderOutput exactly like
// default.ts — so an opened example is an ordinary, selectable, undoable project.
// #1282 — one example is a scene the app saved rather than one built from ops here, so it
// never passed applyOp in this repo; its row below checks what applyOp would have: every
// node's params parse under its type's schema and every edge reaches a node that exists.

import { describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { getNodeType } from '../dag/registry';
import { buildAllExampleProjects, buildExampleProject, EXAMPLE_PROJECT_IDS } from './examples';

registerAllNodes();

describe('example projects (v0.6 #4 W4)', () => {
  it('exposes at least one curated example with a stable example_ id', () => {
    expect(EXAMPLE_PROJECT_IDS.length).toBeGreaterThanOrEqual(1);
    for (const id of EXAMPLE_PROJECT_IDS) {
      expect(id.startsWith('example_')).toBe(true);
    }
  });

  it('builds each example as a real DAG (nodes have types, no empty scene)', async () => {
    for (const id of EXAMPLE_PROJECT_IDS) {
      const project = await buildExampleProject(id);
      expect(project.id).toBe(id);
      expect(project.name.length).toBeGreaterThan(0);
      const nodes = Object.values(project.state.nodes);
      // Real DAG: multiple authored nodes, each with a node type (a static JSON
      // blob masquerading as a project would not survive applyOp validation).
      expect(nodes.length).toBeGreaterThanOrEqual(5);
      for (const n of nodes) {
        expect(typeof n.type).toBe('string');
        expect((n.type as string).length).toBeGreaterThan(0);
      }
      // Wired through to a render sink like default.ts.
      expect(project.state.outputs.render).toBeTruthy();
      expect(project.state.outputs.scene).toBeTruthy();
      // Something drawn, so the opened scene is non-empty + selectable: an Object (pose) over
      // a data node that exists (#365 Phase 5a split; a box, a character's mesh, a curve).
      expect(
        nodes.some((n) => {
          const data = (n.inputs as { data?: { node?: string } } | undefined)?.data?.node;
          return n.type === 'Object' && data !== undefined && data in project.state.nodes;
        }),
      ).toBe(true);
    }
  });

  it('a captured example is what applyOp would have accepted (#1282)', async () => {
    const project = await buildExampleProject('example_camera_path_ai_walk');
    const nodes = project.state.nodes;
    const bad: string[] = [];
    for (const [id, n] of Object.entries(nodes)) {
      const def = getNodeType(n.type);
      if (!def) {
        bad.push(`${id}: no node type ${n.type}`);
        continue;
      }
      const parsed = def.paramSchema.safeParse(n.params);
      if (!parsed.success) bad.push(`${id} ${n.type}: ${parsed.error.issues[0]?.message}`);
      for (const [socket, ref] of Object.entries(n.inputs ?? {}))
        for (const r of Array.isArray(ref) ? ref : [ref])
          if (r && !((r as { node: string }).node in nodes))
            bad.push(`${id}.${socket} -> missing ${(r as { node: string }).node}`);
    }
    // The denominator rides with the verdict: an empty list from a loop over nothing is not a pass.
    expect(Object.keys(nodes).length).toBeGreaterThan(50);
    expect(bad).toEqual([]);
    // What makes it this example: the generated walk, its path, and the camera's constraints.
    const types = Object.values(nodes).map((n) => n.type);
    for (const t of ['MotionGenerate', 'AnimationClip', 'CurveData', 'FollowPath', 'TrackTo'])
      expect(types, t).toContain(t);
  });

  it('buildAllExampleProjects returns one project per id', async () => {
    expect((await buildAllExampleProjects()).map((p) => p.id).sort()).toEqual(
      [...EXAMPLE_PROJECT_IDS].sort(),
    );
  });

  it('rejects an unknown example id (no silent empty project)', async () => {
    await expect(buildExampleProject('example_does_not_exist')).rejects.toThrow();
  });
});
