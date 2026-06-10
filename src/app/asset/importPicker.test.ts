// Unit coverage for the file-picker auto-escalation TRIGGER
// (`gltfImportNeedsFolder`) — the pure decision behind `openGltfFilePicker`
// re-opening as the directory picker when a multi-file `.gltf` is picked alone.
//
// The decision must agree with what `ingestGltfFolder` would later check (same
// `locateEntryFile` + `missingGltfSiblings`), so a `.gltf` that needs siblings
// escalates BEFORE writing a partial asset, and a self-fulfilling set
// (`.glb`, flat `.gltf` + siblings, or no glTF) imports directly. Testing the
// pure trigger keeps the escalation falsifiable without driving a real OS
// file dialog (that wiring is covered by tests/e2e/menu-import-gltf.spec.ts).
//
// REF: #H88 (affordance accepts a file it can't fulfill); opfsGltfResolver
// `missingGltfSiblings`; importGltf `locateEntryFile`.

import { describe, expect, it } from 'vitest';
import { gltfImportNeedsFolder } from './importPicker';
import type { IngestFile } from './importGltf';

const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

/** A multi-file glTF doc: external `.bin` buffer + one external texture. */
const MULTI_GLTF = { buffers: [{ uri: 'scene.bin' }], images: [{ uri: 'textures/tex.png' }] };
/** A self-contained glTF doc: data-URI buffer, no external images. */
const SELF_GLTF = {
  buffers: [{ uri: 'data:application/octet-stream;base64,AAAAAAAA' }],
};

const file = (relativePath: string, bytes: Uint8Array = new Uint8Array()): IngestFile => ({
  relativePath,
  bytes,
});

describe('gltfImportNeedsFolder', () => {
  it('flags a lone multi-file .gltf and names every missing sibling', () => {
    const need = gltfImportNeedsFolder([file('scene.gltf', enc(MULTI_GLTF))]);
    expect(need).not.toBeNull();
    expect(need?.entryName).toBe('scene.gltf');
    expect(need?.missing).toEqual(['scene.bin', 'textures/tex.png']);
  });

  it('returns null when the .gltf is picked together with all its siblings', () => {
    const need = gltfImportNeedsFolder([
      file('scene.gltf', enc(MULTI_GLTF)),
      file('scene.bin'),
      file('textures/tex.png'),
    ]);
    expect(need).toBeNull();
  });

  it('returns null for a self-contained .glb (no escalation)', () => {
    expect(gltfImportNeedsFolder([file('model.glb', new Uint8Array([1, 2, 3]))])).toBeNull();
  });

  it('returns null for a self-contained data-URI .gltf', () => {
    expect(gltfImportNeedsFolder([file('scene.gltf', enc(SELF_GLTF))])).toBeNull();
  });

  it('returns null when no glTF entry is present', () => {
    expect(gltfImportNeedsFolder([file('motion.bvh'), file('notes.txt')])).toBeNull();
  });

  it('flags a partial pick — .gltf + .bin but the texture is still missing', () => {
    const need = gltfImportNeedsFolder([file('scene.gltf', enc(MULTI_GLTF)), file('scene.bin')]);
    expect(need?.missing).toEqual(['textures/tex.png']);
  });

  it('uses the shallowest .gltf as the entry and reports its basename', () => {
    // A nested-export shape: the entry .gltf lives under gltf/, siblings absent.
    const nested = { buffers: [{ uri: '../buffers/scene.bin' }] };
    const need = gltfImportNeedsFolder([file('gltf/scene.gltf', enc(nested))]);
    expect(need?.entryName).toBe('scene.gltf');
    expect(need?.missing).toEqual(['../buffers/scene.bin']);
  });
});
