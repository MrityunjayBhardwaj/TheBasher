// p1154 — a glTF file with several animations imports native through the product road, the later
// ones held muted, and unmuting one moves what it drives ON SCREEN.
//
// `three-clips-nested.gltf` (built by `ref/probes/blender-native-character/q1154_two_clips_oracle.py`)
// carries "Slide" (A), "Lift" (B and A) and a second "Slide" (C). Blender stashes each on a muted NLA
// track and makes the first active (`io_scene_gltf2/blender/imp/animation_utils.py:20-29`); here the
// later two are muted `Track`s named "Lift" and "Slide.001". B holds the one mesh, a triangle, at
// (0, 0, -2): "Lift" moves it to (0, 3, 0) at 1 s (Blender's number, frame 24).
//
// The claim is read off the LIVE drawn mesh: muted, B draws where it rests; unmuted, it draws where
// Blender puts it. Before #1154 the native road refused this file whole.
//
// REF: src/core/import/nativeGltfImport.ts (`heldObjectAnimationOps`), src/app/layeredChannels.ts;
//      src/core/import/heldAnimations.gate.test.ts (the unit oracle); issue #1154.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface DagNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, { node: string } | { node: string }[]>;
}
interface W {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, DagNode>; outputs: { scene?: unknown } };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_time?: { getState: () => { setTime: (seconds: number) => void } };
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene &&
        w.__basher_three?.getState().scene &&
        w.__basher_ingestGltfFolder &&
        w.__basher_time,
      );
    },
    { timeout: 20_000 },
  );
}

/**
 * Where three draws B's triangle, in world space: found under the import Group (the Group whose
 * children include the Object named "B"), because only a top-level scene child carries its node id on
 * the drawn object (`SceneFromDAG.tsx`, #1075) — as p1051 finds its cube.
 */
async function drawnTriangle(page: Page): Promise<number[] | null> {
  return page.evaluate(() => {
    const w = window as unknown as W;
    const nodes = Object.values(w.__basher_dag!.getState().state.nodes);
    const b = nodes.find(
      (n) =>
        n.type === 'Object' && (n as unknown as { meta?: { name?: string } }).meta?.name === 'B',
    );
    const group = nodes.find((n) => {
      const kids = n.inputs.children;
      return n.type === 'Group' && Array.isArray(kids) && kids.some((k) => k.node === b?.id);
    });
    if (!group) return null;
    type O3 = {
      isMesh?: boolean;
      matrixWorld: { elements: number[] };
      traverse: (f: (o: O3) => void) => void;
    };
    const scene = w.__basher_three!.getState().scene as unknown as {
      getObjectByName: (n: string) => O3 | undefined;
      updateMatrixWorld: (force?: boolean) => void;
    };
    scene.updateMatrixWorld(true);
    let found: number[] | null = null;
    scene.getObjectByName(group.id)?.traverse((o) => {
      if (!o.isMesh || found) return;
      const e = o.matrixWorld.elements;
      found = [e[12], e[13], e[14]];
    });
    return found;
  });
}

test('#1154 — a file with three animations imports native, the later two muted tracks', async ({
  page,
}) => {
  test.slow(); // an ingest, and reads off the live scene
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

  await page.evaluate(async () => {
    const w = window as unknown as W;
    const bytes = new Uint8Array(
      await fetch('/assets/three-clips-nested.gltf').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder!(
      [{ relativePath: 'three-clips-nested.gltf', bytes }],
      'p1154',
    );
  });

  const tracks = () =>
    page.evaluate(() =>
      Object.values((window as unknown as W).__basher_dag!.getState().state.nodes)
        .filter((n) => n.type === 'Track')
        .map((n) => ({ id: n.id, name: n.params.name as string, mute: n.params.mute as boolean }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  await expect.poll(async () => (await tracks()).length).toBe(2);
  const held = await tracks();
  expect(held.map((t) => [t.name, t.mute])).toEqual([
    ['Lift', true],
    ['Slide.001', true],
  ]);
  const gltfNodes = await page.evaluate(
    () =>
      Object.values((window as unknown as W).__basher_dag!.getState().state.nodes).filter(
        (n) => n.type === 'GltfData' || n.type === 'GltfAsset',
      ).length,
  );
  expect(gltfNodes, 'native: nothing in the graph reads the file').toBe(0);

  // At 1 s with "Lift" muted, B draws at rest: (0, 0, -2).
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().setTime(1));
  await expect.poll(() => drawnTriangle(page)).not.toBeNull();
  const muted = (await drawnTriangle(page))!;
  [0, 0, -2].forEach((c, axis) => expect(muted[axis], `muted, axis ${axis}`).toBeCloseTo(c, 5));

  // Unmute "Lift": B draws where Blender puts it at frame 24, (0, 3, 0).
  const lift = held.find((t) => t.name === 'Lift')!.id;
  // The sanctioned raw road (as nla-lane-view mutes a track): dispatch throws on a refused op.
  await page.evaluate(
    (id) =>
      (window as unknown as W).__basher_dag!.getState().dispatch({
        type: 'setParam',
        nodeId: id,
        paramPath: 'mute',
        value: false,
      }),
    lift,
  );
  expect((await tracks()).find((t) => t.id === lift)?.mute).toBe(false);
  await expect
    .poll(async () => (await drawnTriangle(page))?.[1] ?? null, { timeout: 10_000 })
    .toBeCloseTo(3, 5);
  const played = (await drawnTriangle(page))!;
  [0, 3, 0].forEach((c, axis) => expect(played[axis], `unmuted, axis ${axis}`).toBeCloseTo(c, 5));
});
