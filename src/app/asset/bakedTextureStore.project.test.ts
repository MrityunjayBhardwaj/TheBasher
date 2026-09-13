// #1050 — a texture ref that says it belongs to the project loads from the open project's image
// folder, and nowhere else.

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../../core/storage';
import { buildDefaultProject } from '../../core/project/default';
import { useProjectStore } from '../../core/project/store';
import { projectImagePath, writeProjectImage } from '../../core/project/projectImages';
import type { BakedTextureRef } from '../../nodes/types';
import { loadBakedTexture } from './bakedTextureStore';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});
afterEach(() => useProjectStore.getState().setCurrent(null));

function refFor(key: string): BakedTextureRef {
  return {
    hash: key,
    colorSpace: 'srgb',
    flipY: false,
    wrapS: 10497,
    wrapT: 10497,
    store: 'project',
  };
}

describe('#1050 — loading a project image', () => {
  it('reads the open project’s file and restores the captured state', async () => {
    const storage = new MemoryStorage();
    const key = await writeProjectImage(storage, 'open', PNG, 'image/png');
    useProjectStore.getState().setCurrent({ ...buildDefaultProject(), id: 'open' });

    const decoded: string[] = [];
    const texture = await loadBakedTexture(storage, refFor(key), {
      decode: async (url) => {
        decoded.push(url);
        return new THREE.Texture();
      },
    });
    expect(decoded).toHaveLength(1);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(texture.flipY).toBe(false);
  });

  it('applies the captured filters, and leaves three’s defaults when none were captured', async () => {
    const storage = new MemoryStorage();
    const key = await writeProjectImage(storage, 'open', PNG, 'image/png');
    useProjectStore.getState().setCurrent({ ...buildDefaultProject(), id: 'open' });
    const decode = async () => new THREE.Texture();

    const sharp = await loadBakedTexture(
      storage,
      { ...refFor(key), magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter },
      { decode },
    );
    expect(sharp.magFilter).toBe(THREE.NearestFilter);
    expect(sharp.minFilter).toBe(THREE.NearestFilter);

    const plain = await loadBakedTexture(storage, refFor(key), { decode });
    expect(plain.magFilter).toBe(THREE.LinearFilter);
    expect(plain.minFilter).toBe(THREE.LinearMipmapLinearFilter);
  });

  it('does not find another project’s image', async () => {
    const storage = new MemoryStorage();
    const key = await writeProjectImage(storage, 'other', PNG, 'image/png');
    useProjectStore.getState().setCurrent({ ...buildDefaultProject(), id: 'open' });
    expect(await storage.exists(projectImagePath('other', key))).toBe(true);

    await expect(
      loadBakedTexture(storage, refFor(key), { decode: async () => new THREE.Texture() }),
    ).rejects.toThrow();
  });

  it('with no open project, says which image could not load', async () => {
    const key = `${'cd'.repeat(32)}.png`;
    await expect(
      loadBakedTexture(new MemoryStorage(), refFor(key), {
        decode: async () => new THREE.Texture(),
      }),
    ).rejects.toThrow(new RegExp(`${key}.*no open project`));
  });
});
