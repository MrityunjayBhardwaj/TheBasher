// #1152 — a glTF mesh that also holds children imports native, and draws where Blender puts it.
//
// `public/assets/mesh-parent.gltf` (scripts/gen-mesh-parent-fixture.mjs): Body is a mesh turned
// 90° about Y and scaled 2, holding Lamp (a mesh) and Socket (an empty holding Bulb, a mesh). Until
// an Object could parent, the native road refused the whole file by name. Blender 5.1.1's own glTF
// importer, headless, puts them at (glTF axes):
//
//   Body (0, 1, 0) scale 2 · Lamp (0, 2, -2) scale 0.5 · Bulb (0, 2, 2) scale 0.4
//
// Read off the LIVE drawn meshes — what three draws, not what the graph says — then after a save
// and a reload. The click on the Lamp selects the Lamp, and Alt+click walks up through Body to the
// import root, as the Blender outliner's parent chain would.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; meta?: { name?: string } }>;
      };
      dispatch: (op: unknown, source?: string, label?: string) => void;
    };
  };
  __basher_selection: { getState: () => { selectedNodeId: string | null } };
  __basher_three: {
    getState: () => { camera: import('three').Camera; scene: import('three').Scene };
  };
  __basher_ingestGltfFolder: (
    files: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
    folderName: string,
  ) => Promise<string>;
  __basher_opfs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<Uint8Array>;
  };
}

const BLENDER: Record<string, { at: [number, number, number]; scale: number }> = {
  Body: { at: [0, 1, 0], scale: 2 },
  Lamp: { at: [0, 2, -2], scale: 0.5 },
  Bulb: { at: [0, 2, 2], scale: 0.4 },
};

async function openStarter(page: Page): Promise<void> {
  // Once per session: the reload below must reopen the saved project, not the home view.
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('p1152-fresh')) return;
      sessionStorage.setItem('p1152-fresh', '1');
      localStorage.removeItem('basher.lastProjectId');
    } catch {
      /* storage disabled */
    }
  });
  await page.goto('/');
  await page.getByTestId('home-open-example_starter').click();
  await expect(page.getByTestId('layout')).toBeVisible();
  await expect(page.getByTestId('viewport').locator('canvas')).toHaveCount(1);
}

/** The node the file named `name` (its outliner name), by type: an Object or a Group. */
const idNamed = (page: Page, name: string) =>
  page.evaluate((n) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return (
      Object.values(nodes).find(
        (x) => x.meta?.name === n && (x.type === 'Object' || x.type === 'Group'),
      )?.id ?? null
    );
  }, name);

/** Where three draws the mesh a node drew, found by the node id its drawn group carries. */
const drawn = (page: Page, id: string) =>
  page.evaluate((nid) => {
    const scene = (window as unknown as Partial<W>).__basher_three?.getState().scene;
    if (!scene) return null; // not mounted yet — the caller polls
    const found: Array<{ at: number[]; scale: number } | null> = [null];
    scene.traverse((o) => {
      if (found[0] || !(o as import('three').Mesh).isMesh) return;
      // The NEAREST stamped ancestor must be this node: a mesh drawn by a child of it is not it.
      for (let p: import('three').Object3D | null = o; p; p = p.parent) {
        const stamp = p.userData?.basherNodeId;
        if (!stamp) continue;
        if (stamp !== nid) return;
        o.updateWorldMatrix(true, false);
        const e = o.matrixWorld.elements;
        found[0] = { at: [e[12], e[13], e[14]], scale: Math.hypot(e[0], e[1], e[2]) };
        return;
      }
    });
    return found[0] as { at: number[]; scale: number } | null;
  }, id);

async function expectWhereBlenderPutsThem(page: Page): Promise<void> {
  for (const [name, want] of Object.entries(BLENDER)) {
    const id = await idNamed(page, name);
    expect(id, `${name} imported`).not.toBeNull();
    await expect
      .poll(() => drawn(page, id!).then((d) => d !== null), { timeout: 20_000 })
      .toBe(true);
    const got = (await drawn(page, id!))!;
    got.at.forEach((v, i) => expect(v, `${name} axis ${i}`).toBeCloseTo(want.at[i], 3));
    expect(got.scale, `${name} scale`).toBeCloseTo(want.scale, 3);
  }
}

test('#1152 — a mesh that holds children imports native, drawn where Blender puts it', async ({
  page,
}) => {
  test.slow(); // an ingest, a save, a reload, each observed
  await openStarter(page);
  // Clear the ground the model stands on: the starter boxes aside, the camera and light (whose
  // helpers span the origin and would take the click) removed.
  await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const d = (op: unknown) => dag.dispatch(op, 'user', 'clear');
    for (const b of ['n_box', 'n_box_2'])
      d({ type: 'setParam', nodeId: b, paramPath: 'position', value: [20, 0, 0] });
    for (const [n, s] of [
      ['n_camera', 'camera'],
      ['n_light', 'lights'],
    ]) {
      d({
        type: 'disconnect',
        from: { node: n, socket: 'out' },
        to: { node: 'n_scene', socket: s },
      });
      d({ type: 'removeNode', nodeId: n });
    }
  });
  await page.evaluate(async () => {
    const w = window as unknown as W;
    const bytes = new Uint8Array(
      await fetch('/assets/mesh-parent.gltf').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'mesh-parent.gltf', bytes }], 'p1152');
  });

  // Native: the mesh that holds children is an Object, and nothing reads the file as a clone.
  await expect.poll(() => idNamed(page, 'Body'), { timeout: 20_000 }).not.toBeNull();
  const types = await page.evaluate(() =>
    Object.values((window as unknown as W).__basher_dag.getState().state.nodes).map((n) => n.type),
  );
  expect(types.filter((t) => t === 'GltfAsset' || t === 'GltfData')).toEqual([]);
  const bodyId = (await idNamed(page, 'Body'))!;
  expect(
    await page.evaluate(
      (id) => (window as unknown as W).__basher_dag.getState().state.nodes[id].type,
      bodyId,
    ),
  ).toBe('Object');

  await expectWhereBlenderPutsThem(page);

  // The click chain: the Lamp under the cursor, then up through the Body to the import root.
  const lampId = (await idNamed(page, 'Lamp'))!;
  const pt = await page.evaluate((id) => {
    const { camera, scene } = (window as unknown as W).__basher_three.getState();
    let mesh: import('three').Object3D | undefined;
    scene.traverse((o) => {
      if (!mesh && (o as import('three').Mesh).isMesh && o.parent?.userData?.basherNodeId === id)
        mesh = o;
    });
    if (!mesh) return null;
    const v = mesh.getWorldPosition(
      new (camera.position.constructor as new () => import('three').Vector3)(),
    );
    camera.updateMatrixWorld();
    v.project(camera);
    const r = document.querySelector('[data-testid="viewport"] canvas')!.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }, lampId);
  expect(pt).not.toBeNull();
  const selected = () =>
    page.evaluate(() => (window as unknown as W).__basher_selection.getState().selectedNodeId);
  await page.mouse.click(pt!.x, pt!.y);
  await expect.poll(selected).toBe(lampId);
  await page.keyboard.down('Alt');
  await page.mouse.click(pt!.x, pt!.y);
  await page.keyboard.up('Alt');
  await expect.poll(selected).toBe(bodyId);

  // Save, reload: the parenting is in the project, not only in this session.
  const projectId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  expect(projectId).not.toBeNull();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(
      () =>
        page.evaluate(async (path) => {
          const w = window as unknown as W;
          if (!(await w.__basher_opfs.exists(path))) return false;
          return new TextDecoder().decode(await w.__basher_opfs.read(path)).includes('"Lamp"');
        }, `projects/${projectId}/project.json`),
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await expectWhereBlenderPutsThem(page);
});
