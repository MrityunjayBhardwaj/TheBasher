// Unit tests for the `.basher` scene-bundle core: the deductive asset-ref walk,
// the base64 codec, the envelope schema (incl. legacy backward-compat), and the
// envelope→Project load ladder.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DagState } from '../core/dag/state';
import { __resetRegistryForTests } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { composeProject } from '../core/project/io';
import { PROJECT_FORMAT_VERSION } from '../core/project/schema';
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

  it('collects a studio AreaLight `tex` env-hdri ref (#205 — survives cross-machine open)', () => {
    // The collector is VALUE-based (any `env-hdri/` string under node params), so
    // a studio light's `tex` embeds in the .basher bundle automatically — no new
    // collector branch, no [[H77]] silent-drop. Guards that for the new param home.
    const state = stateFromParams({
      light: {
        intensity: 5,
        position: [3, 4, 3],
        color: '#ffffff',
        width: 2,
        height: 2,
        lookAt: [0, 0, 0],
        tex: 'env-hdri/c0ffee01.exr',
      },
    });
    expect(collectAssetRefs(state).envHdri).toEqual(['env-hdri/c0ffee01.exr']);
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
    expect(project.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(project.createdAt).toBe(9999);
    // The DAG survives the round-trip with NOTHING lost — and, as of #387 C4, with nothing
    // ADDED either. Every scene object in the seed is now split-native (box #365, light
    // #386, camera #387), so a fresh project has no fused node left for any split pass to
    // convert. `added` reaching empty is the completion condition Stage C was aiming at,
    // not a weakening of this assertion.
    //
    // This is a SECOND road onto the same migration ladder — a bundle carries a raw DAG
    // and `bundleToProject` migrates it — which is why a per-kind split reds here as well
    // as in migrations.test.ts.
    const migratedIds = Object.keys(project.state.nodes);
    const srcIds = Object.keys(src.state.nodes);
    for (const id of srcIds) expect(migratedIds).toContain(id); // nothing lost
    const added = migratedIds.filter((id) => !srcIds.includes(id));
    expect(added).toEqual([]);
    // ...and the data halves really did travel, so "added nothing" cannot be read as
    // "carried nothing": a seed that regressed to a fused camera would both ADD a node
    // here and drop CameraData from the carried set.
    const carriedTypes = migratedIds.map((id) => project.state.nodes[id].type);
    expect(carriedTypes).toContain('CameraData');
    expect(carriedTypes).toContain('LightData');
    expect(carriedTypes).not.toContain('PerspectiveCamera');
    expect(project.state.outputs).toEqual(src.state.outputs);
  });

  // #619 — a `.basher` is a graph that arrives already assembled, so it never met
  // the connect-time gate any more than a project file did. Before the fix the two
  // ladders had drifted by one rung: loadProject repaired, bundleToProject did not,
  // and the duplicate survived into both the hydrated store and the file the import
  // wrote. Observed in the browser first (the import seam), pinned here.
  //
  // Built LITERALLY, because after the gate landed applyOp will not construct this
  // graph at all — a hand-assembled envelope is the only thing that can carry one,
  // and it is schema-VALID, which is exactly why the ProjectSchema rung above lets
  // it through.
  it('#619 — repairs a bundle that binds two producers of the SAME role', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = SceneBundleSchema.parse({
      formatVersion: PROJECT_FORMAT_VERSION,
      id: 'dup',
      name: 'two depth passes',
      state: {
        nodes: {
          job: {
            id: 'job',
            type: 'RenderJob',
            version: 1,
            params: {},
            inputs: {
              'pass-input': [
                { node: 'd1', socket: 'out' },
                { node: 'd2', socket: 'out' },
              ],
            },
          },
          d1: { id: 'd1', type: 'DepthPass', version: 1, params: {}, inputs: {} },
          d2: { id: 'd2', type: 'DepthPass', version: 1, params: {}, inputs: {} },
        },
        outputs: {},
      },
    });

    const project = bundleToProject(bundle, 'p', 1);

    expect(project.state.nodes.job.inputs['pass-input']).toEqual([{ node: 'd1', socket: 'out' }]);
    // No silent loss — the drop names the node it dropped.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept "d1", dropped "d2"'));
    warn.mockRestore();
  });

  // The separating member: identical shape, role-LESS producers. If the repair ever
  // grows into a cap on list length this stays green only while it is still a rule
  // about ROLES — an ordered list of clips is not a role map.
  it('#619 — leaves a bundle binding two role-LESS producers alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = SceneBundleSchema.parse({
      formatVersion: PROJECT_FORMAT_VERSION,
      id: 'clips',
      name: 'two clips',
      state: {
        nodes: {
          job: {
            id: 'job',
            type: 'RenderJob',
            version: 1,
            params: {},
            inputs: {
              'pass-input': [
                { node: 'c1', socket: 'out' },
                { node: 'c2', socket: 'out' },
              ],
            },
          },
          c1: { id: 'c1', type: 'MediaClip', version: 1, params: {}, inputs: {} },
          c2: { id: 'c2', type: 'MediaClip', version: 1, params: {}, inputs: {} },
        },
        outputs: {},
      },
    });

    const project = bundleToProject(bundle, 'p', 1);

    expect(project.state.nodes.job.inputs['pass-input']).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

  // ── The INVERSE of #620 ────────────────────────────────────────────────────
  //
  // #620 fixed the seams that hand the store's records OUT. This is the other
  // direction: `importSceneBundle` feeds `project.state.nodes` straight into
  // `useDagStore.hydrate`, so if `bundleToProject` passed the caller's tables
  // through by reference, the live store would adopt the CALLER's object and
  // anything the caller did to its bundle afterwards would edit the open scene.
  //
  // Measured during the #620 census: it does NOT, and that is worth a test rather
  // than a shrug, because nothing in the code says so. The detachment is a side
  // effect of `ProjectSchema.parse` rebuilding what it validates. Retyping any of
  // those fields to a pass-through (`z.any`, `z.custom`, a `.passthrough()` escape)
  // would silently reopen the alias with every other test in this file still green
  // — the aliasing version is value-identical, which is exactly what made the
  // original #620 defect survive so long.
  it('detaches an imported bundle from the project it becomes (#620, inverse direction)', () => {
    const bundle = SceneBundleSchema.parse({
      formatVersion: 1,
      id: 'x',
      name: 'imported',
      state: {
        nodes: { n1: { id: 'n1', type: 'MediaClip', version: 1, params: {}, inputs: {} } },
        outputs: {},
      },
    });

    const project = bundleToProject(bundle, 'p', 1);

    expect(project.state.nodes).not.toBe(bundle.state.nodes);
    expect(project.state.nodes.n1).not.toBe(bundle.state.nodes.n1);
    expect(project.state.outputs).not.toBe(bundle.state.outputs);

    // Stated as the failure it prevents: a caller that keeps its bundle and edits
    // it after the import must not be writing into what the store just adopted.
    (bundle.state.nodes as Record<string, unknown>).__late_write = {
      id: '__late_write',
      type: 'MediaClip',
      version: 1,
      params: {},
      inputs: {},
    };
    expect('__late_write' in project.state.nodes).toBe(false);
  });
});
