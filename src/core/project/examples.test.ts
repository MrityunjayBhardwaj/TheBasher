// v0.6 #4 W4 (D-W4-SEED) — examples are REAL Op-built DAGs, not static JSON
// fixtures. These assertions are the V34 substrate-purity proof: every example
// composes to a Project whose state.nodes are genuine DAG nodes (each with a
// type), wired to a Scene + RenderOutput exactly like default.ts — so an opened
// example is an ordinary, selectable, undoable project.

import { describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildAllExampleProjects, buildExampleProject, EXAMPLE_PROJECT_IDS } from './examples';

registerAllNodes();

describe('example projects (v0.6 #4 W4)', () => {
  it('exposes at least one curated example with a stable example_ id', () => {
    expect(EXAMPLE_PROJECT_IDS.length).toBeGreaterThanOrEqual(1);
    for (const id of EXAMPLE_PROJECT_IDS) {
      expect(id.startsWith('example_')).toBe(true);
    }
  });

  it('builds each example as a real Op-built DAG (nodes have types, no empty scene)', () => {
    for (const id of EXAMPLE_PROJECT_IDS) {
      const project = buildExampleProject(id);
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
      // At least one mesh child so the opened scene is non-empty + selectable. #365 Phase 5a
      // (Slice 1b): boxes are the split now — an Object (pose) over a BoxData (geometry).
      expect(nodes.some((n) => n.type === 'Object')).toBe(true);
      expect(nodes.some((n) => n.type === 'BoxData')).toBe(true);
    }
  });

  it('buildAllExampleProjects returns one project per id', () => {
    expect(
      buildAllExampleProjects()
        .map((p) => p.id)
        .sort(),
    ).toEqual([...EXAMPLE_PROJECT_IDS].sort());
  });

  it('throws on an unknown example id (no silent empty project)', () => {
    expect(() => buildExampleProject('example_does_not_exist')).toThrow();
  });
});
