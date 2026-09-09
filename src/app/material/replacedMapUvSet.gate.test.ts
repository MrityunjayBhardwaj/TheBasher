// #997 — a REPLACED map must sample the UV set its material names, not set 0.
//
// ── WHY THIS BINDING LIVES ON THE MATERIAL, WHICH IS THE WHOLE POINT OF THE GATE ──────
//
// The importer captures the set on the map descriptor (`BakedTextureRef.gltfTexCoord`),
// and that descriptor is destroyed by the very edit this feature exists to serve:
// `attachMapFromFile` builds a fresh ref from the picked file and never sees the ref it
// supersedes. So the obvious fix — read `gltfTexCoord` back at render time — resolves to
// 0 on every replaced slot and is a NO-OP that reads as a fix. Row 1 below is the row
// that would have caught that: it replaces the slot with a ref carrying NO `gltfTexCoord`
// and still requires the set to arrive.
//
// The inherited road is deliberately untested here — it needs nothing, because three's
// own loader binds a captured texture to its set (`GLTFLoader.js:3354-3357`). Asserting
// it would be asserting three's behaviour.
//
// REF: src/app/material/gltfMapOverlay.ts (`applyEditedMaps` — the subject);
//      src/core/import/gltfJsonMaterialToOpenpbr.ts (`capturePerMapUvSets`);
//      src/nodes/types.ts (`InlineMaterialSpec.mapUvSets`); issue #997.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { persistTexture } from '../asset/bakedTextureStore';
import { NULL_MAPS } from '../../nodes/materialSchema';
import type { BakedTextureRef, InlineMaterialMaps, UvPlacement } from '../../nodes/types';
import { applyEditedMaps } from './gltfMapOverlay';
import { materialKeyOf } from '../../nodes/materialKey';
import { gltfJsonMaterialToOpenpbr } from '../../core/import/gltfJsonMaterialToOpenpbr';
import fs from 'node:fs';
import path from 'node:path';

const IDENTITY: UvPlacement = { tiling: [1, 1], offset: [0, 0], rotation: 0 };

function maps(over: Partial<InlineMaterialMaps>): InlineMaterialMaps {
  return { ...NULL_MAPS, ...over };
}

async function bakedRef(storage: MemoryStorage, name: string): Promise<BakedTextureRef> {
  await storage.write(`user-imports/x/${name}.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]));
  return persistTexture(storage, new THREE.Texture(), {
    resolveSourcePath: () => `user-imports/x/${name}.png`,
  });
}

describe('#997 — a replaced map samples the UV set the material names', () => {
  it('the set arrives even though the replacement ref carries no gltfTexCoord', async () => {
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'a');
    // The premise this gate turns on, asserted rather than assumed.
    expect(ref.gltfTexCoord).toBeUndefined();

    const mat = new THREE.MeshStandardMaterial();
    const loaded = new THREE.Texture();
    await applyEditedMaps(
      mat,
      maps({ albedo: ref }),
      { shared: IDENTITY, uvSets: { albedo: 1 } },
      storage,
      () => false,
      { decode: async () => loaded },
    );

    expect(mat.map).toBe(loaded);
    expect(loaded.channel).toBe(1); // the defect left this 0
  });

  it('each slot gets its OWN set, not one material-wide answer', async () => {
    const storage = new MemoryStorage();
    const albedo = await bakedRef(storage, 'b');
    const normal = await bakedRef(storage, 'c');
    const mat = new THREE.MeshStandardMaterial();
    const texA = new THREE.Texture();
    const texN = new THREE.Texture();
    const decoded = [texA, texN];

    await applyEditedMaps(
      mat,
      maps({ albedo, normal }),
      { shared: IDENTITY, uvSets: { albedo: 2, normal: 1 } },
      storage,
      () => false,
      { decode: async () => decoded.shift()! },
    );

    expect(mat.map!.channel).toBe(2);
    expect(mat.normalMap!.channel).toBe(1);
  });

  it('a slot the material does not name binds set 0, and so does an absent bag', async () => {
    const storage = new MemoryStorage();
    const albedo = await bakedRef(storage, 'd');
    const normal = await bakedRef(storage, 'e');
    const mat = new THREE.MeshStandardMaterial();
    const decoded = [new THREE.Texture(), new THREE.Texture()];

    await applyEditedMaps(
      mat,
      maps({ albedo, normal }),
      { shared: IDENTITY, uvSets: { albedo: 1 } },
      storage,
      () => false,
      { decode: async () => decoded.shift()! },
    );
    expect(mat.map!.channel).toBe(1);
    expect(mat.normalMap!.channel).toBe(0); // named nowhere → the glTF default

    const bare = new THREE.MeshStandardMaterial();
    const loaded = new THREE.Texture();
    // A texture arriving already dirtied — the write must be unconditional, or a slot
    // whose binding was REMOVED would keep the set it used to have.
    loaded.channel = 3;
    await applyEditedMaps(bare, maps({ albedo }), { shared: IDENTITY }, storage, () => false, {
      decode: async () => loaded,
    });
    expect(bare.map!.channel).toBe(0);
  });
});

describe('#997 — the importer captures the set off a real asset', () => {
  const asset = (f: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/assets', f), 'utf8'));

  it('two-uv-quad names its base-colour slot set 1; the control names nothing', () => {
    const subj = gltfJsonMaterialToOpenpbr(asset('two-uv-quad.gltf').materials[0]);
    expect(subj.mapUvSets).toEqual({ albedo: 1 });

    const ctrl = gltfJsonMaterialToOpenpbr(asset('one-uv-quad.gltf').materials[0]);
    // ABSENT, not an empty object — a materialised bag keys differently from an absent
    // one and would re-mint every already-imported material's identity.
    expect(ctrl.mapUvSets).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(ctrl, 'mapUvSets')).toBe(false);
  });

  it('an EXPLICIT texCoord 0 captures nothing — the bag must not materialise', () => {
    // 🔴 THE CONTROL ASSET CANNOT TEST THIS AND THAT IS WHY THIS CASE IS SPELLED INLINE.
    // `one-uv-quad.gltf` OMITS `texCoord`, so a capture rule of `>= 0` and one of `> 0`
    // behave identically on it — measured: relaxing the rule to `>= 0` left the whole
    // gate green until this case existed. Set 0 must be spelled OUT to separate them.
    const spec = gltfJsonMaterialToOpenpbr({
      name: 'ExplicitZero',
      pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 0 } },
    });
    // Absent, not `{ albedo: 0 }`: `materialKeyOf` walks own enumerable keys, so a
    // materialised bag re-mints every existing material's identity on first load.
    expect(spec.mapUvSets).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(spec, 'mapUvSets')).toBe(false);
  });

  it('what the importer captures is what the overlay consumes — one road, end to end', async () => {
    const spec = gltfJsonMaterialToOpenpbr(asset('two-uv-quad.gltf').materials[0]);
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'e2e');
    const mat = new THREE.MeshStandardMaterial();
    const loaded = new THREE.Texture();

    await applyEditedMaps(
      mat,
      maps({ albedo: ref }),
      { shared: IDENTITY, uvSets: spec.mapUvSets },
      storage,
      () => false,
      { decode: async () => loaded },
    );

    expect(loaded.channel).toBe(1);
  });
});

describe('#997 — the set participates in material identity', () => {
  it('two specs differing ONLY in the UV set key differently', () => {
    // `materialKeyOf` walks generically, so this holds without anyone maintaining a
    // field list — asserted anyway, because the failure it prevents is invisible: two
    // materials that differ only here would share one cached material and one of them
    // would silently draw the other's UV set.
    const base = { color: '#fff', maps: {} };
    expect(materialKeyOf({ ...base, mapUvSets: { albedo: 1 } })).not.toBe(
      materialKeyOf({ ...base, mapUvSets: { albedo: 2 } }),
    );
    // …and an ABSENT bag keys as the pre-#997 material did, which is what keeps every
    // already-imported material's identity stable.
    expect(materialKeyOf(base)).not.toBe(materialKeyOf({ ...base, mapUvSets: { albedo: 1 } }));
  });
});
