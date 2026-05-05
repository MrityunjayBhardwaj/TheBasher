import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, emptyDagState, registerNodeType } from '../dag';
import type { Op } from '../dag/types';
import { MemoryStorage } from '../storage';
import {
  composeProject,
  loadProject,
  PROJECT_FORMAT_VERSION,
  ProjectSchema,
  registerFormatMigration,
  saveProject,
} from './index';

function seed() {
  __resetRegistryForTests();
  registerNodeType<{ value: number }, number>({
    type: 'TN',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({ value: z.number() }),
    inputs: {},
    outputs: { out: { type: 'Number', cardinality: 'single' } },
    evaluate: (p) => p.value,
  });
}

describe('Project save/load round-trip', () => {
  beforeEach(seed);

  it('saves and loads identical state', async () => {
    let state = emptyDagState();
    const op: Op = {
      type: 'addNode',
      nodeId: 'n1',
      nodeType: 'TN',
      params: { value: 42 },
    };
    state = applyOp(state, op).next;
    state = { ...state, outputs: { scene: { node: 'n1', socket: 'out' } } };

    const project = composeProject({ id: 'p1', name: 'demo', state });
    const validated = ProjectSchema.parse(project);
    expect(validated.formatVersion).toBe(PROJECT_FORMAT_VERSION);

    const storage = new MemoryStorage();
    await saveProject(storage, project);
    const loaded = await loadProject(storage, 'p1');
    expect(loaded.id).toBe(project.id);
    expect(loaded.state.nodes.n1.params).toEqual({ value: 42 });
    expect(loaded.state.outputs.scene).toEqual({ node: 'n1', socket: 'out' });
  });

  it('migration runner: per-node version step-up', async () => {
    __resetRegistryForTests();
    registerNodeType<{ v: number }, number>({
      type: 'TN',
      version: 3,
      pure: true,
      cost: 'cheap',
      paramSchema: z.object({ v: z.number() }),
      inputs: {},
      outputs: { out: { type: 'Number', cardinality: 'single' } },
      evaluate: (p) => p.v,
      migrations: {
        1: (raw) => ({ v: (raw as { value: number }).value }),
        2: (raw) => ({ v: (raw as { v: number }).v + 100 }),
      },
    });

    // Write a project with a v1-shaped node manually.
    const oldProject = {
      formatVersion: 1,
      id: 'p',
      name: 'old',
      createdAt: 1,
      updatedAt: 2,
      nodeVersions: { TN: 1 },
      state: {
        nodes: {
          x: { id: 'x', type: 'TN', version: 1, params: { value: 7 }, inputs: {} },
        },
        outputs: {},
      },
    };

    const storage = new MemoryStorage();
    await storage.write(
      'projects/p/project.json',
      new TextEncoder().encode(JSON.stringify(oldProject)),
    );
    const loaded = await loadProject(storage, 'p');
    expect(loaded.state.nodes.x.version).toBe(3);
    // 1→2 unwrapped { value:7 } → { v:7 }; 2→3 added 100 → { v:107 }.
    expect(loaded.state.nodes.x.params).toEqual({ v: 107 });
  });

  it('format migration ladder: v0 raw → v1 current', async () => {
    seed();
    // Hypothetical earlier shape: legacy `nodes` field outside `state`. The
    // registered migration lifts it to the v1 layout so ProjectSchema accepts
    // it. (Self-uninstalls after the test by calling __resetRegistryForTests
    // in beforeEach for the next test; format migrations live module-level so
    // we register a no-op-and-unregister pattern locally.)
    type V0 = {
      formatVersion: 0;
      id: string;
      name: string;
      createdAt: number;
      nodes: Record<string, unknown>;
      outputs: Record<string, unknown>;
    };
    registerFormatMigration(0, (raw) => {
      const r = raw as V0;
      return {
        formatVersion: 1,
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        updatedAt: r.createdAt,
        nodeVersions: { TN: 1 },
        state: { nodes: r.nodes, outputs: r.outputs },
      };
    });

    const storage = new MemoryStorage();
    const v0 = {
      formatVersion: 0,
      id: 'old',
      name: 'old',
      createdAt: 0,
      nodes: {
        n: { id: 'n', type: 'TN', version: 1, params: { value: 5 }, inputs: {} },
      },
      outputs: { scene: { node: 'n', socket: 'out' } },
    };
    await storage.write('projects/old/project.json', new TextEncoder().encode(JSON.stringify(v0)));
    const loaded = await loadProject(storage, 'old');
    expect(loaded.formatVersion).toBe(1);
    expect(loaded.state.nodes.n.params).toEqual({ value: 5 });
  });

  it('rejects malformed JSON with a clear error', async () => {
    const storage = new MemoryStorage();
    await storage.write('projects/broken/project.json', new TextEncoder().encode('{ not json'));
    await expect(loadProject(storage, 'broken')).rejects.toThrow(/corrupt JSON/);
  });
});
