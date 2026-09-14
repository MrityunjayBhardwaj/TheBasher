// #1050 — a project owns its images: written once by content, carried by duplicate, gone with
// delete, and never addressable outside the project's own folder.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage';
import { buildDefaultProject } from './default';
import { deleteProject, duplicateProject, projectPath, saveProject } from './io';
import {
  isProjectImageKey,
  listProjectImages,
  projectImagePath,
  writeProjectImage,
} from './projectImages';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#1050 — project images', () => {
  it('stores the encoded bytes under their SHA-256, once', async () => {
    const storage = new MemoryStorage();
    const key = await writeProjectImage(storage, 'p1', PNG, 'image/png');
    expect(key).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(await writeProjectImage(storage, 'p1', PNG, 'image/png')).toBe(key);
    expect(await listProjectImages(storage, 'p1')).toEqual([key]);
    expect(Array.from(await storage.read(projectImagePath('p1', key)))).toEqual(Array.from(PNG));

    const jpeg = await writeProjectImage(storage, 'p1', JPEG, 'image/jpeg');
    expect(jpeg).toMatch(/\.jpg$/);
    expect((await listProjectImages(storage, 'p1')).sort()).toEqual([key, jpeg].sort());
  });

  it('refuses an image type a project does not store', async () => {
    const storage = new MemoryStorage();
    await expect(writeProjectImage(storage, 'p1', PNG, 'image/webp')).rejects.toThrow(
      /image\/webp/,
    );
    expect(await listProjectImages(storage, 'p1')).toEqual([]);
  });

  it('a key cannot name a path outside the folder', () => {
    expect(isProjectImageKey('../project.json')).toBe(false);
    expect(isProjectImageKey(`${'a'.repeat(64)}.png/../../x`)).toBe(false);
    expect(() => projectImagePath('p1', '../../baked-texture/x.png')).toThrow(/not an image key/);
  });

  it('a project that never stored an image lists none', async () => {
    expect(await listProjectImages(new MemoryStorage(), 'nobody')).toEqual([]);
  });

  it('duplicating a project carries its images; deleting it removes them', async () => {
    const storage = new MemoryStorage();
    const source = { ...buildDefaultProject(), id: 'src' };
    await saveProject(storage, source);
    const key = await writeProjectImage(storage, 'src', PNG, 'image/png');

    await duplicateProject(storage, 'src', 'dup');
    expect(await listProjectImages(storage, 'dup')).toEqual([key]);
    expect(Array.from(await storage.read(projectImagePath('dup', key)))).toEqual(Array.from(PNG));

    await deleteProject(storage, 'src');
    expect(await listProjectImages(storage, 'src')).toEqual([]);
    expect(await storage.exists(projectPath('src'))).toBe(false);
    // The copy owns its own bytes, so deleting the source took nothing from it.
    expect(await listProjectImages(storage, 'dup')).toEqual([key]);
  });
});
