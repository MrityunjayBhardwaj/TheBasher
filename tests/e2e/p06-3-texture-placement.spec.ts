// v0.6 #3 (#181, W2) — texture PLACEMENT.
//
// THE FEATURE: ONE shared uvTransform {tiling,offset,rotation} on the material IR
// drives three.js Texture.repeat/.offset/.rotation (about .center=[.5,.5]) on the
// loaded map. Per-material CLONE so two materials sharing an image hash don't
// cross-contaminate (A-5).
//
// THE PROOF (Lokayata, H40 — side A is the REAL three.js Texture via
// __basher_mesh_material): editing the NPanel placement controls changes the live
// mesh.material.map.repeat/.offset/.rotation.
//
// FALSIFICATION — three probes, each MEASURED on the tree that carries this note,
// and each aimed at a different one of the three claims below (run one, revert it):
//   · neutralise the placement — hand `placeTexture` an identity in
//     `materialRegistry.build`'s `prep` → BOTH cases red. This replaces the note
//     that stood here until #554, which said to drop `c.repeat.set(...)` in
//     `usePrimitiveMaterial`: that line has not existed since the placement moved
//     into the registry, so the instruction pointed at nothing and a reader
//     following it would have concluded the gate could not be falsified.
//   · drop the `.clone()` in that same `prep` → A-5's premise reds on the texture
//     identity, which is the clone itself.
//   · end the sharing — return a fresh decode per consumer from
//     `resolveBakedTexture` → A-5's premise reds on the source identity.
//
// ── THE PREMISE UNDER A-5, ADDED BY #554 ───────────────────────────────────────
//
// A-5 was written as the browser cover for the per-material texture clone, and it
// is: dropping the `.clone()` in `materialRegistry.build`'s `prep` reds it. But it
// asserted the CONSEQUENCE (independent placements) while only claiming the
// premise in a comment — "same hash → the SAME cached Texture instance" — and a
// premise nobody measures is a premise that can lapse. Measured: making the hash
// cache hand each consumer its own copy leaves this whole file green, because two
// boxes that never shared anything have independent placements trivially. The
// clone would then be guarding nothing and this file would have gone on certifying
// it. So A-5 now reads the premise off the live materials first.
//
// WHAT THE BROWSER CAN AND CANNOT SEE HERE, since it decided the assertion:
// `Texture.clone()` carries the SOURCE over by reference, so "same source" cannot
// tell one shared decode from two clones of it — but it does tell one decode from
// two INDEPENDENT decodes, which is the way the cache realistically lapses (drop
// the cache, decode per consumer). The instance-level half of the premise — the
// cache handing ONE object to two consumers — is not visible from a material that
// only ever holds a clone of it, so it is gated where it IS visible, at the cache:
// `src/app/asset/bakedTextureLoader.test.ts`. Two tiers, one premise, neither
// redundant.
//
// REF: src/app/materialRegistry.ts (`build`'s `prep`); issues #554, #535, #181.

import { expect, test } from './_fixtures';

interface MeshMaterial {
  hasMap: boolean;
  mapImageOk: boolean;
  mapRepeat: [number, number] | null;
  mapOffset: [number, number] | null;
  mapRotation: number | null;
  mapCenter: [number, number] | null;
}
interface Op {
  type: string;
  [k: string]: unknown;
}
/** Who is holding what, for the premise read — identities only, no values. */
interface MapIdentity {
  /** The material instance. Two boxes with different colours are two materials. */
  mat: string;
  /** The Texture the material holds — a per-material CLONE when the rule holds. */
  tex: string;
  /** The decoded image container: one per DECODE, shared by every clone of it. */
  src: string;
  imageOk: boolean;
}
interface SceneLike {
  getObjectByName: (n: string) => unknown;
}
interface BasherWindow {
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_mesh_material?: (nodeId: string) => MeshMaterial | null;
  __basher_three?: { getState: () => { scene: SceneLike | null } };
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { params: Record<string, unknown> }>;
        outputs: { scene?: { node: string } };
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
}

// #365 Slice 2: the default cube is a split Object (n_box) → BoxData (n_box_data)
// that owns the material. Selecting the Object makes the inspector reach through
// `data`, so the material editor, map row and uvTransform controls are keyed to the
// DATA node; the rendered mesh (the side-A __basher_mesh_material read) stays on the
// Object n_box. This is NOT the #378 UV-EDITOR gap — the inspector's placement
// controls drive material.uvTransform, which the renderer reads directly.
async function selectBoxAndAttachMap(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_selection) && typeof w.__basher_mesh_material === 'function';
  });
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
  });
  const editor = page.getByTestId('inspector-material-editor-n_box_data');
  if (!(await editor.isVisible())) {
    await page.getByTestId('inspector-section-toggle-material').click();
  }
  await expect(editor).toBeVisible();
  await page
    .getByTestId('inspector-map-file-n_box_data-albedo')
    .setInputFiles('public/fixtures/multifile/flat/texture.png');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    const m = w.__basher_mesh_material!('n_box');
    return m != null && m.hasMap && m.mapImageOk;
  });
}

/**
 * Who a node's rendered material and map ARE — read off the live scene, never the store.
 *
 * The mesh lookup mirrors `__basher_mesh_material` (the first mesh under the group named
 * by the node id). It is read here rather than added to that probe on purpose: texture
 * IDENTITY is a question only a test about sharing asks, and the app has no use for it.
 */
async function mapIdentity(
  page: import('@playwright/test').Page,
  nodeId: string,
): Promise<MapIdentity | null> {
  return page.evaluate((id) => {
    interface MeshLike {
      isMesh?: boolean;
      material?: {
        uuid: string;
        map?: { uuid: string; source?: { uuid: string }; image?: { width?: number } } | null;
      };
    }
    const w = window as unknown as {
      __basher_three?: {
        getState: () => { scene: { getObjectByName: (n: string) => unknown } | null };
      };
    };
    const grp = w.__basher_three?.getState().scene?.getObjectByName(id) as
      | { traverse: (f: (o: unknown) => void) => void }
      | undefined;
    if (!grp) return null;
    let target: MeshLike | null = null;
    grp.traverse((o) => {
      const m = o as MeshLike;
      if (!target && m.isMesh) target = m;
    });
    const mesh = target as MeshLike | null;
    const map = mesh?.material?.map;
    if (!mesh?.material || !map) return null;
    return {
      mat: mesh.material.uuid,
      tex: map.uuid,
      src: map.source?.uuid ?? '',
      imageOk: (map.image?.width ?? 0) > 0,
    };
  }, nodeId);
}

test.describe('v0.6 #3 W2 — texture placement', () => {
  test('editing tiling/offset/rotation changes the REAL mesh.material.map', async ({ page }) => {
    await selectBoxAndAttachMap(page);

    // Identity at first (byte-identical migration default).
    const before = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_mesh_material!('n_box'),
    );
    expect(before!.mapRepeat).toEqual([1, 1]);
    expect(before!.mapOffset).toEqual([0, 0]);
    expect(before!.mapCenter).toEqual([0.5, 0.5]); // rotate/scale about centre

    // SC-1 — tiling → real Texture.repeat.
    await page.getByTestId('inspector-uvtransform-tilingX-n_box_data').fill('2');
    await page.getByTestId('inspector-uvtransform-tilingY-n_box_data').fill('3');
    await page.waitForFunction(() => {
      const m = (window as unknown as BasherWindow).__basher_mesh_material!('n_box');
      return m != null && m.mapRepeat != null && m.mapRepeat[0] === 2 && m.mapRepeat[1] === 3;
    });

    // SC-2 — offset + rotation → real Texture.offset/.rotation.
    await page.getByTestId('inspector-uvtransform-offsetX-n_box_data').fill('0.25');
    await page.getByTestId('inspector-uvtransform-rotation-n_box_data').fill('0.5');
    await page.waitForFunction(() => {
      const m = (window as unknown as BasherWindow).__basher_mesh_material!('n_box');
      return (
        m != null &&
        m.mapOffset != null &&
        Math.abs(m.mapOffset[0] - 0.25) < 1e-6 &&
        m.mapRotation != null &&
        Math.abs(m.mapRotation - 0.5) < 1e-6
      );
    });
    const after = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_mesh_material!('n_box'),
    );
    console.log(`[p06-3 placement] ${JSON.stringify(after)}`);
    expect(after!.mapRepeat).toEqual([2, 3]);
    expect(after!.mapCenter).toEqual([0.5, 0.5]); // unchanged — rotate about centre
  });

  test('A-5 — two boxes sharing one image keep INDEPENDENT placement (per-material clone)', async ({
    page,
  }) => {
    await selectBoxAndAttachMap(page);

    // Add a 2nd box wired to the scene, carrying the SAME albedo ref (same hash →
    // the SAME cached Texture instance). If the transform were applied to the
    // shared instance, both boxes would collide.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      // box1's material (with the attached albedo) lives on the split cube's BoxData.
      const box1 = dag.state.nodes.n_box_data.params.material as {
        maps: { albedo: unknown };
      };
      // #365 Slice 2: the second box is a split cube too — a BoxData carrying the SAME
      // albedo ref (same hash → same cached Texture instance) and an Object pointing at
      // it. Independent placement must still hold per BoxData material (the A-5 clone).
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'n_box2_data',
            nodeType: 'BoxData',
            params: {
              size: [1, 1, 1],
              material: {
                name: 'box2',
                base: { color: '#ffffff' },
                maps: { albedo: box1.maps.albedo },
              },
            },
          },
          {
            type: 'addNode',
            nodeId: 'n_box2',
            nodeType: 'Object',
            params: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
          {
            type: 'connect',
            from: { node: 'n_box2_data', socket: 'out' },
            to: { node: 'n_box2', socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: 'n_box2', socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'user',
        'p06-3 second box (shared texture)',
      );
    });
    await page.waitForFunction(() => {
      const m = (window as unknown as BasherWindow).__basher_mesh_material!('n_box2');
      return m != null && m.hasMap && m.mapImageOk;
    });

    // ── THE PREMISE, MEASURED BEFORE ANYTHING IS PERTURBED (#554) ──────────────
    // Three identities, and each says a different thing. The boxes carry different
    // colours (#cccccc vs #ffffff), so TWO materials is by construction — asserted
    // anyway, because it is what makes "its own clone" the right expectation rather
    // than a coincidence. ONE source is the sharing this whole case is about. TWO
    // textures over that one source is the clone itself, named at the point where a
    // reader can see why the placements below are allowed to differ.
    const premiseA = await mapIdentity(page, 'n_box');
    const premiseB = await mapIdentity(page, 'n_box2');
    expect(premiseA, 'box 1 is not drawing a material with a map').not.toBeNull();
    expect(premiseB, 'box 2 is not drawing a material with a map').not.toBeNull();
    expect(premiseA!.imageOk && premiseB!.imageOk, 'a map is present but not decoded').toBe(true);
    expect(premiseB!.mat, 'the two boxes must be TWO materials').not.toBe(premiseA!.mat);
    // If this ever goes red the case below stops meaning anything: two boxes that
    // never shared a decode have independent placements for free.
    expect(premiseB!.src, 'the two boxes must draw ONE decoded image').toBe(premiseA!.src);
    // …and this is the clone the rest of the case exists to prove holds.
    expect(premiseB!.tex, 'each material must hold its OWN texture over that image').not.toBe(
      premiseA!.tex,
    );

    // Distinct tiling on each box.
    await page.getByTestId('inspector-uvtransform-tilingX-n_box_data').fill('4');
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'setParam',
            nodeId: 'n_box2_data',
            paramPath: 'material.uvTransform.tiling',
            value: [7, 7],
          },
        ],
        'user',
        'box2 tiling',
      );
    });

    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const a = w.__basher_mesh_material!('n_box');
      const b = w.__basher_mesh_material!('n_box2');
      return a?.mapRepeat?.[0] === 4 && b?.mapRepeat?.[0] === 7;
    });
    const a = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_mesh_material!('n_box'),
    );
    const b = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_mesh_material!('n_box2'),
    );
    console.log(
      `[p06-3 no-contam] box=${JSON.stringify(a!.mapRepeat)} box2=${JSON.stringify(b!.mapRepeat)}`,
    );
    // Independent → the per-material clone held (A-5). Shared mutation would make
    // them equal; box1 only had its X tiling set (→ [4,1]), box2 was set to [7,7].
    expect(a!.mapRepeat).toEqual([4, 1]);
    expect(b!.mapRepeat).toEqual([7, 7]);
  });
});
