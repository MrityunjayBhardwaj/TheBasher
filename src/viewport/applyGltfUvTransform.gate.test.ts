// #550 RENDER SLICE — the gate for the glTF OVERLAY road.
//
// The other road (authored: compile → spec → `materialRegistry.build`) is gated in
// `src/app/material/perMapUvRender.gate.test.ts`. This one covers the road that
// paints a DAG material's placement back onto an imported child's inherited
// textures, and it exists as its own file for one reason: the two roads pivot
// DIFFERENTLY, and that divergence is the thing most likely to be "tidied" into
// agreement by someone who has not read #551.
//
//   authored road → `.center = [0.5, 0.5]`  (our authoring convention)
//   glTF road     → `.center = [0, 0]`      (KHR_texture_transform, and what
//                                            three's GLTFLoader itself writes)
//
// Both are RIGHT for their road. The pivot travels with the ROAD, not with the
// VALUE — so a placement captured from a glTF and later applied through the
// authored road would render differently from the import. Not reachable today
// (nothing wires an imported IR into the authored road); that is #551, and it is
// why `perMapUvCapture.gate.test.ts` case 6 censuses every module that names the
// field and makes it declare which road it is on.
//
// ── WHY `applyGltfUvTransform` NOW LIVES IN ITS OWN MODULE ─────────────────────
//
// It was a private function inside `SceneFromDAG.tsx`, which made it observable
// only through a 34-minute browser suite. The per-slot resolution is exactly the
// kind of rule that is invisible in review and cheap to assert directly, so the
// function moved out to be gated here. The call site is unchanged.
//
// ── THE SKIP RULE, which is the subtle half ───────────────────────────────────
//
// A slot whose RESOLVED placement is identity is left ALONE — not written with
// identity. That is load-bearing: the imported clone's own texture already carries
// whatever KHR_texture_transform the loader applied, and overwriting it with
// identity would flatten a correct import. Before #550 this was a single
// material-level early return on the shared value; it is now per slot, which is
// what lets a listed slot be re-applied while its neighbours keep the loader's.
//
// REF: src/viewport/applyGltfUvTransform.ts, src/viewport/SceneFromDAG.tsx (the
//      call site), src/app/material/uvPlacement.ts (`placeTexture` — the resolve +
//      write shared by both roads), node_modules/three/examples/jsm/loaders/
//      GLTFLoader.js (`extendTexture` — never sets `center`); issues #550, #551, #181.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { UvPlacement } from '../nodes/types';
import type { ThreeMaterialMaps } from '../app/material/openpbrToThree';
import { applyGltfUvTransform, GLTF_UV_MAP_SLOTS } from './applyGltfUvTransform';

const IDENTITY: UvPlacement = { tiling: [1, 1], offset: [0, 0], rotation: 0 };
const SHARED: UvPlacement = { tiling: [3, 1], offset: [0.5, 0.25], rotation: 0.75 };
const placement = (n: number): UvPlacement => ({
  tiling: [n, n * 2],
  offset: [n / 10, n / 20],
  rotation: n / 100,
});

/**
 * A stand-in for an imported child's material: every slot filled, and every texture
 * carrying a DISTINCT pre-existing placement — that is what the loader leaves behind,
 * and it is what a skipped slot must still be carrying afterwards.
 */
function importedMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial();
  GLTF_UV_MAP_SLOTS.forEach((slot, i) => {
    const t = new THREE.Texture();
    t.repeat.set(100 + i, 200 + i);
    t.offset.set(0.01 * i, 0.02 * i);
    t.rotation = 0.001 * i;
    (m as unknown as Record<string, THREE.Texture>)[slot] = t;
  });
  return m;
}

const slotTex = (m: THREE.Material, slot: keyof ThreeMaterialMaps): THREE.Texture => {
  const t = (m as unknown as Record<string, THREE.Texture | null>)[slot];
  if (!t) throw new Error(`slot ${slot} empty — the assertion would be vacuous`);
  return t;
};

const drawn = (m: THREE.Material, slot: keyof ThreeMaterialMaps) => {
  const t = slotTex(m, slot);
  return {
    tiling: [t.repeat.x, t.repeat.y],
    offset: [t.offset.x, t.offset.y],
    rotation: t.rotation,
    center: [t.center.x, t.center.y],
  };
};

const asDrawn = (p: UvPlacement) => ({
  tiling: [p.tiling[0], p.tiling[1]],
  offset: [p.offset[0], p.offset[1]],
  rotation: p.rotation,
  center: [0, 0], // the glTF road pivots about the UV ORIGIN — #551
});

describe('#550 glTF road case 1 — a listed slot uses its own placement, its neighbours the shared one', () => {
  it.each(GLTF_UV_MAP_SLOTS)('slot %s', (slot) => {
    const foil =
      GLTF_UV_MAP_SLOTS[(GLTF_UV_MAP_SLOTS.indexOf(slot) + 1) % GLTF_UV_MAP_SLOTS.length];
    const own = placement(2);
    const m = importedMaterial();

    applyGltfUvTransform(m, SHARED, { [slot]: own });

    expect(drawn(m, slot), `own slot ${slot}`).toEqual(asDrawn(own));
    expect(drawn(m, foil), `foil slot ${foil}`).toEqual(asDrawn(SHARED));
  });

  it('two listed slots keep their OWN values (not the last one wins)', () => {
    const m = importedMaterial();
    applyGltfUvTransform(m, SHARED, { map: placement(2), emissiveMap: placement(7) });
    expect(drawn(m, 'map')).toEqual(asDrawn(placement(2)));
    expect(drawn(m, 'emissiveMap')).toEqual(asDrawn(placement(7)));
    expect(drawn(m, 'normalMap')).toEqual(asDrawn(SHARED));
  });
});

describe('#550 glTF road case 2 — REPLACEMENT, never composition (V154)', () => {
  it('the listed slot ignores the shared placement entirely', () => {
    const own: UvPlacement = { tiling: [2, 2], offset: [0.1, 0.2], rotation: 0.5 };
    const m = importedMaterial();
    applyGltfUvTransform(m, SHARED, { map: own });
    const got = drawn(m, 'map');
    expect(got.tiling).toEqual([2, 2]); // NOT [6,2] (product), NOT [5,3] (sum)
    expect(got.offset).toEqual([0.1, 0.2]);
    expect(got.rotation).toBe(0.5);
  });
});

describe('#550 glTF road case 3 — the SKIP rule: identity leaves the loader’s own transform alone', () => {
  it('no per-map bag + identity shared → every texture is UNTOUCHED (the pre-#550 behaviour)', () => {
    const m = importedMaterial();
    const before = GLTF_UV_MAP_SLOTS.map((s) => slotTex(m, s));
    applyGltfUvTransform(m, IDENTITY, undefined);
    GLTF_UV_MAP_SLOTS.forEach((s, i) => {
      expect(slotTex(m, s), `slot ${s} must be the very same texture`).toBe(before[i]);
      expect(drawn(m, s).tiling, `slot ${s} keeps the loader's placement`).toEqual([
        100 + i,
        200 + i,
      ]);
    });
  });

  it('identity shared + ONE listed slot → that slot is written, the rest keep the loader’s', () => {
    const m = importedMaterial();
    const before = GLTF_UV_MAP_SLOTS.map((s) => slotTex(m, s));
    applyGltfUvTransform(m, IDENTITY, { normalMap: placement(4) });

    expect(drawn(m, 'normalMap')).toEqual(asDrawn(placement(4)));
    GLTF_UV_MAP_SLOTS.filter((s) => s !== 'normalMap').forEach((s) => {
      const i = GLTF_UV_MAP_SLOTS.indexOf(s);
      expect(slotTex(m, s), `slot ${s} must be untouched`).toBe(before[i]);
      expect(drawn(m, s).tiling).toEqual([100 + i, 200 + i]);
    });
  });

  it('an explicitly-identity listed slot is a REPLACEMENT and DOES flatten a non-identity shared', () => {
    // The one place the skip rule and the replacement rule could contradict each
    // other. Resolution: the skip is decided on the RESOLVED value, so a listed
    // identity beats a non-identity shared and the slot ends up unplaced — which
    // is what "this map carries no transform of its own" has to mean.
    const m = importedMaterial();
    applyGltfUvTransform(m, SHARED, { map: IDENTITY });
    expect(drawn(m, 'map').tiling).toEqual([100, 200]); // the loader's own, kept
    expect(drawn(m, 'normalMap')).toEqual(asDrawn(SHARED));
  });
});

describe('#550 glTF road case 4 — the invariants the overlay already owed', () => {
  it('textures are CLONED before mutation (they are shared by hash — A-5)', () => {
    const m = importedMaterial();
    const original = slotTex(m, 'map');
    applyGltfUvTransform(m, SHARED, undefined);
    expect(slotTex(m, 'map')).not.toBe(original);
    expect(original.repeat.x, 'the shared original must not have been mutated').toBe(100);
  });

  it('the pivot is the UV ORIGIN on this road, on every slot (#551)', () => {
    const m = importedMaterial();
    applyGltfUvTransform(m, SHARED, { map: placement(2) });
    for (const slot of GLTF_UV_MAP_SLOTS) {
      expect(drawn(m, slot).center, `slot ${slot}`).toEqual([0, 0]);
    }
  });

  it('a material with no map slots at all is a no-op, not a throw', () => {
    const bare = new THREE.MeshBasicMaterial();
    expect(() => applyGltfUvTransform(bare, SHARED, { map: placement(2) })).not.toThrow();
  });
});
