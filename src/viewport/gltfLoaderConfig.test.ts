// gltfLoaderConfig — config-level proof (#80).
//
// Verifies the self-hosted decoder contract:
//   - Constants point at the right `public/` paths.
//   - The decoder asset files physically exist on disk under `public/`
//     (so a fresh `npm install` + `npm run build` will ship them).
//   - drei's `useGLTF` is called with `useDraco='/draco/'` (string, not
//     boolean) in the consumer — proved via grep in this same test, so
//     a future refactor that drops the self-hosted path back to the
//     drei CDN default fails CI loudly.
//
// The runtime KTX2 wiring (the `extendLoader` callback) is exercised by
// the e2e test that loads a Draco-compressed `.glb` fixture; here we
// only assert the *config* surface that doesn't need a browser.
//
// REF: #80, src/viewport/gltfLoaderConfig.ts, src/viewport/SceneFromDAG.tsx
// (the GltfAssetR consumer).

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRACO_DECODER_PATH, KTX2_TRANSCODER_PATH } from './gltfLoaderConfig';

const PUBLIC = join(__dirname, '..', '..', 'public');

describe('gltfLoaderConfig — self-hosted decoder paths (#80)', () => {
  it('exports the canonical self-hosted paths (NOT a CDN URL)', () => {
    // The original drei default was `https://www.gstatic.com/draco/...`.
    // We must point at OUR public/ root, served at the app root path.
    expect(DRACO_DECODER_PATH).toBe('/draco/');
    expect(KTX2_TRANSCODER_PATH).toBe('/basis/');
    // Defense against accidentally re-introducing a CDN URL: no scheme,
    // no host, must start with '/'.
    expect(DRACO_DECODER_PATH).not.toMatch(/^https?:/);
    expect(KTX2_TRANSCODER_PATH).not.toMatch(/^https?:/);
    expect(DRACO_DECODER_PATH.startsWith('/')).toBe(true);
    expect(KTX2_TRANSCODER_PATH.startsWith('/')).toBe(true);
  });

  it('the Draco decoder WASM is committed under public/draco/', () => {
    expect(existsSync(join(PUBLIC, 'draco', 'draco_decoder.wasm'))).toBe(true);
    expect(existsSync(join(PUBLIC, 'draco', 'draco_decoder.js'))).toBe(true);
    expect(existsSync(join(PUBLIC, 'draco', 'draco_wasm_wrapper.js'))).toBe(true);
  });

  it('the KTX2/Basis transcoder is committed under public/basis/', () => {
    expect(existsSync(join(PUBLIC, 'basis', 'basis_transcoder.wasm'))).toBe(true);
    expect(existsSync(join(PUBLIC, 'basis', 'basis_transcoder.js'))).toBe(true);
  });

  it('GltfAssetR consumes useGLTF with the SELF-HOSTED Draco path (regression guard)', () => {
    // Source-grep against the consumer: a future refactor that drops
    // the `'/draco/'` arg back to the bare `useGLTF(url)` shape would
    // silently re-introduce the THESIS §48 CDN dependency. Catch it.
    const src = readFileSync(join(__dirname, 'SceneFromDAG.tsx'), 'utf8');
    // Must call useGLTF with the self-hosted path as the 2nd arg.
    expect(src).toMatch(/useGLTF\(\s*url\s*,\s*['"]\/draco\/['"]/);
    // Must NOT call useGLTF with no extra args (the drei-CDN default).
    expect(src).not.toMatch(/useGLTF\(\s*url\s*\)\s*as\s+unknown/);
  });

  it('the Draco-compressed test fixture exists (asset-side proof)', () => {
    // Generated via `gltf-pipeline -i public/assets/cube.gltf -d -o
    // public/assets/cube-draco.glb`. The e2e suite loads it to prove
    // the runtime KTX2/Draco wiring works end-to-end; here we just
    // assert the fixture is present so the e2e doesn't 404.
    expect(existsSync(join(PUBLIC, 'assets', 'cube-draco.glb'))).toBe(true);
    // Magic bytes check: a real GLB starts with the ASCII 'glTF'.
    const buf = readFileSync(join(PUBLIC, 'assets', 'cube-draco.glb'));
    expect(buf.slice(0, 4).toString('ascii')).toBe('glTF');
  });
});
