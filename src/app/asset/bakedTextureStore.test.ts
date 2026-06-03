import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import {
  BAKED_TEXTURE_ROOT,
  bakedTexturePath,
  loadBakedTexture,
  persistTexture,
} from './bakedTextureStore';

// happy-dom has no real image decoder + no OffscreenCanvas PNG encoder, so these
// tests drive the deterministic, decode-free paths: path (1) (original-bytes
// copy) and an INJECTED encoder/decoder for path (2). The real canvas readback +
// TextureLoader decode are exercised by the e2e (p151-texture-readback-probe +
// the Wave 4 glTF render), where a real browser is present (Lokayata: the unit
// proves the IO round-trip + colorspace contract; the e2e proves the decode).

/** A texture that reports captured-state fields but carries no decodable image. */
function makeTexture(opts?: {
  colorSpace?: string;
  flipY?: boolean;
  wrapS?: number;
  wrapT?: number;
}): THREE.Texture {
  const t = new THREE.Texture();
  t.colorSpace = opts?.colorSpace ?? THREE.SRGBColorSpace;
  t.flipY = opts?.flipY ?? false;
  t.wrapS = opts?.wrapS ?? THREE.RepeatWrapping;
  t.wrapT = opts?.wrapT ?? THREE.ClampToEdgeWrapping;
  return t;
}

describe('bakedTextureStore', () => {
  it('(path 1) copies ORIGINAL source bytes verbatim when the source survives (lossless)', async () => {
    const storage = new MemoryStorage();
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // PNG-ish bytes
    await storage.write('user-imports/asset/texture.png', original);

    const tex = makeTexture({ colorSpace: THREE.SRGBColorSpace });
    const ref = await persistTexture(storage, tex, {
      resolveSourcePath: () => 'user-imports/asset/texture.png',
    });

    // The hash ref ends in the SOURCE extension (path 1 keeps the original).
    expect(ref.hash.endsWith('.png')).toBe(true);
    // The persisted OPFS bytes are byte-identical to the source (no re-encode).
    const dot = ref.hash.lastIndexOf('.');
    const persisted = await storage.read(
      bakedTexturePath(ref.hash.slice(0, dot), ref.hash.slice(dot + 1)),
    );
    expect(Array.from(persisted)).toEqual(Array.from(original));
    // Captured colorspace/flip/wrap travel on the ref.
    expect(ref.colorSpace).toBe('srgb');
    expect(ref.flipY).toBe(false);
    expect(ref.wrapS).toBe(THREE.RepeatWrapping);
    expect(ref.wrapT).toBe(THREE.ClampToEdgeWrapping);
  });

  it('(path 2) falls back to the injected encoder when no source path resolves', async () => {
    const storage = new MemoryStorage();
    const encoded = new Uint8Array([10, 20, 30, 40, 50]);
    const tex = makeTexture({ colorSpace: THREE.NoColorSpace });

    const ref = await persistTexture(storage, tex, {
      resolveSourcePath: () => null, // path 1 unavailable
      encodeImage: async () => ({ bytes: encoded, ext: 'png' }),
    });

    const dot = ref.hash.lastIndexOf('.');
    const persisted = await storage.read(
      bakedTexturePath(ref.hash.slice(0, dot), ref.hash.slice(dot + 1)),
    );
    expect(Array.from(persisted)).toEqual(Array.from(encoded));
    expect(ref.colorSpace).toBe('no-colorspace');
  });

  it('(path 2) falls back when path-1 source bytes are MISSING (deleted asset, H60)', async () => {
    const storage = new MemoryStorage();
    const encoded = new Uint8Array([7, 7, 7]);
    const tex = makeTexture();

    // resolveSourcePath points at a file that does not exist → read throws →
    // the store must fall through to the encoder, NOT propagate the error.
    const ref = await persistTexture(storage, tex, {
      resolveSourcePath: () => 'user-imports/gone/missing.png',
      encodeImage: async () => ({ bytes: encoded, ext: 'png' }),
    });
    const dot = ref.hash.lastIndexOf('.');
    const persisted = await storage.read(
      bakedTexturePath(ref.hash.slice(0, dot), ref.hash.slice(dot + 1)),
    );
    expect(Array.from(persisted)).toEqual(Array.from(encoded));
  });

  it('is idempotent — identical bytes persist to ONE file (SC-4 dedupe)', async () => {
    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    const same = new Uint8Array([1, 2, 3, 4]);
    const encodeImage = async () => ({ bytes: same, ext: 'png' });

    const a = await persistTexture(storage, makeTexture(), { encodeImage });
    const b = await persistTexture(storage, makeTexture(), { encodeImage });

    expect(a.hash).toBe(b.hash);
    expect(writeSpy).toHaveBeenCalledTimes(1); // second hit the read-or-skip dedupe
  });

  it('persist → load round-trip restores colorspace/flipY/wrap EXACTLY (M5)', async () => {
    const storage = new MemoryStorage();
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const tex = makeTexture({
      colorSpace: THREE.SRGBColorSpace,
      flipY: false,
      wrapS: THREE.MirroredRepeatWrapping,
      wrapT: THREE.RepeatWrapping,
    });

    const ref = await persistTexture(storage, tex, {
      encodeImage: async () => ({ bytes: pixels, ext: 'png' }),
    });

    // Inject a decode that returns a texture with the WRONG defaults (NoColorSpace
    // + flipY=true, exactly what THREE.TextureLoader yields) so the test proves
    // loadBakedTexture OVERWRITES them from the ref (the M5/M8 washed-out guard).
    const decoded = await loadBakedTexture(storage, ref, {
      decode: async (url) => {
        expect(url.startsWith('blob:')).toBe(true);
        const t = new THREE.Texture();
        // Simulate a decoded 2x1 image so `image.width>0` holds (the plan's verify).
        t.image = { width: 2, height: 1 } as unknown as THREE.Texture['image'];
        t.colorSpace = THREE.NoColorSpace; // wrong on purpose
        t.flipY = true; // wrong on purpose
        return t;
      },
    });

    const img = decoded.image as { width?: number };
    expect((img.width ?? 0) > 0).toBe(true);
    // Restored EXPLICITLY from the ref — not the loader defaults.
    expect(decoded.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(decoded.flipY).toBe(false);
    expect(decoded.wrapS).toBe(THREE.MirroredRepeatWrapping);
    expect(decoded.wrapT).toBe(THREE.RepeatWrapping);
  });

  it('bakedTexturePath roots under the dedicated baked-texture dir', () => {
    expect(bakedTexturePath('abc123', 'png')).toBe(`${BAKED_TEXTURE_ROOT}/abc123.png`);
    expect(bakedTexturePath('abc123', '.JPG')).toBe(`${BAKED_TEXTURE_ROOT}/abc123.jpg`);
  });
});
