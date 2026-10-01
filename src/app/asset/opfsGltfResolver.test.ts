// Coverage for multi-file `.gltf` sibling paths (#82): where a sibling named by a
// relative URI lives in storage, and which siblings a picked file set is missing.
//
// The renderer half this file once covered — a sentinel URL scheme that let
// three.js's GLTFLoader fetch siblings — went with the clone renderer (#1053).
// The import reads sibling bytes directly through `opfsSiblingPath`.

import { describe, expect, it } from 'vitest';
import {
  formatMissingSiblingsError,
  missingGltfSiblings,
  opfsSiblingPath,
} from './opfsGltfResolver';

// glTF spec §3.9.3.1 requires URIs to be percent-encoded; the stored file carries
// the DECODED name, so the path must decode before it reaches storage.
describe('percent-encoding — a sibling resolves to its DECODED stored path', () => {
  it('opfsSiblingPath decodes the uri', () => {
    expect(opfsSiblingPath('user-imports/spaced/scene.gltf', 'my%20texture.png')).toBe(
      'user-imports/spaced/my texture.png',
    );
  });
});

// A nested export: `gltf/scene.gltf` references `../buffers/scene.bin`. The naive
// join contains `..` segments that OPFS's `getDirectoryHandle` rejects with "Name is
// not allowed", so the path is normalized before it reaches storage.
describe('relative-path normalization — `..` collapses against the entry directory', () => {
  it('opfsSiblingPath collapses `..` against the entry directory', () => {
    // gltf/scene.gltf + ../buffers/scene.bin → <dir>/buffers/scene.bin
    expect(opfsSiblingPath('user-imports/nested/gltf/scene.gltf', '../buffers/scene.bin')).toBe(
      'user-imports/nested/buffers/scene.bin',
    );
    expect(
      opfsSiblingPath('user-imports/nested/gltf/scene.gltf', '../textures/my texture.png'),
    ).toBe('user-imports/nested/textures/my texture.png');
  });

  it('opfsSiblingPath rejects paths that escape the root (anti-traversal)', () => {
    expect(() => opfsSiblingPath('user-imports/nested/scene.gltf', '../../../etc/secret')).toThrow(
      /escapes root/,
    );
  });
});

describe('missingGltfSiblings', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const MULTI = { buffers: [{ uri: 'scene.bin' }], images: [{ uri: 'texture.png' }] };

  it('reports every referenced sibling missing from a single-.gltf pick (flat)', () => {
    const present = new Set(['scene.gltf']);
    expect(missingGltfSiblings(enc(MULTI), 'scene.gltf', present)).toEqual([
      'scene.bin',
      'texture.png',
    ]);
  });

  it('reports none when all siblings are present (flat, file-picker multi-select)', () => {
    const present = new Set(['scene.gltf', 'scene.bin', 'texture.png']);
    expect(missingGltfSiblings(enc(MULTI), 'scene.gltf', present)).toEqual([]);
  });

  it('resolves siblings against the entry directory (folder pick)', () => {
    const present = new Set(['flat/scene.gltf', 'flat/scene.bin', 'flat/texture.png']);
    expect(missingGltfSiblings(enc(MULTI), 'flat/scene.gltf', present)).toEqual([]);
  });

  it('normalizes ../ siblings (nested export) so a present sibling matches', () => {
    const nested = { buffers: [{ uri: '../buffers/scene.bin' }] };
    const present = new Set(['nested/gltf/scene.gltf', 'nested/buffers/scene.bin']);
    expect(missingGltfSiblings(enc(nested), 'nested/gltf/scene.gltf', present)).toEqual([]);
  });

  it('decodes percent-encoded URIs for both the match and the display name', () => {
    const spaced = { images: [{ uri: 'my%20texture.png' }] };
    const present = new Set(['spaced/scene.gltf', 'spaced/my texture.png']);
    expect(missingGltfSiblings(enc(spaced), 'spaced/scene.gltf', present)).toEqual([]);
    expect(
      missingGltfSiblings(enc(spaced), 'spaced/scene.gltf', new Set(['spaced/scene.gltf'])),
    ).toEqual(['my texture.png']);
  });

  it('returns [] for a self-contained .gltf (data-URI buffer, no external refs)', () => {
    const selfContained = { buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }] };
    expect(missingGltfSiblings(enc(selfContained), 'scene.gltf', new Set(['scene.gltf']))).toEqual(
      [],
    );
  });

  it('returns [] for non-parseable bytes (let the real loader surface it)', () => {
    expect(
      missingGltfSiblings(new TextEncoder().encode('not json'), 'scene.gltf', new Set()),
    ).toEqual([]);
  });
});

describe('formatMissingSiblingsError — concise, actionable banner (multi-file glTF)', () => {
  it('leads with the FOLDER fix, not a wall of filenames', () => {
    const msg = formatMissingSiblingsError('car_Textured.gltf', ['a.png', 'b.png', 'c.png']);
    expect(msg).toContain('Import the whole FOLDER');
    expect(msg).toContain('File ▸ Import Folder');
    expect(msg.startsWith('import failed:')).toBe(true); // double-report guard relies on this
  });

  it('caps the example list and reports the true count (a 3D-ripper dumps dozens)', () => {
    const many = Array.from({ length: 14 }, (_, i) => `${i}_RGB_Cars.png`);
    const msg = formatMissingSiblingsError('toon_Textured.gltf', many);
    expect(msg).toContain('14 sibling files');
    expect(msg).toContain('+12 more'); // 2 shown, 12 summarized
    expect(msg).not.toContain('13_RGB_Cars.png'); // not a full dump
  });

  it('singularizes for a lone missing sibling', () => {
    const msg = formatMissingSiblingsError('scene.gltf', ['scene.bin']);
    expect(msg).toContain('1 sibling file (e.g. scene.bin)');
  });
});
