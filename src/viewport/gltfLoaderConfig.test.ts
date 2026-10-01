// gltfLoaderConfig — config-level proof (#80).
//
// Verifies the self-hosted decoder contract:
//   - Constants point at the right `public/` paths.
//   - The decoder asset files physically exist on disk under `public/`
//     (so a fresh `npm install` + `npm run build` will ship them).
//
// REF: #80, src/viewport/gltfLoaderConfig.ts, src/app/asset/dracoDecoder.ts.

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

  // (#1053) The `useGLTF` self-hosted-Draco guard read the clone renderer, deleted with the clone
  // road. The native reader decodes Draco through `decodeDracoInBrowser`, from the same
  // self-hosted files the rows above pin.

  it('the Draco-compressed test fixture exists (asset-side proof)', () => {
    // Generated via `gltf-pipeline -i public/assets/cube.gltf -d -o
    // public/assets/cube-draco.glb`. The e2e suite imports it through the
    // Draco decoder; here we just assert the fixture is present so the e2e
    // doesn't 404.
    expect(existsSync(join(PUBLIC, 'assets', 'cube-draco.glb'))).toBe(true);
    // Magic bytes check: a real GLB starts with the ASCII 'glTF'.
    const buf = readFileSync(join(PUBLIC, 'assets', 'cube-draco.glb'));
    expect(buf.slice(0, 4).toString('ascii')).toBe('glTF');
  });
});
