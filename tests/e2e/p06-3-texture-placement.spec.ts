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
// FALSIFICATION (run once, then revert — see the wave log):
//   drop `c.repeat.set(...)` in usePrimitiveMaterial (apply identity always) →
//   SC-1's mapRepeat === [2,2] goes RED.

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
interface BasherWindow {
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_mesh_material?: (nodeId: string) => MeshMaterial | null;
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
