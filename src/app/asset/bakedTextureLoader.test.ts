// peekBakedTexture — the NON-throwing read used by the UV-editor texture
// backdrop (UX #10), which lives OUTSIDE a Suspense boundary and must never
// throw/hang. Contrast with resolveBakedTexture (the Suspense core), which
// throws the in-flight promise. happy-dom has no real decoder, so we inject
// loadBakedTexture + getStorage and drive the cache/error state machine.
//
// The second describe below is about something else this module owns and nothing
// used to assert: it is the module that makes two materials SHARE one decoded
// texture, which is the premise every per-material clone downstream exists to
// protect. See that block's header for the measurement (#554).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { BakedTextureRef } from '../../nodes/types';

const loadBakedTexture = vi.fn();
/** #1312 — which file a ref reads; a project image's moves with the open project. */
let openProject = 'p1';
const refToPath = (ref: BakedTextureRef) =>
  ref.store === 'project' ? `projects/${openProject}/images/${ref.hash}` : `textures/${ref.hash}`;
vi.mock('./bakedTextureStore', () => ({
  loadBakedTexture: (...args: unknown[]) => loadBakedTexture(...args),
  refToPath: (ref: BakedTextureRef) => refToPath(ref),
}));
vi.mock('../boot', () => ({
  getStorage: vi.fn(async () => ({})),
}));

import {
  peekBakedTexture,
  resolveBakedTexture,
  __resetBakedTextureLoaderForTests,
} from './bakedTextureLoader';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { __resetReadFailuresForTests } from './readFailures';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { withWriteNotice } from '../../core/storage/writeNotice';

const REF: BakedTextureRef = {
  hash: 'deadbeef.png',
  colorSpace: 'srgb',
  flipY: false,
  wrapS: THREE.RepeatWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
};

/** Resolve all microtasks so the fire-and-forget load settles. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('peekBakedTexture (non-throwing UV-backdrop read)', () => {
  beforeEach(() => {
    __resetBakedTextureLoaderForTests();
    __resetReadFailuresForTests();
    loadBakedTexture.mockReset();
    useAssetErrorStore.getState().clearAll();
    openProject = 'p1';
  });

  it('returns null on a cache MISS instead of throwing, and kicks off ONE load', async () => {
    const tex = new THREE.Texture();
    loadBakedTexture.mockResolvedValue(tex);

    // First peek: miss → null (NOT a thrown promise like resolveBakedTexture).
    expect(peekBakedTexture(REF)).toBeNull();
    // A second peek before the load settles must NOT start a second load.
    expect(peekBakedTexture(REF)).toBeNull();
    await flush();
    expect(loadBakedTexture).toHaveBeenCalledTimes(1);

    // Once decoded, the peek returns the cached texture (the backdrop fills in).
    expect(peekBakedTexture(REF)).toBe(tex);
  });

  it('returns null (no throw, no permanent hang) when the decode FAILS', async () => {
    loadBakedTexture.mockRejectedValue(new Error('corrupt texture bytes'));

    expect(peekBakedTexture(REF)).toBeNull();
    await flush();
    // The cached error keeps peek returning null — the editor shows the grid,
    // never crashes (resilience by construction, V48).
    expect(peekBakedTexture(REF)).toBeNull();
  });

  // #1048 — a failed read used to re-throw here, into render, and on every road without an error
  // boundary (native meshes, primitives with a map) that unmounted the whole app.
  it('a failed decode makes resolveBakedTexture return a magenta stand-in, never throw', async () => {
    loadBakedTexture.mockRejectedValue(new Error('corrupt texture bytes'));

    expect(() => resolveBakedTexture(REF)).toThrow(); // the first call suspends on the read
    await flush();
    const stand = resolveBakedTexture(REF);
    const texel = (stand as THREE.DataTexture).image.data as Uint8Array;
    expect(Array.from(texel)).toEqual([255, 0, 255, 255]);
    expect(resolveBakedTexture(REF), 'one stand-in per failed image').toBe(stand);
  });

  it('a failed read names the image in the asset banner, once', async () => {
    loadBakedTexture.mockRejectedValue(
      new Error('A requested file or directory could not be found'),
    );
    const project = { ...REF, store: 'project' as const };
    expect(() => resolveBakedTexture(project)).toThrow();
    expect(peekBakedTexture(project)).toBeNull(); // the same read, not a second one
    await flush();
    resolveBakedTexture(project);
    const errors = useAssetErrorStore.getState().errors;
    expect(Object.keys(errors)).toEqual([`images/${REF.hash}`]);
    expect(errors[`images/${REF.hash}`]).toMatch(/drawn magenta: .*could not be found/);
    expect(loadBakedTexture).toHaveBeenCalledTimes(1);
  });

  // #1312 — importing the same image writes the same file back. The cached failure used to answer
  // for it until a reload, so the NEW import drew the stand-in too (measured).
  it('once the file is written again, the next resolve reads it and the banner row clears', async () => {
    const project = { ...REF, store: 'project' as const };
    loadBakedTexture.mockRejectedValueOnce(new Error('could not be found'));
    expect(() => resolveBakedTexture(project)).toThrow();
    await flush();
    const stand = resolveBakedTexture(project);

    const decoded = new THREE.Texture();
    loadBakedTexture.mockResolvedValue(decoded);
    await withWriteNotice(new MemoryStorage()).write(refToPath(project), new Uint8Array([1]));

    expect(() => resolveBakedTexture(project)).toThrow(); // a fresh read, not the stand-in
    await flush();
    expect(resolveBakedTexture(project)).toBe(decoded);
    expect(resolveBakedTexture(project)).not.toBe(stand);
    expect(useAssetErrorStore.getState().errors).toEqual({});
  });

  it('a project image that failed in one project is read again under another', async () => {
    const project = { ...REF, store: 'project' as const };
    loadBakedTexture.mockRejectedValueOnce(new Error('could not be found'));
    expect(() => resolveBakedTexture(project)).toThrow();
    await flush();
    expect((resolveBakedTexture(project) as THREE.DataTexture).image.width).toBe(1);

    const decoded = new THREE.Texture();
    loadBakedTexture.mockResolvedValue(decoded);
    openProject = 'p2'; // same key, another file
    expect(() => resolveBakedTexture(project)).toThrow();
    await flush();
    expect(resolveBakedTexture(project)).toBe(decoded);
  });

  it('a write to the path an OLDER failure read does not clear the newer one', async () => {
    const project = { ...REF, store: 'project' as const };
    loadBakedTexture.mockRejectedValue(new Error('could not be found'));
    expect(() => resolveBakedTexture(project)).toThrow();
    await flush();
    resolveBakedTexture(project); // failed under p1
    openProject = 'p2';
    expect(() => resolveBakedTexture(project)).toThrow(); // retried under p2 …
    await flush();
    const stand = resolveBakedTexture(project); // … and failed there too

    await withWriteNotice(new MemoryStorage()).write(
      `projects/p1/images/${REF.hash}`,
      new Uint8Array([1]),
    );

    expect(resolveBakedTexture(project), 'p2 still has no such file').toBe(stand);
    expect(Object.keys(useAssetErrorStore.getState().errors)).toEqual([`images/${REF.hash}`]);
  });
});

// ── THE SHARING PREMISE (#554) ─────────────────────────────────────────────────
//
// Five places downstream clone a decoded texture before mutating it, because two
// materials drawing one image are handed ONE instance from the cache below. That
// sentence is the premise every one of those clones exists for, and until this
// block nothing anywhere asserted it.
//
// It is not a hypothetical hole. Measured: making a cache HIT return `hit.clone()`
// — i.e. quietly ending the sharing — left all 3798 unit tests green AND left
// `tests/e2e/p06-3-texture-placement.spec.ts:115` green, which is the browser case
// that exists specifically to prove the per-material clone holds. Its own comment
// claims "same hash → the SAME cached Texture instance" and it never measured it,
// so it would have gone on passing while the thing it guards became pointless.
//
// Identity is the half that carries the premise, and it is what the probe reds.
// The call count is NOT independent of it — a cache that re-decoded and returned
// the fresh instance would red both — and it is kept anyway for the one thing
// identity cannot see: a redundant decode whose result is discarded, which leaves
// every consumer correct and re-reads OPFS on every hit. Recorded rather than
// implied, so the next reader does not mistake it for a second witness.
//
// REF: src/app/materialRegistry.ts (`build`'s `prep` — the clone this protects);
//      tests/e2e/p06-3-texture-placement.spec.ts (the browser half); issues #554, #535.
describe('resolveBakedTexture — two consumers of one hash get ONE decoded texture', () => {
  beforeEach(() => {
    __resetBakedTextureLoaderForTests();
    loadBakedTexture.mockReset();
  });

  it('returns the SAME instance to every consumer, and decodes the bytes ONCE', async () => {
    const tex = new THREE.Texture();
    loadBakedTexture.mockResolvedValue(tex);

    // Prime the cache the way a first consumer does: suspend, settle, retry.
    expect(() => resolveBakedTexture(REF)).toThrow();
    await flush();

    // Consumer A and consumer B — two materials, one hash. Deep equality would be
    // satisfied by two clones; only reference identity is the premise.
    const a = resolveBakedTexture(REF);
    const b = resolveBakedTexture({ ...REF });
    expect(a).toBe(tex);
    expect(b).toBe(a);
    // …and the second consumer did not decode again. A per-consumer decode shares
    // nothing while still returning something that looks right to every caller.
    expect(loadBakedTexture).toHaveBeenCalledTimes(1);
  });

  it('#1050 — one image under two samplers is two textures, not whichever loaded first', async () => {
    // A cached Texture carries its wrap and filters into every material clone, so sharing one
    // instance across samplers would make the first material decide how the second samples.
    loadBakedTexture.mockImplementation(async () => new THREE.Texture());
    const nearest: BakedTextureRef = {
      ...REF,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
    };

    expect(peekBakedTexture(REF)).toBeNull();
    expect(peekBakedTexture(nearest)).toBeNull();
    await flush();
    const smooth = peekBakedTexture(REF);
    const sharp = peekBakedTexture(nearest);
    expect(smooth).not.toBeNull();
    expect(sharp).not.toBeNull();
    expect(sharp).not.toBe(smooth);
    expect(loadBakedTexture).toHaveBeenCalledTimes(2);
  });

  it('hands the peek road the same instance as the Suspense road', async () => {
    const tex = new THREE.Texture();
    loadBakedTexture.mockResolvedValue(tex);

    // The UV-editor backdrop and the renderer are two consumers of one hash too,
    // and they enter through different doors. If those doors ever stopped agreeing,
    // the editor would paint a placement onto a texture the renderer is not drawing.
    expect(peekBakedTexture(REF)).toBeNull();
    await flush();
    expect(peekBakedTexture(REF)).toBe(resolveBakedTexture(REF));
    expect(loadBakedTexture).toHaveBeenCalledTimes(1);
  });
});
