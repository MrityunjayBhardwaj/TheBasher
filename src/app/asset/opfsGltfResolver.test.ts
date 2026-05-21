// Coverage for the multi-file `.gltf` sentinel-URL resolver (#82).
//
// Synthesises a minimal multi-file `.gltf` in `MemoryStorage` (a `.bin`
// buffer + a `.png` texture as siblings of the JSON) and asserts:
//   1. `gltfReferencesExternalSiblings` discriminates self-contained
//      (data-URI buffer, no images) from multi-file (relative URI).
//   2. `loadMultiFileGltf` pre-resolves every sibling into the
//      sentinel-URL cache, AND the main JSON itself.
//   3. The cache lookup three.js would do (via `resolveBasherOpfsUrl`
//      from a URL three.js would construct by `path + uri` resolution)
//      hits the right blob URL for each sibling.
//   4. A missing sibling surfaces loudly (the storage `read` throws),
//      not silently — converts a silent partial-load into a loud
//      import-time failure, which is the point of the fix.

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import {
  BASHER_OPFS_SCHEME,
  __resetOpfsGltfResolverCacheForTests,
  gltfReferencesExternalSiblings,
  isBasherOpfsUrl,
  loadMultiFileGltf,
  opfsUrlFor,
  resolveBasherOpfsUrl,
} from './opfsGltfResolver';

const SELF_CONTAINED_GLTF = {
  asset: { version: '2.0' },
  scenes: [{ nodes: [0] }],
  scene: 0,
  nodes: [{ mesh: 0 }],
  buffers: [{ byteLength: 12, uri: 'data:application/octet-stream;base64,AAAAAAAA' }],
};

const MULTI_FILE_GLTF = {
  asset: { version: '2.0' },
  scenes: [{ nodes: [0] }],
  scene: 0,
  nodes: [{ mesh: 0 }],
  buffers: [{ byteLength: 12, uri: 'rig.bin' }],
  images: [{ uri: 'tex.png' }],
};

const enc = new TextEncoder();
const bytesOf = (obj: unknown): Uint8Array => enc.encode(JSON.stringify(obj));

beforeEach(() => {
  __resetOpfsGltfResolverCacheForTests();
});

describe('opfsUrlFor / isBasherOpfsUrl', () => {
  it('builds + recognises sentinel URLs', () => {
    const u = opfsUrlFor('assets/rig/character.gltf');
    expect(u).toBe(`${BASHER_OPFS_SCHEME}assets/rig/character.gltf`);
    expect(isBasherOpfsUrl(u)).toBe(true);
    expect(isBasherOpfsUrl('blob:http://x/abc')).toBe(false);
    expect(isBasherOpfsUrl('data:image/png;base64,xxx')).toBe(false);
    expect(isBasherOpfsUrl('/draco/draco_decoder.wasm')).toBe(false);
  });
});

describe('gltfReferencesExternalSiblings', () => {
  it('returns false for self-contained data-URI buffers (the bundled assets)', () => {
    expect(gltfReferencesExternalSiblings(SELF_CONTAINED_GLTF)).toBe(false);
  });

  it('returns true when ANY buffer is a relative URI', () => {
    expect(gltfReferencesExternalSiblings(MULTI_FILE_GLTF)).toBe(true);
  });

  it('returns true when only an image is external', () => {
    const json = {
      ...SELF_CONTAINED_GLTF,
      images: [{ uri: 'tex.png' }],
    };
    expect(gltfReferencesExternalSiblings(json)).toBe(true);
  });

  it('returns false for an absolute http URL (treated as passthrough — not a sibling)', () => {
    const json = {
      ...SELF_CONTAINED_GLTF,
      buffers: [{ byteLength: 12, uri: 'https://example.com/rig.bin' }],
    };
    expect(gltfReferencesExternalSiblings(json)).toBe(false);
  });

  it('returns false for non-object input (defensive — wraps the JSON.parse contract)', () => {
    expect(gltfReferencesExternalSiblings(null)).toBe(false);
    expect(gltfReferencesExternalSiblings(undefined)).toBe(false);
    expect(gltfReferencesExternalSiblings(42)).toBe(false);
  });
});

describe('loadMultiFileGltf — sentinel URL pre-resolution', () => {
  it('pre-resolves siblings AND the main JSON into the sentinel cache', async () => {
    const storage = new MemoryStorage();
    const mainPath = 'assets/rig/character.gltf';
    const mainBytes = bytesOf(MULTI_FILE_GLTF);
    await storage.write(mainPath, mainBytes);
    await storage.write('assets/rig/rig.bin', new Uint8Array([1, 2, 3, 4]));
    await storage.write('assets/rig/tex.png', new Uint8Array([5, 6, 7, 8]));

    const mainUrl = await loadMultiFileGltf(storage, mainPath, mainBytes);

    expect(mainUrl).toBe(opfsUrlFor(mainPath));

    // Main is cached so the GLTFLoader's first fetch (mainUrl → blob URL)
    // succeeds via the URL modifier.
    const mainResolved = resolveBasherOpfsUrl(mainUrl);
    expect(mainResolved).toMatch(/^blob:/);

    // Both siblings cached at the URL three.js would compute by
    // concatenating the JSON's relative URI onto the main URL's base:
    //   base = `${BASHER_OPFS_SCHEME}assets/rig/`
    //   buffer URI 'rig.bin' → `${base}rig.bin`
    //   image URI  'tex.png' → `${base}tex.png`
    const bufferUrl = `${BASHER_OPFS_SCHEME}assets/rig/rig.bin`;
    const textureUrl = `${BASHER_OPFS_SCHEME}assets/rig/tex.png`;
    expect(resolveBasherOpfsUrl(bufferUrl)).toMatch(/^blob:/);
    expect(resolveBasherOpfsUrl(textureUrl)).toMatch(/^blob:/);
  });

  it('non-sentinel URLs pass through (URL modifier semantics)', async () => {
    const storage = new MemoryStorage();
    const mainPath = 'assets/rig/character.gltf';
    const mainBytes = bytesOf(MULTI_FILE_GLTF);
    await storage.write(mainPath, mainBytes);
    await storage.write('assets/rig/rig.bin', new Uint8Array([1, 2, 3]));
    await storage.write('assets/rig/tex.png', new Uint8Array([4, 5, 6]));
    await loadMultiFileGltf(storage, mainPath, mainBytes);

    // The Draco decoder + KTX2 transcoder + ordinary blob URLs must NOT
    // be sentinel-rewritten — the URL modifier returns null and the
    // caller passes the URL through unchanged.
    expect(resolveBasherOpfsUrl('/draco/draco_decoder.wasm')).toBeNull();
    expect(resolveBasherOpfsUrl('/basis/basis_transcoder.wasm')).toBeNull();
    expect(resolveBasherOpfsUrl('blob:http://localhost:5180/abc')).toBeNull();
    expect(resolveBasherOpfsUrl('data:image/png;base64,xxx')).toBeNull();
  });

  it('a missing sibling throws (loud failure, not silent partial load)', async () => {
    const storage = new MemoryStorage();
    const mainPath = 'assets/rig/character.gltf';
    const mainBytes = bytesOf(MULTI_FILE_GLTF);
    await storage.write(mainPath, mainBytes);
    // Deliberately omit `rig.bin` and `tex.png` — MemoryStorage.read
    // throws "not found" which propagates up the resolver call.
    await expect(loadMultiFileGltf(storage, mainPath, mainBytes)).rejects.toThrow(/not found/);
  });

  it('root-level multi-file `.gltf` resolves siblings without a directory prefix', async () => {
    const storage = new MemoryStorage();
    const mainPath = 'character.gltf';
    const mainBytes = bytesOf(MULTI_FILE_GLTF);
    await storage.write(mainPath, mainBytes);
    await storage.write('rig.bin', new Uint8Array([1, 2, 3]));
    await storage.write('tex.png', new Uint8Array([4, 5, 6]));

    await loadMultiFileGltf(storage, mainPath, mainBytes);

    expect(resolveBasherOpfsUrl(`${BASHER_OPFS_SCHEME}rig.bin`)).toMatch(/^blob:/);
    expect(resolveBasherOpfsUrl(`${BASHER_OPFS_SCHEME}tex.png`)).toMatch(/^blob:/);
  });

  it('repeat loads reuse the cache (no second blob URL issued for the same sibling)', async () => {
    const storage = new MemoryStorage();
    const mainPath = 'assets/rig/character.gltf';
    const mainBytes = bytesOf(MULTI_FILE_GLTF);
    await storage.write(mainPath, mainBytes);
    await storage.write('assets/rig/rig.bin', new Uint8Array([1, 2, 3]));
    await storage.write('assets/rig/tex.png', new Uint8Array([4, 5, 6]));

    await loadMultiFileGltf(storage, mainPath, mainBytes);
    const firstBufferUrl = resolveBasherOpfsUrl(`${BASHER_OPFS_SCHEME}assets/rig/rig.bin`);
    expect(firstBufferUrl).toMatch(/^blob:/);

    await loadMultiFileGltf(storage, mainPath, mainBytes);
    const secondBufferUrl = resolveBasherOpfsUrl(`${BASHER_OPFS_SCHEME}assets/rig/rig.bin`);
    // Same sentinel → same blob URL (Map.has short-circuit). Catching a
    // future regression that would leak blob URLs on every render.
    expect(secondBufferUrl).toBe(firstBufferUrl);
  });
});

describe('URL-resolution invariant — three.js base-path arithmetic', () => {
  it('relative URI resolution under the sentinel scheme matches the cache key', async () => {
    // three.js's LoaderUtils.resolveURL is `path + url` where path =
    // extractUrlBase(mainUrl) — i.e., everything up to and including
    // the last `/`. We can prove the sentinel scheme is round-trippable
    // by running the same arithmetic in the test and asserting cache
    // membership.
    const storage = new MemoryStorage();
    const mainPath = 'assets/rig/character.gltf';
    const mainBytes = bytesOf(MULTI_FILE_GLTF);
    await storage.write(mainPath, mainBytes);
    await storage.write('assets/rig/rig.bin', new Uint8Array([1, 2, 3]));
    await storage.write('assets/rig/tex.png', new Uint8Array([4, 5, 6]));
    const mainUrl = await loadMultiFileGltf(storage, mainPath, mainBytes);

    // Mirror extractUrlBase: substring up to and including the last `/`.
    const base = mainUrl.slice(0, mainUrl.lastIndexOf('/') + 1);
    const reconstructedBuffer = base + 'rig.bin';
    const reconstructedTexture = base + 'tex.png';

    expect(resolveBasherOpfsUrl(reconstructedBuffer)).toMatch(/^blob:/);
    expect(resolveBasherOpfsUrl(reconstructedTexture)).toMatch(/^blob:/);
  });
});
