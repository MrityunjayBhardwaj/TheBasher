// #1205 — what a director does with an imported character, on the road the product takes: a
// skinned file ingested through the product (`__basher_ingestGltfFolder`) is a native character — an
// armature Object posed through its pose layers (the file's keys in a base layer), and a mesh Object
// an Armature modifier deforms by it. These rows carry, onto that road, the user behaviours the
// clone-road specs gated (`p7.7-gltf-child-addressing` E1b/E1c, `p7.12-editable-imported-clips`
// (a)/(b)/(e)), which were deleted with the clone road's character half (#1053):
//   · a part of the character is selected from the outliner and gets the gizmo;
//   · a gizmo move on the mesh Object holds on the drawn skin, frame after frame;
//   · selecting the armature shows the file's keys as rows in the dopesheet, and showing them writes
//     nothing into the graph;
//   · a key edit on one bone moves that bone and leaves an untouched one where it was;
//   · playing a character after a key edit costs React nothing (no time subscription).
import { readFileSync } from 'node:fs';
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

type Vec3 = [number, number, number];
interface Node {
  type: string;
  params: Record<string, unknown>;
  inputs?: Record<string, { node?: string } | undefined>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, Node> };
      dispatch: (op: unknown, source?: string) => void;
    };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_time: {
    getState: () => { play: () => void; pause: () => void; setTime: (s: number) => void };
  };
  __basher_gltf_skin?: () => {
    count: number;
    rest: (i: number) => Vec3;
    vertex: (i: number) => Vec3;
  } | null;
  __basher_armature?: { names: string[]; matrices: number[][] };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_gizmo?: () => unknown;
  __basher_gizmo_grab?: (mode: string, target: Vec3) => void;
  __basher_chrome?: { getState: () => { setLeftSidebarCollapsed: (v: boolean) => void } };
  __basher_perf?: { start: () => void; stop: () => { commits: number } };
}
interface LayerChannel {
  bone: string;
  component: string;
  keyframes: { time: number; value: number[] }[];
}

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** The character's ids: the armature Object (what the Armature modifier deforms by), the mesh
 *  Object (whose data is that modifier), the import's Group, and the base pose layer (the one
 *  holding the file's keys). */
async function character(page: Page) {
  return page.evaluate(() => {
    const { nodes } = (window as unknown as W).__basher_dag.getState().state;
    const modifier = Object.keys(nodes).find((id) => nodes[id].type === 'ArmatureModifier')!;
    const mesh = Object.keys(nodes).find(
      (id) => nodes[id].type === 'Object' && nodes[id].inputs?.data?.node === modifier,
    );
    const base = Object.keys(nodes).find(
      (id) =>
        nodes[id].type === 'PoseLayer' &&
        ((nodes[id].params.channels as unknown[] | undefined)?.length ?? 0) > 0,
    );
    const group = Object.keys(nodes).find((id) => nodes[id].type === 'Group');
    return {
      armature: nodes[modifier]?.inputs?.armature?.node ?? null,
      mesh: mesh ?? null,
      base: base ?? null,
      group: group ?? null,
    };
  });
}

/** The tip vertex (highest at rest, then furthest +x): the native draw numbers vertices its own way. */
async function tipIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    let tip = 0;
    for (let i = 1; i < s.count; i++) {
      const r = s.rest(i);
      const best = s.rest(tip);
      if (r[1] > best[1] + 1e-6 || (Math.abs(r[1] - best[1]) <= 1e-6 && r[0] > best[0])) tip = i;
    }
    return tip;
  });
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
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_time);
  });
  const bytes = [...readFileSync('public/assets/skinned-bar.glb')];
  await page.evaluate(
    (b) =>
      (window as unknown as W).__basher_ingestGltfFolder(
        [{ relativePath: 'skinned-bar.glb', bytes: new Uint8Array(b) }],
        'p1205-editing',
      ),
    bytes,
  );
  await page.waitForFunction(
    () => Boolean((window as unknown as W).__basher_gltf_skin?.()),
    undefined,
    {
      timeout: 15_000,
    },
  );
  const ids = await character(page);
  expect(
    ids.armature,
    'no Armature modifier — the import is not a native character',
  ).not.toBeNull();
  expect(ids.mesh).not.toBeNull();
  expect(ids.base, 'no base pose layer holds the file’s keys').not.toBeNull();
});

test('a part of the character is selected from the outliner and gets the gizmo', async ({
  page,
}) => {
  const { mesh, group } = await character(page);
  await page.evaluate(() =>
    (window as unknown as W).__basher_chrome?.getState().setLeftSidebarCollapsed(false),
  );
  await expect(page.getByTestId(`scene-tree-row-${group}`)).toBeVisible({ timeout: 10_000 });
  const row = page.getByTestId(`scene-tree-row-${mesh}`);
  if (!(await row.isVisible())) await page.getByTestId(`scene-tree-toggle-${group}`).click();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByTestId('inspector')).toContainText(mesh!);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as W;
        return w.__basher_gizmo ? w.__basher_gizmo() !== null : false;
      }),
    )
    .toBe(true);
});

test('a gizmo move on the mesh Object holds on the drawn skin, frame after frame', async ({
  page,
}) => {
  const { mesh } = await character(page);
  const tip = await tipIndex(page);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().pause());
  await frames(page);
  const before = await page.evaluate(
    (i) => (window as unknown as W).__basher_gltf_skin!()!.vertex(i),
    tip,
  );
  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection!.getState().select(id),
    mesh!,
  );
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_gizmo && w.__basher_gizmo() !== null);
  });
  const x0 = await page.evaluate(
    (id) =>
      ((window as unknown as W).__basher_dag.getState().state.nodes[id].params.position as Vec3)[0],
    mesh!,
  );
  await page.evaluate(() => (window as unknown as W).__basher_gizmo_grab!('translate', [3, 0, 0]));
  const x1 = await page.evaluate(
    (id) =>
      ((window as unknown as W).__basher_dag.getState().state.nodes[id].params.position as Vec3)[0],
    mesh!,
  );
  expect(x1 - x0, 'the grab moved the mesh Object').toBeCloseTo(3, 3);
  await frames(page);
  const p1 = await page.evaluate(
    (i) => (window as unknown as W).__basher_gltf_skin!()!.vertex(i),
    tip,
  );
  await frames(page);
  await frames(page);
  const p2 = await page.evaluate(
    (i) => (window as unknown as W).__basher_gltf_skin!()!.vertex(i),
    tip,
  );
  expect(
    p1[0] - before[0],
    `the move is not on the drawn skin (dx=${p1[0] - before[0]})`,
  ).toBeCloseTo(3, 3);
  expect(
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]),
    'the move snapped back',
  ).toBeLessThan(1e-6);
});

test('selecting the armature shows the file’s keys as dopesheet rows, and writes nothing', async ({
  page,
}) => {
  const { armature, base } = await character(page);
  const nodesBefore = await page.evaluate(
    () => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes).length,
  );
  const baseChannels = await page.evaluate(
    (id) =>
      (
        (window as unknown as W).__basher_dag.getState().state.nodes[id].params
          .channels as unknown[]
      ).length,
    base!,
  );
  await page.getByTestId('floating-toolbar-timeline').click();
  const host = page.getByTestId('timeline-canvas');
  await expect(host).toBeVisible();
  const rows = async () => Number(await host.getAttribute('data-channel-count'));
  // With the default box selected: whatever rows the scene shows without the character.
  const box = await page.evaluate(() => {
    const { nodes } = (window as unknown as W).__basher_dag.getState().state;
    return Object.keys(nodes).find(
      (id) =>
        nodes[id].type === 'Object' &&
        nodes[nodes[id].inputs?.data?.node ?? '']?.type === 'BoxData',
    )!;
  });
  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection!.getState().select(id),
    box,
  );
  await frames(page);
  const without = await rows();
  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection!.getState().select(id),
    armature!,
  );
  await expect
    .poll(rows, 'the armature’s base-layer rows appear')
    .toBeGreaterThanOrEqual(without + baseChannels);
  expect(
    await page.evaluate(
      () => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes).length,
    ),
    'showing the keys wrote nodes into the graph',
  ).toBe(nodesBefore);
});

test('a key edit on one bone moves that bone and leaves an untouched bone where it was', async ({
  page,
}) => {
  const { base } = await character(page);
  const bandAt = async (seconds: number) => {
    await page.evaluate(
      (s) => (window as unknown as W).__basher_time.getState().setTime(s),
      seconds,
    );
    await frames(page);
    return page.evaluate(() => {
      const a = (window as unknown as W).__basher_armature!;
      return Object.fromEntries(a.names.map((n, i) => [n, a.matrices[i]]));
    });
  };
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().pause());
  const before = await bandAt(0.5);
  expect(Object.keys(before)).toEqual(expect.arrayContaining(['Bone0', 'Bone1']));
  // Bone1's rotation keys to identity: the bar unbends at Bone1; Bone0 has no keys to touch.
  await page.evaluate((id) => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const channels = dag.state.nodes[id].params.channels as LayerChannel[];
    dag.dispatch(
      {
        type: 'setParam',
        nodeId: id,
        paramPath: 'channels',
        value: channels.map((c) =>
          c.bone === 'Bone1' && c.component === 'quaternion'
            ? { ...c, keyframes: c.keyframes.map((k) => ({ ...k, value: [0, 0, 0, 1] })) }
            : c,
        ),
      },
      'user',
    );
  }, base!);
  const after = await bandAt(0.5);
  const diff = (a: number[], b: number[]) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));
  expect(diff(after.Bone1, before.Bone1), 'the edited bone did not move').toBeGreaterThan(0.05);
  expect(diff(after.Bone0, before.Bone0), 'an untouched bone moved').toBeLessThan(1e-6);
});

test('playing a character after a key edit costs React nothing', async ({ page }) => {
  test.setTimeout(60_000);
  const { base } = await character(page);
  await page.evaluate((id) => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const channels = dag.state.nodes[id].params.channels as LayerChannel[];
    dag.dispatch(
      {
        type: 'setParam',
        nodeId: id,
        paramPath: 'channels',
        value: channels.map((c) => ({
          ...c,
          keyframes: c.keyframes.map((k, i) => (i === 0 ? { ...k, time: k.time + 0.01 } : k)),
        })),
      },
      'user',
    );
  }, base!);
  const result = await page.evaluate(async () => {
    const w = window as unknown as W;
    w.__basher_time.getState().pause();
    w.__basher_time.getState().setTime(0);
    await new Promise<void>((r) => setTimeout(r, 200));
    w.__basher_perf!.start();
    w.__basher_time.getState().play();
    await new Promise<void>((r) => setTimeout(r, 5000));
    w.__basher_time.getState().pause();
    return w.__basher_perf!.stop();
  });
  console.log(
    `[p1205] commits during 5 s playback of an edited native character = ${result.commits}`,
  );
  expect(
    result.commits,
    `React committed ${result.commits} times during 5 s of playback: something subscribed the React ` +
      `tree to time, and the character now re-renders every frame`,
  ).toBe(0);
});
