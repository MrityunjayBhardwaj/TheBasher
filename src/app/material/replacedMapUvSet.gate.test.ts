// #997 — a material NAMES the UV set each map samples, captured at import, and that name is part
// of the material's identity.
//
// The binding lives on the MATERIAL (`mapUvLayers`) rather than on the map descriptor, because a
// replaced map's fresh ref never carries the descriptor it superseded. The clone road's overlay
// (`applyEditedMaps`) was the subject of this gate's first rows — a replaced map sampling the
// named set — and it went with the clone renderer (#1053). The native road's half is observed on
// screen by `tests/e2e/p997-replaced-map-uv-set.spec.ts`; what stays here is the capture and the
// identity, which both roads share.
//
// REF: src/core/import/gltfJsonMaterialToOpenpbr.ts (`capturePerMapUvSets`);
//      src/nodes/types.ts (`InlineMaterialSpec.mapUvLayers`); src/nodes/materialKey.ts; issue #997.
import { describe, expect, it } from 'vitest';
import { materialKeyOf } from '../../nodes/materialKey';
import { gltfJsonMaterialToOpenpbr } from '../../core/import/gltfJsonMaterialToOpenpbr';
import fs from 'node:fs';
import path from 'node:path';

describe('#997 — the importer captures the set off a real asset', () => {
  const asset = (f: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/assets', f), 'utf8'));

  it('two-uv-quad names its base-colour slot set 1; the control names nothing', () => {
    const subj = gltfJsonMaterialToOpenpbr(asset('two-uv-quad.gltf').materials[0]);
    expect(subj.mapUvLayers).toEqual({ albedo: 'UVMap.001' });

    const ctrl = gltfJsonMaterialToOpenpbr(asset('one-uv-quad.gltf').materials[0]);
    // ABSENT, not an empty object — a materialised bag keys differently from an absent
    // one and would re-mint every already-imported material's identity.
    expect(ctrl.mapUvLayers).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(ctrl, 'mapUvLayers')).toBe(false);
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
    expect(spec.mapUvLayers).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(spec, 'mapUvLayers')).toBe(false);
  });
});

describe('#997 — the set participates in material identity', () => {
  it('two specs differing ONLY in the UV set key differently', () => {
    // `materialKeyOf` walks generically, so this holds without anyone maintaining a
    // field list — asserted anyway, because the failure it prevents is invisible: two
    // materials that differ only here would share one cached material and one of them
    // would silently draw the other's UV set.
    const base = { color: '#fff', maps: {} };
    expect(materialKeyOf({ ...base, mapUvLayers: { albedo: 'UVMap.001' } })).not.toBe(
      materialKeyOf({ ...base, mapUvLayers: { albedo: 'UVMap.002' } }),
    );
    // …and an ABSENT bag keys as the pre-#997 material did, which is what keeps every
    // already-imported material's identity stable.
    expect(materialKeyOf(base)).not.toBe(
      materialKeyOf({ ...base, mapUvLayers: { albedo: 'UVMap.001' } }),
    );
  });
});
