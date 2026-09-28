// #1302 — a project picker reads each project's small summary, not the project file.
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, emptyDagState, registerNodeType } from '../dag';
import { MemoryStorage } from '../storage';
import {
  composeProject,
  deleteProject,
  listProjectMetadata,
  listProjects,
  renameProject,
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

function project(id: string, name: string, updatedAt: number) {
  const state = applyOp(emptyDagState(), {
    type: 'addNode',
    nodeId: 'n1',
    nodeType: 'TN',
    params: { value: 1 },
  }).next;
  return composeProject({ id, name, state, createdAt: 1, updatedAt });
}

/** Records every path read, so a test can say which files a listing opened. */
class CountingStorage extends MemoryStorage {
  reads: string[] = [];
  override async read(path: string): Promise<Uint8Array> {
    this.reads.push(path);
    return super.read(path);
  }
}

describe('project listing reads summaries (#1302)', () => {
  beforeEach(seed);

  it('lists from meta.json without opening any project file', async () => {
    const storage = new CountingStorage();
    await saveProject(storage, project('a', 'Alpha', 10));
    await saveProject(storage, project('b', 'Beta', 20));
    storage.reads = [];
    const listed = await listProjectMetadata(storage);
    expect(listed.map((m) => [m.id, m.name, m.nodeCount])).toEqual([
      ['b', 'Beta', 1],
      ['a', 'Alpha', 1],
    ]);
    expect(storage.reads.sort()).toEqual(['projects/a/meta.json', 'projects/b/meta.json']);
  });

  it('a project saved before summaries existed is still listed, from its project file', async () => {
    const storage = new CountingStorage();
    await saveProject(storage, project('old', 'Old one', 5));
    await storage.delete('projects/old/meta.json');
    storage.reads = [];
    const listed = await listProjectMetadata(storage);
    expect(listed.map((m) => m.name)).toEqual(['Old one']);
    expect(storage.reads).toContain('projects/old/project.json');
    // Listing never writes: a summary appears on the next save, not behind a save's back.
    expect(await storage.exists('projects/old/meta.json')).toBe(false);
  });

  it('a summary naming another project is not trusted', async () => {
    const storage = new MemoryStorage();
    await saveProject(storage, project('real', 'Real', 5));
    await storage.write(
      'projects/real/meta.json',
      new TextEncoder().encode(
        JSON.stringify({
          id: 'other',
          name: 'Wrong',
          createdAt: 1,
          updatedAt: 1,
          formatVersion: 1,
          nodeCount: 0,
        }),
      ),
    );
    expect((await listProjectMetadata(storage)).map((m) => m.name)).toEqual(['Real']);
  });

  it('a rename shows in the list', async () => {
    const storage = new MemoryStorage();
    await saveProject(storage, project('p', 'Before', 5));
    await renameProject(storage, 'p', 'After');
    expect((await listProjectMetadata(storage)).map((m) => m.name)).toEqual(['After']);
  });

  it('a deleted project leaves no summary behind', async () => {
    const storage = new MemoryStorage();
    await saveProject(storage, project('gone', 'Gone', 5));
    await deleteProject(storage, 'gone');
    expect(await storage.exists('projects/gone/meta.json')).toBe(false);
    expect(await listProjectMetadata(storage)).toEqual([]);
  });
});

describe('listing never answers "could not look" with "none" (#1304)', () => {
  beforeEach(seed);

  it('a failing list is thrown, not turned into an empty list', async () => {
    const storage = new MemoryStorage();
    storage.list = async () => {
      throw new DOMException('locked', 'NoModificationAllowedError');
    };
    await expect(listProjects(storage)).rejects.toThrow('locked');
  });

  it('no projects directory yet lists as empty', async () => {
    expect(await listProjects(new MemoryStorage())).toEqual([]);
  });
});
