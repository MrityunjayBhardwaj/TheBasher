// UX #9 slice 2 — env-HDRI OPFS store: content-hash path, dedupe, ext guard,
// and load → EquirectangularReflectionMapping (the mapping three needs to use
// the texture as `scene.environment`). Mirrors bakedTextureStore.test.ts.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import {
  ENV_HDRI_ROOT,
  envExtOf,
  envHdriPath,
  isSupportedEnvExt,
  loadEnvHdri,
  persistEnvHdri,
} from './envHdriStore';

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

describe('envExtOf / isSupportedEnvExt', () => {
  it('extracts the lowercase extension', () => {
    expect(envExtOf('env-hdri/abc.HDR')).toBe('hdr');
    expect(envExtOf('foo/bar/studio.exr')).toBe('exr');
    expect(envExtOf('noext')).toBe('');
  });
  it('accepts .hdr / .exr only', () => {
    expect(isSupportedEnvExt('a.hdr')).toBe(true);
    expect(isSupportedEnvExt('a.exr')).toBe(true);
    expect(isSupportedEnvExt('a.png')).toBe(false);
    expect(isSupportedEnvExt('a.jpg')).toBe(false);
  });
});

describe('persistEnvHdri', () => {
  it('writes under env-hdri/<hash>.<ext> and returns the assetRef', async () => {
    const storage = new MemoryStorage();
    const ref = await persistEnvHdri(storage, BYTES, 'studio.hdr');
    expect(ref.startsWith(`${ENV_HDRI_ROOT}/`)).toBe(true);
    expect(ref.endsWith('.hdr')).toBe(true);
    expect(await storage.exists(ref)).toBe(true);
    expect(await storage.read(ref)).toEqual(BYTES);
  });

  it('is content-addressed + write-if-absent (re-import dedupes to one blob)', async () => {
    const storage = new MemoryStorage();
    const a = await persistEnvHdri(storage, BYTES, 'one.hdr');
    const b = await persistEnvHdri(storage, BYTES, 'two.hdr'); // same bytes, diff name
    expect(a).toBe(b); // hash-keyed → identical path
    expect((await storage.list(ENV_HDRI_ROOT)).length).toBe(1);
  });

  it('matches envHdriPath for the same bytes/ext', async () => {
    const storage = new MemoryStorage();
    const ref = await persistEnvHdri(storage, BYTES, 'x.exr');
    expect(ref).toBe(envHdriPath(ref.slice(ENV_HDRI_ROOT.length + 1, ref.lastIndexOf('.')), 'exr'));
  });

  it('rejects an unsupported extension (V38 — surfaced, not silent)', async () => {
    const storage = new MemoryStorage();
    await expect(persistEnvHdri(storage, BYTES, 'photo.png')).rejects.toThrow(/\.png/);
  });
});

describe('loadEnvHdri', () => {
  it('reads the bytes and sets EquirectangularReflectionMapping', async () => {
    const storage = new MemoryStorage();
    const ref = await persistEnvHdri(storage, BYTES, 'studio.hdr');
    let decodedExt = '';
    const fake = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const tex = await loadEnvHdri(storage, ref, {
      decode: async (_url, ext) => {
        decodedExt = ext;
        return fake;
      },
    });
    expect(decodedExt).toBe('hdr');
    expect(tex).toBe(fake);
    expect(tex.mapping).toBe(THREE.EquirectangularReflectionMapping);
  });
});
