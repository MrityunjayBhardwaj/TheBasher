// #1429 — an FBX with a skinned mesh, imported through the product's door (the single-file ingest
// that a drop and the picker share), lands as Blender's import of the same file does: the armature,
// the mesh deformed by it with all five bones on its one five-bone point, and a placed cube.
//
// The oracle: Blender 5.1.1 importing its own default export (`ref/probes/blender-armature-deform/
// q15_fbx_mesh_fixture.py` makes the file, `q16_fbx_mesh_oracle.py` records it), each vertex in
// Y-up at frames 13 and 25, keyed by where it rests.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes } from './_importedMesh';

interface SkinSeam {
  count: number;
  rest: (i: number) => [number, number, number];
  vertex: (i: number) => [number, number, number];
}
interface Node {
  type: string;
  params: Record<string, unknown>;
  meta?: { name?: string; hidden?: boolean };
  inputs: Record<string, unknown>;
}
interface BasherWindow {
  __basher_dag: { getState: () => { state: { nodes: Record<string, Node> } } };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_ingestFbxFile?: (bytes: Uint8Array, name: string) => Promise<string>;
  __basher_gltf_skin?: () => SkinSeam | null;
  __basher_opfs?: {
    read: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
  };
}

/** Blender's panel vertices by rest position `x,y`, at 0.5 s (frame 13) and 1 s (frame 25). */
const BLENDER: Record<string, Record<number, [number, number, number]>> = {
  '-1,0': { 0.5: [-1, 0, 0], 1: [-1, 0, 0] },
  '0,0': { 0.5: [0.000592, 0.000951, -0.000825], 1: [0.002347, 0.003798, -0.001363] },
  '0,1': { 0.5: [-0.014644, 0.984915, 0.095541], 1: [-0.053417, 0.941378, 0.173961] },
  '-1,1': { 0.5: [-1, 1, 0], 1: [-1, 1, 0] },
  '1,0': { 0.5: [1.001406, 0.007596, 0.059991], 1: [1.004962, 0.030154, 0.123803] },
  '1.5,0.6': { 0.5: [1.474031, 0.595543, 0.260992], 1: [1.398183, 0.582603, 0.5091] },
  '1,1.4': { 0.5: [0.914445, 1.336709, 0.423835], 1: [0.687524, 1.15616, 0.749897] },
  '0.5,1.8': { 0.5: [0.368026, 1.6782, 0.453038], 1: [0.042264, 1.335624, 0.712438] },
};
const keyOf = (r: number[]) => `${Math.round(r[0] * 10) / 10},${Math.round(r[1] * 10) / 10}`;

async function setTime(page: Page, seconds: number): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time.getState().setTime(s),
    seconds,
  );
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

test('#1429 — an FBX with a skinned mesh imports, and draws where Blender deforms it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_ingestFbxFile),
  );

  // A character already in the scene whose bones this file's rig maps onto exactly — the same
  // file, imported first. A motion dropped now would be bound onto it and its own rig hidden; a
  // file with meshes is a character itself and must not be.
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/fixtures/anim/panel-five-influences.fbx').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestFbxFile!(bytes, 'first');
  });
  const retargetsBefore = await page.evaluate(
    () =>
      Object.values((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).filter(
        (n) => n.type === 'RetargetClip',
      ).length,
  );

  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/fixtures/anim/panel-five-influences.fbx').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestFbxFile!(bytes, 'panel');
  });

  const landed = await page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    const named = (name: string) =>
      Object.entries(nodes).find(([, n]) => n.type === 'Object' && n.meta?.name === name);
    const data = (id: string) => {
      let at = (nodes[id].inputs.data as { node: string }).node;
      const stack: string[] = [];
      while (nodes[at].type !== 'PolyMeshData') {
        stack.push(nodes[at].type);
        at = (nodes[at].inputs.target as { node: string }).node;
      }
      const mesh = nodes[at].params.mesh as { faceSizes: string };
      return { stack, faceSizes: mesh.faceSizes };
    };
    const panel = named('Panel');
    const prop = named('Prop');
    const retargets = Object.values(nodes).filter((n) => n.type === 'RetargetClip').length;
    // The second import's armature Object, named after its file.
    const rig = Object.entries(nodes).find(
      ([, n]) =>
        n.type === 'Object' &&
        n.meta?.name === 'panel' &&
        nodes[(n.inputs.data as { node: string })?.node]?.type === 'Skeleton',
    );
    return {
      panel: panel ? data(panel[0]) : null,
      prop: prop ? data(prop[0]) : null,
      rigHidden: rig ? Boolean(rig[1].meta?.hidden) : null,
      retargets,
    };
  });
  // The panel is deformed by an Armature modifier; the cube stands alone; the rig stays standing —
  // a file that brings its own meshes is a character, not a motion to bind onto another.
  expect(landed.panel?.stack).toEqual(['ArmatureModifier']);
  expect(landed.prop?.stack).toEqual([]);
  expect(landed.rigHidden).toBe(false);
  expect(landed.retargets).toBe(retargetsBefore);

  await page.waitForFunction(
    () => Boolean((window as unknown as BasherWindow).__basher_gltf_skin?.()),
    {
      timeout: 15_000,
    },
  );
  const rest = await page.evaluate(() => {
    const s = (window as unknown as BasherWindow).__basher_gltf_skin!()!;
    return Array.from({ length: s.count }, (_, i) => s.rest(i));
  });
  expect([...new Set(rest.map(keyOf))].sort()).toEqual(Object.keys(BLENDER).sort());

  for (const t of [0.5, 1]) {
    await setTime(page, t);
    const drawn = await page.evaluate(() => {
      const s = (window as unknown as BasherWindow).__basher_gltf_skin!()!;
      return Array.from({ length: s.count }, (_, i) => s.vertex(i));
    });
    drawn.forEach((v, i) => {
      const want = BLENDER[keyOf(rest[i])][t];
      v.forEach((c, k) =>
        expect(c, `vertex resting at ${keyOf(rest[i])}, ${t} s, axis ${k}`).toBeCloseTo(want[k], 3),
      );
    });
  }
  expect(errors).toEqual([]);
});

// #1434 — an FBX whose material samples embedded images: the base colour and the normal map draw the
// file's own images out of the project's image folder, the base colour unmultiplied, as Blender
// draws them (`q18_fbx_texture_oracle.py`: both images 2×2, the base colour's socket linked). Saved
// and reloaded, they still draw: only the project's own copies can supply them then. #1435 — the
// base colour image has alpha, and Blender draws it as the surface's, dithered: hashed, not blended.
test('#1434 — an FBX’s embedded images draw from the project, and still do after a reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_ingestFbxFile),
  );
  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await fetch('/fixtures/anim/tile-textured.fbx').then((r) => r.arrayBuffer()),
    );
    await (window as unknown as BasherWindow).__basher_ingestFbxFile!(bytes, 'tile');
  });
  const tileId = () =>
    page.evaluate(
      () =>
        Object.entries(
          (window as unknown as BasherWindow).__basher_dag.getState().state.nodes,
        ).find(([, n]) => n.type === 'Object' && n.meta?.name === 'Tile')?.[0] ?? null,
    );
  const drawn = async () => {
    const id = await tileId();
    if (id === null) return null;
    return (await drawnImportMeshes(page, id)).map((m) => ({
      mapWidth: m.mapWidth,
      mapColorSpace: m.mapColorSpace,
      normalMapWidth: m.normalMapWidth,
      color: m.color,
      alphaHash: m.alphaHash,
      transparent: m.transparent,
    }));
  };
  const AS_BLENDER = [
    {
      mapWidth: 2,
      mapColorSpace: 'srgb',
      normalMapWidth: 2,
      color: '#ffffff',
      alphaHash: true,
      transparent: false,
    },
  ];
  await expect.poll(drawn, { message: 'after import', timeout: 15_000 }).toEqual(AS_BLENDER);

  const projectId = (await page.evaluate(() => localStorage.getItem('basher.lastProjectId')))!;
  await page.keyboard.press('ControlOrMeta+s');
  const images = () =>
    page.evaluate(async (pid) => {
      const opfs = (window as unknown as BasherWindow).__basher_opfs!;
      const path = `projects/${pid}/project.json`;
      if (!(await opfs.exists(path))) return [];
      const keys = new Set<string>();
      const walk = (v: unknown): void => {
        if (!v || typeof v !== 'object') return;
        const o = v as Record<string, unknown>;
        if (o.store === 'project' && typeof o.hash === 'string') keys.add(o.hash);
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(new TextDecoder().decode(await opfs.read(path))));
      const out: boolean[] = [];
      for (const key of keys) out.push(await opfs.exists(`projects/${pid}/images/${key}`));
      return out;
    }, projectId);
  await expect
    .poll(images, { message: 'the saved project names both images' })
    .toEqual([true, true]);

  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await expect.poll(drawn, { message: 'after a reload', timeout: 15_000 }).toEqual(AS_BLENDER);
  expect(errors).toEqual([]);
});
