// #1205 — a skinned file dropped into the product comes in native, through the product's own road
// (`__basher_ingestGltfFolder`: the drop / picker chokepoint, OPFS write → `importGltfFromOpfs`).
// Checked: nothing of the clone road; the drawn tip vertex where Blender 5.1.1 draws it at frames 0,
// 12 and 24 (`ref/probes/blender-armature-deform/q13_skinned_bar_oracle.py`, as #1197's spec); and
// the character still draws the same after a save, the source file deleted, and a reload — the
// file stopped existing when it was read. And a skinned file the native reader refuses is not
// imported at all, with the refusal named (user decision on #1205).
import { readFileSync } from 'node:fs';
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface SkinSeam {
  count: number;
  rest: (i: number) => [number, number, number];
  vertex: (i: number) => [number, number, number];
}
interface BasherWindow {
  __basher_dag: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinSeam | null;
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

/** Blender's tip, glTF space: frame 0 (rest), 12 (0.5 s), 24 (1 s). */
const BLENDER_TIP: Record<number, [number, number, number]> = {
  0: [0.2, 2, 0],
  0.5: [-0.528135, 1.872395, 0],
  1: [-0.978764, 1.286395, 0],
};

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return typeof w.__basher_ingestGltfFolder === 'function' && Boolean(w.__basher_time);
  });
}

async function setTime(page: Page, seconds: number): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time.getState().setTime(s),
    seconds,
  );
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

const types = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Object.values((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).map(
      (n) => n.type,
    ),
  );

/** The tip vertex (highest at rest, then furthest +x) drawn at each time, less the import's
 *  placement offset (the Group places the model by its pivot, so rest = file point + offset). */
async function tipAgainstBlender(page: Page): Promise<number[][]> {
  await page.waitForFunction(
    () => Boolean((window as unknown as BasherWindow).__basher_gltf_skin?.()),
    { timeout: 15_000 },
  );
  const { tip, rest, count } = await page.evaluate(() => {
    const s = (window as unknown as BasherWindow).__basher_gltf_skin!()!;
    let tip = 0;
    for (let i = 1; i < s.count; i++) {
      const r = s.rest(i);
      const best = s.rest(tip);
      if (r[1] > best[1] + 1e-6 || (Math.abs(r[1] - best[1]) <= 1e-6 && r[0] > best[0])) tip = i;
    }
    return { tip, rest: s.rest(tip), count: s.count };
  });
  expect(count, 'vertices the tip search examined').toBeGreaterThanOrEqual(6);
  const offset = rest.map((c, k) => c - BLENDER_TIP[0][k]);
  const out: number[][] = [];
  for (const t of [0, 0.5, 1]) {
    await setTime(page, t);
    const drawn = await page.evaluate(
      (i) => (window as unknown as BasherWindow).__basher_gltf_skin!()!.vertex(i),
      tip,
    );
    out.push(drawn.map((c, k) => c - offset[k]));
  }
  return out;
}

function expectBlender(tips: number[][], when: string): void {
  [0, 0.5, 1].forEach((t, i) =>
    tips[i].forEach((c, k) =>
      expect(c, `${when}: tip at ${t}s, axis ${k}`).toBeCloseTo(BLENDER_TIP[t][k], 3),
    ),
  );
}

test.beforeEach(async ({ page }) => {
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
  await ready(page);
});

test('#1205 — a skinned file dropped in comes in native, drawn as Blender draws it, and outlives its file', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bytes = [...readFileSync('public/assets/skinned-bar.glb')];
  const path = await page.evaluate(
    (b) =>
      (window as unknown as BasherWindow).__basher_ingestGltfFolder(
        [{ relativePath: 'skinned-bar.glb', bytes: new Uint8Array(b) }],
        'p1205',
      ),
    bytes,
  );
  expect(path).toContain('skinned-bar.glb');

  const imported = await types(page);
  expect(imported).toEqual(
    expect.arrayContaining(['Skeleton', 'PoseLayer', 'ArmatureModifier', 'PolyMeshData']),
  );
  expect(imported.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expectBlender(await tipAgainstBlender(page), 'imported');

  // Saved; the source file leaves storage; the project loads again.
  const gone = await page.evaluate(async (p) => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
    const storage = await boot.getStorage();
    await storage.delete(p);
    return !(await storage.exists(p));
  }, path);
  expect(gone).toBe(true);
  await page.reload();
  await ready(page);
  expect((await types(page)).filter((t) => /^Gltf/.test(t))).toEqual([]);
  expectBlender(await tipAgainstBlender(page), 'reloaded with the file gone');
  expect(errors).toEqual([]);
});

test('#1205 — a skinned file the native reader refuses is not imported, and the refusal is named', async ({
  page,
}) => {
  // skinned-bar with a second node drawing its mesh: the native reader refuses a shared mesh (#1061).
  const src = readFileSync('public/assets/skinned-bar.glb');
  const jsonLength = src.readUInt32LE(12);
  const json = JSON.parse(src.subarray(20, 20 + jsonLength).toString());
  json.nodes.push({ name: 'Twin', mesh: 0 });
  json.scenes[0].nodes.push(json.nodes.length - 1);
  let text = JSON.stringify(json);
  text += ' '.repeat((4 - (text.length % 4)) % 4);
  const jsonBytes = Buffer.from(text);
  const rest = src.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBytes.length + rest.length, 8);
  header.writeUInt32LE(jsonBytes.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const bytes = [...Buffer.concat([header, jsonBytes, rest])];

  const before = await types(page);
  const path = await page.evaluate(
    (b) =>
      (window as unknown as BasherWindow).__basher_ingestGltfFolder(
        [{ relativePath: 'shared.glb', bytes: new Uint8Array(b) }],
        'p1205-refused',
      ),
    bytes,
  );
  expect(await types(page)).toEqual(before);
  const notice = await page.evaluate(async (p) => {
    const m = await import('/src/app/stores/assetErrorStore.ts');
    return m.useAssetErrorStore.getState().errors[p] ?? null;
  }, path);
  expect(notice).toContain('import refused: it is a character (it has a skin)');
  expect(notice).toContain('#1061');
  await expect(page.getByText(/import refused: it is a character/)).toBeVisible();
});
