// p1051 — an animated glTF imports native, and the clip plays on screen as the glTF spec defines it.
//
// `anim-nested.gltf` (scripts/gen-anim-nested-fixture.mjs) animates a cube under an empty with every
// interpolation on every path: LINEAR and STEP rotation, STEP scale, LINEAR translation and a
// CUBICSPLINE translation whose tangents are far from any automatic handle.
//
// THE CLAIM IS READ OFF THE DRAWN MESH. The cube's drawn world matrix at t = 0 fixes the import's
// own placement G (the import Group and its pivot, which the clip never touches); at every other
// time the drawn matrix must equal G · Pivot(t) · Cube(t), where Pivot(t) and Cube(t) are computed
// here from the spec's formulas (Appendix C), not from the code under test. The times are ordered so
// each one draws somewhere new: a draw that stopped following time cannot pass by standing still.
//
// Also observed: the file is native (nothing reads it after import), the animation survives save and
// reload, a file this road cannot hold is refused by name, and an Auto-Key on the imported cube
// edits the channel the import wrote rather than minting a second one.
//
// REF: src/core/import/nativeGltfClip.ts, src/core/import/nativeGltfImport.ts; glTF 2.0
//      Specification.adoc Appendix C; Blender io_scene_gltf2/blender/imp/animation_node.py;
//      issues #1051, #1154, #1157.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { Matrix4, Quaternion, Vector3 } from 'three';

interface W {
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_gizmo_grab?: (mode: string, target: [number, number, number]) => void;
  __basher_opfs_read?: unknown;
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          {
            id: string;
            type: string;
            params: Record<string, unknown>;
            inputs: Record<string, { node: string } | { node: string }[]>;
          }
        >;
        outputs: { scene?: unknown };
      };
    };
  };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_opfs?: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<Uint8Array>;
  };
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene &&
        w.__basher_three?.getState().scene &&
        w.__basher_ingestGltfFolder,
      );
    },
    { timeout: 20_000 },
  );
}

/** The import's shape, read through the graph's own edges rather than re-derived from a hash. */

// ── The spec's clip, Appendix C ────────────────────────────────────────────────────────────
const D2R = Math.PI / 180;
const axisAngle = (axis: [number, number, number], deg: number) =>
  new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), deg * D2R);
const clamp = (t: number) => Math.min(Math.max(t, 0), 2);
function hermiteAt(t: number): Vector3 {
  const T = [0, 0.5, 2];
  const V = [
    [1, 0, 0],
    [2, 1, 0],
    [1, 0, 1],
  ];
  const IN = [
    [0, 0, 0],
    [8, -6, 2],
    [-5, 4, 9],
  ];
  const OUT = [
    [6, 5, -3],
    [-4, 7, 1],
    [0, 0, 0],
  ];
  const c = clamp(t);
  const k = c < 0.5 ? 0 : 1;
  const td = T[k + 1] - T[k];
  const u = (c - T[k]) / td;
  const h = (i: number) =>
    (2 * u ** 3 - 3 * u ** 2 + 1) * V[k][i] +
    td * (u ** 3 - 2 * u ** 2 + u) * OUT[k][i] +
    (-2 * u ** 3 + 3 * u ** 2) * V[k + 1][i] +
    td * (u ** 3 - u ** 2) * IN[k + 1][i];
  return new Vector3(h(0), h(1), h(2));
}
/** Pivot(t) · Cube(t), from the spec. */
function specLocal(t: number): Matrix4 {
  const c = clamp(t);
  const pivot = new Matrix4().compose(
    new Vector3(0, 3 + c / 2, 0), // LINEAR, C.3
    axisAngle([0, 0, 1], c < 1 ? 0 : c < 2 ? 90 : 0), // STEP, C.2
    new Vector3(1, 1, 1),
  );
  const K = [axisAngle([0, 1, 0], 0), axisAngle([1, 1, 0], 170), axisAngle([0, 0, 1], 90)];
  const k = Math.min(Math.floor(c), 1);
  const s = c < 1 ? 1 : c < 2 ? 2 : 1; // STEP
  const cube = new Matrix4().compose(
    hermiteAt(t), // CUBICSPLINE, C.5
    K[k].clone().slerp(K[k + 1], c - k), // LINEAR rotation, C.4
    new Vector3(s, s, s),
  );
  return pivot.multiply(cube);
}

/** The one drawn mesh under the import, as its world matrix. */
async function drawnMatrix(page: Page, groupId: string): Promise<number[] | null> {
  return page.evaluate((id) => {
    type O3 = {
      isMesh?: boolean;
      matrixWorld: { elements: number[] };
      traverse: (f: (o: O3) => void) => void;
    };
    const scene = (window as unknown as W).__basher_three!.getState().scene as unknown as {
      getObjectByName: (n: string) => O3 | undefined;
      updateMatrixWorld: (force?: boolean) => void;
    };
    scene.updateMatrixWorld(true);
    let found: number[] | null = null;
    scene.getObjectByName(id)?.traverse((o) => {
      if (o.isMesh && !found) found = [...o.matrixWorld.elements];
    });
    return found;
  }, groupId);
}
const setTime = (page: Page, t: number) =>
  page.evaluate((s) => (window as unknown as W).__basher_time!.getState().setTime(s), t);
const maxDiff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

async function openFresh(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('basher', { recursive: true });
    } catch {
      /* not present */
    }
  });
  await page.reload();
  await waitForEditor(page);
}
async function ingest(page: Page, mutate: string | null, folder: string) {
  await page.evaluate(
    async ({ mutate, folder }) => {
      const w = window as unknown as W;
      const json = await fetch('/assets/anim-nested.gltf').then((r) => r.json());
      if (mutate) new Function('json', mutate)(json);
      const bytes = new TextEncoder().encode(JSON.stringify(json));
      await w.__basher_ingestGltfFolder!([{ relativePath: 'anim-nested.gltf', bytes }], folder);
    },
    { mutate, folder },
  );
}
async function importShape(page: Page) {
  return page.evaluate(() => {
    const nodes = Object.values((window as unknown as W).__basher_dag!.getState().state.nodes);
    const channels = nodes.filter((n) => n.type.startsWith('KeyframeChannel'));
    // The imported mesh node, by its stored mesh data: the default scene's box is an Object too.
    const cube = nodes.find(
      (n) =>
        n.type === 'Object' &&
        !Array.isArray(n.inputs.data) &&
        nodes.some(
          (d) =>
            d.type === 'PolyMeshData' &&
            d.id === (n.inputs.data as { node: string } | undefined)?.node,
        ),
    );
    const holds = (id: string) => (n: (typeof nodes)[number]) =>
      Array.isArray(n.inputs.children) && n.inputs.children.some((k) => k.node === id);
    const pivot = cube ? nodes.find(holds(cube.id)) : undefined;
    const group = pivot ? nodes.find(holds(pivot.id)) : undefined;
    return {
      cubeId: cube?.id ?? null,
      groupId: group?.id ?? null,
      gltfNodes: nodes.filter((n) => n.type === 'GltfData' || n.type === 'GltfAsset').length,
      channels: channels.map((c) => ({
        id: c.id,
        type: c.type,
        target: c.params.target as string,
        paramPath: c.params.paramPath as string,
        keys: (c.params.keyframes as { time: number }[]).map((k) => k.time),
      })),
    };
  });
}

/** Calibrate G at t = 0 off the draw, then demand the draw be G · spec(t) at each time. */
async function playsAsTheSpec(page: Page, groupId: string, label: string) {
  await setTime(page, 0);
  await expect.poll(() => drawnMatrix(page, groupId)).not.toBeNull();
  const d0 = new Matrix4().fromArray((await drawnMatrix(page, groupId))!);
  const G = d0.multiply(specLocal(0).invert());
  const checked: number[] = [];
  for (const t of [1.25, 0.25, 1.75, 0.75, 2.5, 1, 0.4]) {
    await setTime(page, t);
    const want = G.clone().multiply(specLocal(t)).toArray();
    await expect
      .poll(async () => maxDiff((await drawnMatrix(page, groupId))!, want), {
        message: `${label}: the drawn cube at t=${t} is the spec's`,
      })
      .toBeLessThan(1e-4);
    checked.push(t);
  }
  expect(checked).toHaveLength(7);
}

test('#1051 — an animated nested file imports native and plays as the spec defines it', async ({
  page,
}) => {
  test.slow();
  await openFresh(page);
  await ingest(page, null, 'p1051-clip');
  await expect.poll(async () => (await importShape(page)).channels.length).toBe(5);
  const shape = await importShape(page);
  expect(shape.gltfNodes, 'native: nothing reads the file after import').toBe(0);
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());
  // Positive control on the claim's reach: at t=0.25 a component lerp (Blender's reading of a LINEAR
  // rotation) is more than a degree from the spec's slerp, so the draw below tells them apart.
  const K1 = axisAngle([1, 1, 0], 170);
  const lerp = new Quaternion(
    K1.x * 0.25,
    K1.y * 0.25,
    K1.z * 0.25,
    1 - 0.25 + K1.w * 0.25,
  ).normalize();
  const slerp = new Quaternion().slerp(K1, 0.25);
  expect((2 * Math.acos(Math.min(1, Math.abs(lerp.dot(slerp))))) / D2R).toBeGreaterThan(1);
  await playsAsTheSpec(page, shape.groupId!, 'imported');
});

test('#1051 — the imported animation survives save and reload', async ({ page }) => {
  test.slow();
  await openFresh(page);
  await ingest(page, null, 'p1051-clip-save');
  await expect.poll(async () => (await importShape(page)).channels.length).toBe(5);
  const projectId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  expect(projectId, 'the editor has a project to save into').not.toBeNull();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(
      () =>
        page.evaluate(async (path) => {
          const w = window as unknown as W;
          if (!(await w.__basher_opfs!.exists(path))) return false;
          return new TextDecoder()
            .decode(await w.__basher_opfs!.read(path))
            .includes('_quaternion_channel');
        }, `projects/${projectId}/project.json`),
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.reload();
  await waitForEditor(page);
  await expect.poll(async () => (await importShape(page)).channels.length).toBe(5);
  const shape = await importShape(page);
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());
  await playsAsTheSpec(page, shape.groupId!, 'after reload');
});

test('#1051 — a clip this road cannot hold is refused by name, and the file still imports', async ({
  page,
}) => {
  test.slow();
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await openFresh(page);
  // A second clip (#1154), then a CUBICSPLINE rotation (#1157): each takes the file's-copy road
  // and the notice says why.
  await ingest(page, 'json.animations.push({ ...json.animations[0], name: "Drop" });', 'p1051-two');
  await expect
    .poll(() => warnings.find((t) => t.includes('not as native geometry')) ?? '')
    .toContain('#1154');
  await ingest(
    page,
    [
      'const a = json.animations[0];',
      'const s = a.samplers[a.channels.find((c) => c.target.path === "rotation" && c.target.node === 0).sampler];',
      's.interpolation = "CUBICSPLINE";',
      'const acc = json.accessors[s.output];',
      // Three values per key: the output accessor must hold 3× as many. Reuse the input's keys by
      // pointing at a larger zeroed view is not possible here, so the count is what the check reads.
      'acc.count = acc.count * 3;',
    ].join('\n'),
    'p1051-cubic-rot',
  );
  await expect
    .poll(() => warnings.filter((t) => t.includes('not as native geometry')).join('\n'))
    .toContain('#1157');
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});

test('#1051 — Auto-Key on the imported cube keys the channel the import wrote', async ({
  page,
}) => {
  test.slow();
  await openFresh(page);
  await ingest(page, null, 'p1051-clip-key');
  await expect.poll(async () => (await importShape(page)).channels.length).toBe(5);
  const shape = await importShape(page);
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());
  await page.getByTestId('floating-toolbar-timeline').click();
  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection!.getState().select(id),
    shape.cubeId!,
  );
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_gizmo_grab));
  await page.getByTestId('autokey-toggle').click();
  await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');
  await setTime(page, 1.5);
  await page.evaluate(() => (window as unknown as W).__basher_gizmo_grab!('translate', [4, 4, 4]));

  const position = (s: Awaited<ReturnType<typeof importShape>>) =>
    s.channels.filter((c) => c.target === shape.cubeId && c.paramPath === 'position');
  await expect.poll(async () => position(await importShape(page))[0]?.keys.length).toBe(4);
  const after = await importShape(page);
  expect(after.channels, 'no second channel was minted').toHaveLength(5);
  expect(position(after)).toHaveLength(1);
  expect(position(after)[0].id).toBe(`${shape.cubeId}_position_channel`);
  expect(position(after)[0].keys).toContain(1.5);
});
