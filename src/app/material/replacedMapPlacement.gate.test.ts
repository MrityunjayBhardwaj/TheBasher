// #553 — A REPLACED MAP MUST DRAW WITH ITS SLOT'S UV PLACEMENT.
//
// ── THE DEFECT THIS GATES ──────────────────────────────────────────────────────
//
// Replacing an imported glTF child's texture from the inspector's Maps row drew the
// new texture UNPLACED — `repeat [1,1]`, no offset, no rotation — while the panel
// went on reporting the placement the director had set. Measured in a browser on a
// per-map import AND on a uniform one, so it is a property of the REPLACED-MAP road
// and predates the per-map work (#550) entirely.
//
// The cause is an ordering the two passes cannot see between them. `SceneFromDAG`
// paints the placement synchronously onto the overlay material's INHERITED textures
// (`applyGltfUvTransform`). The edit-layer map pass is deferred — it decodes from
// OPFS and lands on the FINAL material afterwards — and `applyEditedMaps` took no
// placement argument at all. So the placement was painted onto a texture that was
// then thrown away, and the replacement arrived carrying nothing.
//
// ── WHY THE ARGUMENT IS REQUIRED RATHER THAN OPTIONAL ──────────────────────────
//
// The whole defect is a caller that did not pass a placement, in a function whose
// signature let it not to. An optional parameter with a sensible default reproduces
// that exactly: the one road that forgets is the road that renders wrong, silently,
// with the panel still reading correctly. Required makes the omission a type error
// rather than a rendering bug — the same rung the import notice's removal used.
//
// ── WHY THIS ROAD DOES NOT CLONE, AND DOES NOT SKIP IDENTITY ───────────────────
//
// Both are true of the INHERITED road and neither transfers, which is worth stating
// because copying them would look like consistency:
//
//   · No clone. `loadBakedTexture` decodes a FRESH `THREE.Texture` per call (it
//     builds a blob URL and runs a TextureLoader; nothing between it and this
//     function caches). The texture has exactly one consumer, so writing to it
//     cannot cross-contaminate. The inherited road clones because ITS textures come
//     off the shared imported clone.
//   · No skip rule. `applyGltfUvTransform` leaves an identity-resolving slot ALONE
//     so it does not flatten whatever transform the loader applied to an inherited
//     texture. A freshly decoded texture has no loader transform to preserve — it is
//     identity already — so there is nothing to protect and the write is
//     unconditional.
//
// ── THE PIVOT ──────────────────────────────────────────────────────────────────
//
// The UV ORIGIN. This is the glTF road, and the pivot travels with the road, not
// with the value (#551). Case 4 asserts it rather than letting it be inherited from
// whichever constant was nearest.
//
// REF: src/app/material/gltfMapOverlay.ts (`applyEditedMaps` — the subject),
//      src/app/material/uvPlacement.ts (`resolveSlotPlacement` + `placeTexture` —
//      the one writer both roads share; NOT respelled here),
//      src/app/material/openpbrToThree.ts (`THREE_SLOT_OF` — the one slot-name
//      correspondence, whose header names this module as the copy to fold in),
//      src/viewport/SceneFromDAG.tsx (the two passes and their order);
//      issues #553, #550, #551, #178.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../../test-utils/sourceScan';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { persistTexture } from '../asset/bakedTextureStore';
import { MATERIAL_MAP_SLOTS, type MaterialMapSlot } from './attachMapFromFile';
import { NULL_MAPS } from '../../nodes/materialSchema';
import type { BakedTextureRef, InlineMaterialMaps, UvPlacement } from '../../nodes/types';
import { THREE_SLOT_OF } from './openpbrToThree';
import { CLEARED_MAP, applyEditedMaps } from './gltfMapOverlay';
import { ORIGIN_PIVOT } from './uvPlacement';

const IDENTITY: UvPlacement = { tiling: [1, 1], offset: [0, 0], rotation: 0 };

/** A placement no default could produce by accident — every component distinct. */
const SHARED: UvPlacement = { tiling: [2, 3], offset: [0.1, 0.2], rotation: 0.5 };
/** A per-slot placement that shares NO component with {@link SHARED}. */
const OWN: UvPlacement = { tiling: [4, 5], offset: [0.6, 0.7], rotation: 0.8 };

function maps(over: Partial<InlineMaterialMaps>): InlineMaterialMaps {
  return { ...NULL_MAPS, ...over };
}

/** Bake a stand-in texture so `loadBakedTexture` has bytes to read back. */
async function bakedRef(storage: MemoryStorage, name: string): Promise<BakedTextureRef> {
  await storage.write(`user-imports/x/${name}.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]));
  return persistTexture(storage, new THREE.Texture(), {
    resolveSourcePath: () => `user-imports/x/${name}.png`,
  });
}

/** The four numbers a placement puts on a texture, read back off the object. */
function drawn(t: THREE.Texture) {
  return {
    repeat: [t.repeat.x, t.repeat.y],
    offset: [t.offset.x, t.offset.y],
    rotation: t.rotation,
    center: [t.center.x, t.center.y],
  };
}

describe('#553 case 1 — a replaced map draws with the SHARED placement when the slot has none', () => {
  it('the freshly loaded texture carries the material placement, not identity', async () => {
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'a');
    const mat = new THREE.MeshStandardMaterial();
    mat.map = new THREE.Texture();
    const loaded = new THREE.Texture();

    const changed = await applyEditedMaps(
      mat,
      maps({ albedo: ref }),
      { shared: SHARED, perMap: undefined },
      storage,
      () => false,
      { decode: async () => loaded },
    );

    expect(changed).toBe(true);
    expect(mat.map).toBe(loaded);
    // The defect drew [1,1]/[0,0]/0 here — a fresh texture's untouched defaults.
    expect(drawn(loaded).repeat).toEqual([2, 3]);
    expect(drawn(loaded).offset).toEqual([0.1, 0.2]);
    expect(drawn(loaded).rotation).toBe(0.5);
  });

  it('an IDENTITY shared placement leaves the fresh texture identity (no skip rule needed)', async () => {
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'b');
    const mat = new THREE.MeshStandardMaterial();
    const loaded = new THREE.Texture();

    await applyEditedMaps(mat, maps({ albedo: ref }), { shared: IDENTITY }, storage, () => false, {
      decode: async () => loaded,
    });

    expect(drawn(loaded).repeat).toEqual([1, 1]);
    expect(drawn(loaded).offset).toEqual([0, 0]);
    expect(drawn(loaded).rotation).toBe(0);
  });
});

describe('#553 case 2 — the slot’s OWN placement wins over the shared one', () => {
  it('a per-map entry REPLACES the shared placement on the replaced texture', async () => {
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'c');
    const mat = new THREE.MeshStandardMaterial();
    const loaded = new THREE.Texture();

    await applyEditedMaps(
      mat,
      maps({ albedo: ref }),
      { shared: SHARED, perMap: { albedo: OWN } },
      storage,
      () => false,
      { decode: async () => loaded },
    );

    expect(drawn(loaded).repeat).toEqual([4, 5]);
    expect(drawn(loaded).offset).toEqual([0.6, 0.7]);
    expect(drawn(loaded).rotation).toBe(0.8);
  });

  it('a per-map entry for a DIFFERENT slot does not reach this one', async () => {
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'd');
    const mat = new THREE.MeshStandardMaterial();
    const loaded = new THREE.Texture();

    await applyEditedMaps(
      mat,
      maps({ albedo: ref }),
      { shared: SHARED, perMap: { normal: OWN } },
      storage,
      () => false,
      { decode: async () => loaded },
    );

    expect(drawn(loaded).repeat).toEqual([2, 3]); // the shared one, not normal's
  });
});

describe('#553 case 3 — REPLACEMENT, arithmetically (never a composition of the two)', () => {
  it('the drawn tiling is the per-map value, not the product or the sum', async () => {
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'e');
    const mat = new THREE.MeshStandardMaterial();
    const loaded = new THREE.Texture();

    await applyEditedMaps(
      mat,
      maps({ albedo: ref }),
      {
        shared: { tiling: [2, 2], offset: [0, 0], rotation: 0 },
        perMap: { albedo: { tiling: [3, 1], offset: [0, 0], rotation: 0 } },
      },
      storage,
      () => false,
      { decode: async () => loaded },
    );

    expect(drawn(loaded).repeat).toEqual([3, 1]);
    expect(drawn(loaded).repeat).not.toEqual([6, 2]); // the product
    expect(drawn(loaded).repeat).not.toEqual([5, 3]); // the sum
  });

  it('an IDENTITY per-map entry replaces a NON-identity shared placement', async () => {
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'f');
    const mat = new THREE.MeshStandardMaterial();
    const loaded = new THREE.Texture();

    await applyEditedMaps(
      mat,
      maps({ albedo: ref }),
      { shared: SHARED, perMap: { albedo: IDENTITY } },
      storage,
      () => false,
      { decode: async () => loaded },
    );

    // Resolution happens BEFORE any identity question — the slot said identity.
    expect(drawn(loaded).repeat).toEqual([1, 1]);
    expect(drawn(loaded).rotation).toBe(0);
  });
});

describe('#553 case 4 — the pivot is the UV ORIGIN on this road (#551)', () => {
  it('center is [0,0], not the authored road’s texture centre', async () => {
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'g');
    const mat = new THREE.MeshStandardMaterial();
    const loaded = new THREE.Texture();

    await applyEditedMaps(mat, maps({ albedo: ref }), { shared: SHARED }, storage, () => false, {
      decode: async () => loaded,
    });

    expect(drawn(loaded).center).toEqual([0, 0]);
    expect(drawn(loaded).center).not.toEqual([0.5, 0.5]);
    // …and it is the road's declared constant, not a literal that could drift.
    expect(drawn(loaded).center).toEqual([ORIGIN_PIVOT[0], ORIGIN_PIVOT[1]]);
  });
});

describe('#553 case 5 — the slot axis is ITERATED, not sampled at one slot', () => {
  // Every slot, each asserted with a SECOND slot in the same material, because a
  // cross-wiring reaches the right texture with the wrong slot's placement and a
  // single-slot check cannot see it.
  it.each(MATERIAL_MAP_SLOTS)(
    '%s gets its own placement, and its neighbour keeps the shared one',
    async (slot: MaterialMapSlot) => {
      const other = MATERIAL_MAP_SLOTS.find((s) => s !== slot)!;
      const storage = new MemoryStorage();
      const ref = await bakedRef(storage, `s-${slot}`);
      const mat = new THREE.MeshStandardMaterial();

      await applyEditedMaps(
        mat,
        maps({ [slot]: ref, [other]: ref } as Partial<InlineMaterialMaps>),
        { shared: SHARED, perMap: { [slot]: OWN } },
        storage,
        () => false,
        // A DISTINCT texture per call, so the two slots cannot be confused for one
        // object; which is which is then read off WHERE each landed, never off the
        // order the loader happened to visit them in.
        { decode: async () => new THREE.Texture() },
      );

      const std = mat as unknown as Record<string, THREE.Texture | null>;
      const placed = std[THREE_SLOT_OF[slot]]!;
      const neighbour = std[THREE_SLOT_OF[other]]!;
      expect(placed).not.toBe(neighbour);
      expect(drawn(placed).repeat).toEqual([4, 5]); // its own
      expect(drawn(neighbour).repeat).toEqual([2, 3]); // the shared one
    },
  );
});

describe('#553 case 6 — the behaviour that must NOT change', () => {
  it('a null slot still inherits — the imported texture is untouched, placement and all', async () => {
    const mat = new THREE.MeshStandardMaterial();
    const imported = new THREE.Texture();
    imported.repeat.set(7, 7); // whatever applyGltfUvTransform painted
    mat.map = imported;

    const changed = await applyEditedMaps(
      mat,
      maps({}),
      { shared: SHARED },
      new MemoryStorage(),
      () => false,
    );

    expect(changed).toBe(false);
    expect(mat.map).toBe(imported);
    expect(drawn(imported).repeat).toEqual([7, 7]); // NOT re-painted by this pass
  });

  it('a cleared slot still removes the texture, and places nothing', async () => {
    const mat = new THREE.MeshStandardMaterial();
    mat.map = new THREE.Texture();
    const changed = await applyEditedMaps(
      mat,
      maps({ albedo: CLEARED_MAP }),
      { shared: SHARED },
      new MemoryStorage(),
      () => false,
    );
    expect(changed).toBe(true);
    expect(mat.map).toBeNull();
  });

  it('a cancelled load lands nothing — no placed texture leaks onto the material', async () => {
    const storage = new MemoryStorage();
    const ref = await bakedRef(storage, 'h');
    const mat = new THREE.MeshStandardMaterial();
    const imported = new THREE.Texture();
    mat.map = imported;

    const changed = await applyEditedMaps(
      mat,
      maps({ albedo: ref }),
      { shared: SHARED },
      storage,
      () => true,
      { decode: async () => new THREE.Texture() },
    );

    expect(changed).toBe(false);
    expect(mat.map).toBe(imported);
  });
});

describe('#553 case 7 — the slot vocabulary comes from the ONE table, not a local copy', () => {
  // `openpbrToThree.THREE_SLOT_OF`'s own header names this module as the copy to
  // fold in. Pinned BOTH ways so neither list can grow a slot the other lacks.
  it('every IR slot the overlay applies is in the shared correspondence, and vice versa', () => {
    expect([...MATERIAL_MAP_SLOTS].sort()).toEqual(Object.keys(THREE_SLOT_OF).sort());
  });

  it('the overlay module declares no slot-name table of its own', () => {
    // Comments are stripped first: this module's header legitimately DISCUSSES the
    // three.js slot names, and a census that counts prose reds on documentation.
    const code = stripComments(readFileSync(join(__dirname, 'gltfMapOverlay.ts'), 'utf8'));
    // A local correspondence table has to spell EVERY slot's three.js name. The
    // five that have no other reason to appear are therefore the discriminating
    // ones — `'map'` is excluded here because it doubles as the material-capability
    // guard (`'map' in material`), and censusing it would red on a type check.
    for (const three of Object.values(THREE_SLOT_OF)) {
      if (three === 'map') continue;
      expect(code).not.toContain(`'${three}'`);
    }
    // …and `'map'` appears EXACTLY once, as that guard — so the exemption above
    // cannot quietly cover a re-introduced table that happens to start with albedo.
    expect(code.split(`'map'`).length - 1).toBe(1);
    expect(code).toContain(`'map' in`);
  });

  it('CONTROL — the census can see such a table when there IS one', () => {
    // The same scan over the module that legitimately owns the correspondence, so
    // an empty result above means "folded in", never "the scan reads nothing".
    const code = stripComments(readFileSync(join(__dirname, 'openpbrToThree.ts'), 'utf8'));
    for (const three of Object.values(THREE_SLOT_OF)) {
      expect(code).toContain(`'${three}'`);
    }
  });
});
