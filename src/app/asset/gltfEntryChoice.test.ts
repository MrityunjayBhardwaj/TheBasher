// Unit tests for the multi-glTF entry chooser logic (#214 follow-up):
// locateGltfEntries / summarizeGltfEntry (pure) + resolveGltfEntryChoice (the
// store-driven prompt). The chooser exists because a folder with >1 glTF (e.g. a
// `model.gltf` + `model_Textured.gltf` variant pack) would otherwise have ONE
// silently auto-picked — often the stripped/untextured one.

import { describe, it, expect, afterEach } from 'vitest';
import { locateGltfEntries, summarizeGltfEntry, type IngestFile } from './importGltf';
import { resolveGltfEntryChoice } from './gltfEntryChoice';
import { useGltfEntryChooserStore } from '../stores/gltfEntryChooserStore';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const file = (relativePath: string, bytes: Uint8Array): IngestFile => ({ relativePath, bytes });

afterEach(() => {
  // Drop any leftover request so a hung promise from a failed test can't bleed.
  useGltfEntryChooserStore.setState({ request: null });
});

describe('locateGltfEntries', () => {
  it('finds every .gltf/.glb, shallowest-first then by path', () => {
    const files = [
      file('textures/wall.png', enc({})),
      file('nested/deep.gltf', enc({})),
      file('b.gltf', enc({})),
      file('a.glb', enc({})),
      file('readme.txt', enc({})),
    ];
    expect(locateGltfEntries(files).map((f) => f.relativePath)).toEqual([
      'a.glb', // depth 1, sorts before b.gltf
      'b.gltf',
      'nested/deep.gltf', // depth 2 last
    ]);
  });

  it('returns one entry for a single-glTF folder', () => {
    const files = [file('scene.gltf', enc({})), file('scene.bin', new Uint8Array([1]))];
    expect(locateGltfEntries(files)).toHaveLength(1);
  });
});

describe('summarizeGltfEntry', () => {
  it('counts materials and textures', () => {
    const bytes = enc({ materials: [{}, {}, {}], textures: [{}] });
    expect(summarizeGltfEntry(bytes)).toEqual({ materials: 3, textures: 1 });
  });

  it('reports zero for absent arrays', () => {
    expect(summarizeGltfEntry(enc({}))).toEqual({ materials: 0, textures: 0 });
  });

  it('returns null counts for non-JSON bytes (a binary .glb)', () => {
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3]); // 'glTF' magic + junk
    expect(summarizeGltfEntry(glb)).toEqual({ materials: null, textures: null });
  });
});

describe('resolveGltfEntryChoice', () => {
  it('does NOT prompt for a single-entry folder (auto-locate)', async () => {
    const files = [file('scene.gltf', enc({}))];
    const result = await resolveGltfEntryChoice(files);
    expect(result).toEqual({ entry: undefined });
    expect(useGltfEntryChooserStore.getState().request).toBeNull(); // no modal
  });

  it('prompts for a multi-entry folder and resolves the chosen entry', async () => {
    const files = [
      file('plain.gltf', enc({ materials: [{}], textures: [] })),
      file('textured.gltf', enc({ materials: [{}, {}], textures: [{}, {}] })),
    ];
    const pending = resolveGltfEntryChoice(files);
    // The request is set synchronously (chooseGltfEntry's executor runs sync).
    const req = useGltfEntryChooserStore.getState().request;
    expect(req).not.toBeNull();
    // Options are richest-first → the textured entry is the default focus.
    expect(req!.options[0].relativePath).toBe('textured.gltf');
    expect(req!.options[0].textures).toBe(2);

    useGltfEntryChooserStore.getState().choose('textured.gltf');
    expect(await pending).toEqual({ entry: 'textured.gltf' });
    expect(useGltfEntryChooserStore.getState().request).toBeNull(); // closed
  });

  it('resolves null when the chooser is dismissed', async () => {
    const files = [file('a.gltf', enc({})), file('b.gltf', enc({}))];
    const pending = resolveGltfEntryChoice(files);
    useGltfEntryChooserStore.getState().cancel();
    expect(await pending).toBeNull();
  });
});
