// Unit tests for the `.basher` scene-bundle core: the deductive asset-ref walk,
// the base64 codec, the envelope schema (incl. legacy backward-compat), and the
// envelope→Project load ladder.

import { beforeEach, describe, expect, it } from 'vitest';
import type { DagState } from '../core/dag/state';
import { __resetRegistryForTests } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { composeProject } from '../core/project/io';
import {
  SceneBundleSchema,
  bundleToProject,
  collectAssetRefs,
  resolveAssetFiles,
  bytesToBase64,
  base64ToBytes,
  isSelfContained,
  SCENE_BUNDLE_VERSION,
} from './sceneBundle';
import { MemoryStorage } from '../core/storage/MemoryStorage';
import { BAKED_TEXTURE_ROOT } from './asset/bakedTextureStore';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/** Build a DagState from loosely-typed nodes (the collector only reads params). */
function stateFromParams(params: Record<string, Record<string, unknown>>): DagState {
  const nodes: Record<string, unknown> = {};
  for (const [id, p] of Object.entries(params)) {
    nodes[id] = { id, type: 'X', version: 1, params: p };
  }
  return { nodes, outputs: {} } as unknown as DagState;
}

describe('collectAssetRefs', () => {
  it('collects a GltfAsset assetRef as its whole user-imports folder prefix', () => {
    const state = stateFromParams({
      g: { assetRef: 'user-imports/cube/cube.glb' },
    });
    const refs = collectAssetRefs(state);
    expect(refs.gltfFolders).toEqual(['user-imports/cube']);
    expect(refs.bakedGeometry).toEqual([]);
    expect(refs.bakedTextureHashes).toEqual([]);
  });

  it('collects a nested multi-file glTF assetRef to the same folder once', () => {
    const state = stateFromParams({
      a: { assetRef: 'user-imports/scene/scene.gltf' },
      b: { assetRef: 'user-imports/scene/scene.bin' },
    });
    expect(collectAssetRefs(state).gltfFolders).toEqual(['user-imports/scene']);
  });

  it('collects a baked GeometryDescriptor to its OPFS bin path', () => {
    const state = stateFromParams({
      m: {
        geometry: {
          key: 'baked|abc-8',
          kind: 'baked',
          descriptor: { kind: 'baked', hash: 'abc', vertexCount: 8 },
        },
      },
    });
    // The descriptor nested under geometry.descriptor is what carries hash+vc.
    expect(collectAssetRefs(state).bakedGeometry).toEqual(['baked-geometry/abc-8.bin']);
  });

  it('collects a BakedTextureRef hash from a material map slot', () => {
    // The REAL ref shape persistTexture returns: `<hash>.<ext>` (NOT a bare
    // hash — the degenerate fixture this test used to carry let the resolve-side
    // ext mismatch ship; see the resolveAssetFiles test below).
    const state = stateFromParams({
      mat: {
        maps: {
          albedo: {
            hash: '7b7cb53d.png',
            colorSpace: 'srgb',
            flipY: false,
            wrapS: 1000,
            wrapT: 1000,
          },
          normal: null,
        },
      },
    });
    expect(collectAssetRefs(state).bakedTextureHashes).toEqual(['7b7cb53d.png']);
  });

  it('does NOT collect the glTF cleared-map sentinel (empty hash, no OPFS file)', () => {
    const state = stateFromParams({
      mat: {
        maps: {
          // #178 S5 CLEARED_MAP — an empty-hash BakedTextureRef: round-trips as
          // plain data but references no file, so it is never embedded.
          albedo: { hash: '', colorSpace: 'srgb', flipY: false, wrapS: 1000, wrapT: 1000 },
        },
      },
    });
    expect(collectAssetRefs(state).bakedTextureHashes).toEqual([]);
  });

  it('collects a Scene env file assetRef (env-hdri) as its exact path (UX #9)', () => {
    const state = stateFromParams({
      scene: {
        envSource: { kind: 'file', assetRef: 'env-hdri/b90a6094.hdr', name: 'studio.hdr' },
        envIntensity: 1,
      },
    });
    const refs = collectAssetRefs(state);
    expect(refs.envHdri).toEqual(['env-hdri/b90a6094.hdr']);
    expect(refs.gltfFolders).toEqual([]);
  });

  it('does NOT collect a preset env source (CDN, not OPFS) — UX #9', () => {
    const state = stateFromParams({
      scene: { envSource: { kind: 'preset', name: 'sunset' } },
    });
    expect(collectAssetRefs(state).envHdri).toEqual([]);
  });

  it('does NOT collect app-shipped assets/ paths (re-seeded on every instance)', () => {
    const state = stateFromParams({
      g: { assetRef: 'assets/example.glb' },
    });
    expect(collectAssetRefs(state).gltfFolders).toEqual([]);
  });

  it('walks arbitrarily nested params (arrays + objects) for every ref shape', () => {
    const state = stateFromParams({
      n: {
        deep: {
          list: [
            { assetRef: 'user-imports/rig/rig.glb' },
            {
              tex: {
                hash: 'cafe',
                colorSpace: 'srgb-linear',
                flipY: false,
                wrapS: 1000,
                wrapT: 1000,
              },
            },
          ],
          geom: { kind: 'baked', hash: 'beef', vertexCount: 24 },
        },
      },
    });
    const refs = collectAssetRefs(state);
    expect(refs.gltfFolders).toEqual(['user-imports/rig']);
    expect(refs.bakedTextureHashes).toEqual(['cafe']);
    expect(refs.bakedGeometry).toEqual(['baked-geometry/beef-24.bin']);
  });

  it('returns empty refs for the default scene (no imported/baked assets)', () => {
    const refs = collectAssetRefs(buildDefaultDagState());
    expect(refs.gltfFolders).toEqual([]);
    expect(refs.bakedGeometry).toEqual([]);
    expect(refs.bakedTextureHashes).toEqual([]);
  });
});

describe('resolveAssetFiles — baked-texture hash → OPFS file', () => {
  it('resolves an ext-bearing ref hash (<hash>.<ext>) to its OPFS file', async () => {
    // The regression guard for the bundle drop: a real BakedTextureRef.hash is
    // `7b7cb53d.png` (persistTexture stamps the ext). Keying the resolve lookup
    // by the BARE hash — the old behaviour — silently dropped this file from the
    // bundle, so an edited glTF map (or any baked texture) didn't round-trip.
    const storage = new MemoryStorage();
    await storage.write(`${BAKED_TEXTURE_ROOT}/7b7cb53d.png`, new Uint8Array([1, 2, 3]));
    const files = await resolveAssetFiles(storage, {
      gltfFolders: [],
      bakedGeometry: [],
      bakedTextureHashes: ['7b7cb53d.png'],
      envHdri: [],
    });
    expect(files).toEqual([`${BAKED_TEXTURE_ROOT}/7b7cb53d.png`]);
  });

  it('still resolves a legacy bare-hash ref (no extension) via the dir listing', async () => {
    const storage = new MemoryStorage();
    await storage.write(`${BAKED_TEXTURE_ROOT}/cafe.jpg`, new Uint8Array([9]));
    const files = await resolveAssetFiles(storage, {
      gltfFolders: [],
      bakedGeometry: [],
      bakedTextureHashes: ['cafe'],
      envHdri: [],
    });
    expect(files).toEqual([`${BAKED_TEXTURE_ROOT}/cafe.jpg`]);
  });

  it('drops a hash with no matching OPFS file (no phantom path embedded)', async () => {
    const storage = new MemoryStorage();
    const files = await resolveAssetFiles(storage, {
      gltfFolders: [],
      bakedGeometry: [],
      bakedTextureHashes: ['missing.png'],
      envHdri: [],
    });
    expect(files).toEqual([]);
  });
});

describe('base64 codec', () => {
  it('round-trips arbitrary binary bytes (incl. 0x00 and 0xff)', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 0, 42]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips a large buffer past the chunk boundary', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('encodes an empty buffer to an empty string and back', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });
});

describe('SceneBundleSchema', () => {
  it('accepts a self-contained bundle with embedded assets', () => {
    const validState = buildDefaultDagState();
    const parsed = SceneBundleSchema.parse({
      formatVersion: 1,
      bundleVersion: SCENE_BUNDLE_VERSION,
      id: 'p1',
      name: 'Scene',
      exportedAt: 123,
      state: { nodes: validState.nodes, outputs: validState.outputs },
      assets: { 'user-imports/cube/cube.glb': 'AAAA' },
    });
    expect(isSelfContained(parsed)).toBe(true);
  });

  it('accepts a legacy DAG-only .basher.json (no bundleVersion, no assets)', () => {
    const validState = buildDefaultDagState();
    const parsed = SceneBundleSchema.parse({
      formatVersion: 1,
      id: 'p1',
      name: 'Legacy',
      exportedAt: 123,
      state: { nodes: validState.nodes, outputs: validState.outputs },
    });
    expect(isSelfContained(parsed)).toBe(false);
  });

  it('rejects a payload missing state', () => {
    expect(() => SceneBundleSchema.parse({ formatVersion: 1, id: 'p', name: 'n' })).toThrow();
  });
});

describe('bundleToProject', () => {
  it('produces a fresh Project under the new id with nodes preserved', () => {
    const src = composeProject({ id: 'orig', name: 'Orig', state: buildDefaultDagState() });
    const bundle = SceneBundleSchema.parse({
      formatVersion: 1,
      id: src.id,
      name: src.name,
      state: { nodes: src.state.nodes, outputs: src.state.outputs },
    });

    const project = bundleToProject(bundle, 'proj_new', 9999);

    expect(project.id).toBe('proj_new');
    expect(project.name).toBe('Orig');
    expect(project.formatVersion).toBe(1);
    expect(project.createdAt).toBe(9999);
    // The DAG survives the round-trip: identical node id set.
    expect(Object.keys(project.state.nodes).sort()).toEqual(Object.keys(src.state.nodes).sort());
    expect(project.state.outputs).toEqual(src.state.outputs);
  });

  it('throws on a structurally invalid node (the ProjectSchema gate bites)', () => {
    const bundle = SceneBundleSchema.parse({
      formatVersion: 1,
      id: 'x',
      name: 'bad',
      state: { nodes: { n1: { not: 'a node' } }, outputs: {} },
    });
    expect(() => bundleToProject(bundle, 'p', 1)).toThrow();
  });
});
