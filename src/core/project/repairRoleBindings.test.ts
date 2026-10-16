// #608 — the LOAD boundary: a graph that arrives already assembled never passed
// through the connect gate, so the one-producer-per-role rule has to be re-asserted
// here or it is true only of graphs the editor builds and false of graphs it opens.
//
// Every fixture below is constructed LITERALLY rather than through ops, because
// that is the whole point: after the gate landed, `applyOp` refuses to build a
// two-depth-pass graph at all. Only a hand-assembled project can still carry one —
// which is exactly the population this pass exists for.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage/MemoryStorage';
import { loadProject, saveProject } from './io';
import { repairDuplicateRoleBindings } from './repairRoleBindings';
import { PROJECT_FORMAT_VERSION, type Project } from './schema';

function node(id: string, type: string, inputs: Record<string, unknown> = {}) {
  return { id, type, version: 1, params: {}, inputs } as never;
}

function projectWith(passBindings: Array<{ node: string; socket: string }>): Project {
  const nodes: Record<string, unknown> = {
    job: node('job', 'RenderJob', { 'pass-input': passBindings }),
  };
  for (const b of passBindings) {
    // Type is derived from the id prefix so a fixture cannot silently disagree
    // with the role it means to bind.
    const type = b.node.startsWith('d')
      ? 'DepthPass'
      : b.node.startsWith('b')
        ? 'BeautyPass'
        : 'MediaClip';
    nodes[b.node] = node(b.node, type);
  }
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: 'p',
    name: 'fixture',
    createdAt: 1,
    updatedAt: 1,
    nodeVersions: { RenderJob: 1, DepthPass: 1, BeautyPass: 1, MediaClip: 1 },
    state: { nodes, outputs: {} },
  } as unknown as Project;
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#608 — duplicate roles are repaired when a project is loaded', () => {
  it('drops the LATER duplicate and keeps the first, so reads answer as they did before', () => {
    const { project, repairs } = repairDuplicateRoleBindings(
      projectWith([
        { node: 'd1', socket: 'out' },
        { node: 'd2', socket: 'out' },
      ]),
    );
    expect(project.state.nodes.job.inputs['pass-input']).toEqual([{ node: 'd1', socket: 'out' }]);
    expect(repairs).toEqual([
      { node: 'job', socket: 'pass-input', role: 'depth', kept: 'd1', dropped: 'd2' },
    ]);
  });

  it('leaves a well-formed project ALONE — and returns the same object, not a copy', () => {
    const input = projectWith([
      { node: 'b1', socket: 'out' },
      { node: 'd1', socket: 'out' },
    ]);
    const { project, repairs } = repairDuplicateRoleBindings(input);
    expect(repairs).toEqual([]);
    expect(project).toBe(input);
  });

  it('does not touch role-LESS duplicates — an ordered image list is not a role map', () => {
    const input = projectWith([
      { node: 'clipA', socket: 'out' },
      { node: 'clipB', socket: 'out' },
    ]);
    const { project, repairs } = repairDuplicateRoleBindings(input);
    expect(repairs).toEqual([]);
    expect((project.state.nodes.job.inputs['pass-input'] as unknown[]).length).toBe(2);
  });

  it('THE BOUNDARY: a saved project carrying two depth passes loads repaired, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = new MemoryStorage();
    // saveProject validates against the schema — a duplicate-role graph is
    // schema-VALID, which is precisely why a shape check cannot catch it.
    await saveProject(
      storage,
      projectWith([
        { node: 'd1', socket: 'out' },
        { node: 'd2', socket: 'out' },
      ]),
    );

    const loaded = await loadProject(storage, 'p');
    expect(loaded.state.nodes.job.inputs['pass-input']).toEqual([{ node: 'd1', socket: 'out' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept "d1", dropped "d2"'));
    warn.mockRestore();
  });
});
