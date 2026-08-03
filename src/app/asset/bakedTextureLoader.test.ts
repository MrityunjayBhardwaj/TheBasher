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
vi.mock('./bakedTextureStore', () => ({
  loadBakedTexture: (...args: unknown[]) => loadBakedTexture(...args),
}));
vi.mock('../boot', () => ({
  getStorage: vi.fn(async () => ({})),
}));

import {
  peekBakedTexture,
  resolveBakedTexture,
  __resetBakedTextureLoaderForTests,
} from './bakedTextureLoader';

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
    loadBakedTexture.mockReset();
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

  it('a failed decode makes resolveBakedTexture (the Suspense core) re-THROW', async () => {
    const err = new Error('corrupt texture bytes');
    loadBakedTexture.mockRejectedValue(err);

    // Prime the error cache through the non-throwing peek.
    expect(peekBakedTexture(REF)).toBeNull();
    await flush();
    // The Suspense consumer surfaces the error (so its error boundary catches it).
    expect(() => resolveBakedTexture(REF)).toThrow('corrupt texture bytes');
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
