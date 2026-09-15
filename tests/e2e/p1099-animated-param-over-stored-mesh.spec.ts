// #1099 — keyframing a modifier's param over stored mesh data draws the animation, and the editor
// stays up. Observed on the page (errors, the layout) and on the RENDERED three.js mesh.
//
// ── THE DEFECT THIS PINS ────────────────────────────────────────────────────────────────
//
// An animated param reaches the screen through the channel overlay, which clones the evaluated
// value through JSON. A native import's mesh travels inside its geometry handle as typed arrays,
// and JSON turns those into plain objects with no `length`. The handle repair then rebuilt the
// Array from that damaged source and threw, and the whole editor unmounted (measured: 5 page
// errors, layout gone). A box never showed it (its descriptor is plain numbers), nor did a static
// splice (nothing is overlaid). The repair now reads the handle from the un-overlaid value.
//
// ── WHAT IS OBSERVED ────────────────────────────────────────────────────────────────────
//
// A native cube import, an Array spliced over its stored mesh, and a keyframe on the Array's
// `count` from 2 to 5 over two seconds. Then: no page error at any step, the layout still visible,
// and the vertices drawn under the import at 2 s are 5/2 of those at 0 s — so the animation is
// drawn, not merely survived.
//
// REF: src/app/overlayWithIdentity.ts (`rebuildInvalidatedHandles`); src/nodes/overlayChannels.ts
//      (the JSON clone, left as it is); #1099.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { importRoots } from './_importedMesh';

interface GraphNode {
  id: string;
  type: string;
  inputs: Record<string, { node: string } | { node: string }[]>;
}
interface O3 {
  isMesh?: boolean;
  visible: boolean;
  parent: O3 | null;
  traverse: (fn: (o: O3) => void) => void;
  geometry: { getAttribute: (n: string) => { count: number } };
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, GraphNode> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => unknown;
    };
  };
  __basher_three: {
    getState: () => { scene: { getObjectByName: (n: string) => O3 | undefined } | null };
  };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

/** Total vertices of every visible mesh drawn under `rootId`; 0 while no scene is mounted. */
async function drawnVertices(page: Page, rootId: string): Promise<number> {
  return page.evaluate((id) => {
    const root = (window as unknown as BasherWindow).__basher_three
      .getState()
      .scene?.getObjectByName(id);
    let total = 0;
    root?.traverse((o) => {
      if (!o.isMesh) return;
      for (let p: O3 | null = o; p; p = p.parent) if (!p.visible) return;
      total += o.geometry.getAttribute('position').count;
    });
    return total;
  }, rootId);
}

const setTime = (page: Page, seconds: number) =>
  page.evaluate((s) => {
    const time = (window as unknown as BasherWindow).__basher_time.getState();
    time.pause();
    time.setTime(s);
  }, seconds);

test('#1099 — a keyframed Array count over a native import draws the animation, and the editor stays up', async ({
  page,
}) => {
  test.slow(); // a native import staged through OPFS, a splice, and two timed reads
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.evaluate(async () => {
    try {
      await (await navigator.storage.getDirectory()).removeEntry('basher', { recursive: true });
    } catch {
      /* not present */
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_dag && w.__basher_ingestGltfFolder && w.__basher_three?.getState().scene,
    );
  });

  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      (await fetch('/assets/cube.gltf').then((r) => r.arrayBuffer())) as ArrayBuffer,
    );
    await (window as unknown as BasherWindow).__basher_ingestGltfFolder!(
      [{ relativePath: 'cube.gltf', bytes }],
      'p1099-cube',
    );
  });
  await expect.poll(async () => (await importRoots(page)).length, { timeout: 20_000 }).toBe(1);
  const [root] = await importRoots(page);
  // The subject is stored mesh data; a file that silently arrived on the clone road measures nothing.
  expect(root.road).toBe('native');

  const ids = await page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    const mesh = Object.values(nodes).find((n) => n.type === 'PolyMeshData')!.id;
    const obj = Object.values(nodes).find(
      (n) => n.type === 'Object' && (n.inputs.data as { node: string } | undefined)?.node === mesh,
    )!.id;
    return { mesh, obj };
  });

  // The static splice first: an Array of 2 over the stored mesh.
  await setTime(page, 0);
  await expect.poll(() => drawnVertices(page, root.rootId), { timeout: 20_000 }).toBeGreaterThan(0);
  const single = await drawnVertices(page, root.rootId);
  await page.evaluate(
    ({ mesh, obj }) =>
      (window as unknown as BasherWindow).__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'disconnect',
            from: { node: mesh, socket: 'out' },
            to: { node: obj, socket: 'data' },
          },
          { type: 'addNode', nodeId: 'p1099_arr', nodeType: 'ArrayModifier', params: { count: 2 } },
          {
            type: 'connect',
            from: { node: mesh, socket: 'out' },
            to: { node: 'p1099_arr', socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: 'p1099_arr', socket: 'out' },
            to: { node: obj, socket: 'data' },
          },
        ],
        'e2e',
        'p1099 splice Array',
      ),
    ids,
  );
  await expect.poll(() => drawnVertices(page, root.rootId), { timeout: 20_000 }).toBe(single * 2);

  // The keyframe on `count`: 2 at 0 s, 5 at 2 s.
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1099_count',
          nodeType: 'KeyframeChannelNumber',
          params: {
            name: 'p1099 count',
            target: 'p1099_arr',
            paramPath: 'count',
            keyframes: [
              { time: 0, value: 2, easing: 'linear' },
              { time: 2, value: 5, easing: 'linear' },
            ],
          },
        },
      ],
      'e2e',
      'p1099 keyframe count',
    ),
  );
  await expect.poll(() => drawnVertices(page, root.rootId), { timeout: 20_000 }).toBe(single * 2);
  await setTime(page, 2);
  await expect.poll(() => drawnVertices(page, root.rootId), { timeout: 20_000 }).toBe(single * 5);

  await expect(page.getByTestId('layout')).toBeVisible();
  expect(errors, 'no page error at any step').toEqual([]);
});
