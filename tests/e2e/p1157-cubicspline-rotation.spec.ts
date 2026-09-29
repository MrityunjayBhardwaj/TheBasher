// p1157 — a glTF rotation sampled CUBICSPLINE imports native, and the curve on screen is the
// file's own.
//
// `anim-cubic-rot.gltf` (scripts/gen-anim-cubic-rot-fixture.mjs) rotates a cube through three keys
// with tangents far from any automatic handle and unequal spans. That file used to be refused by
// the native road, because a quaternion channel had nowhere to hold the tangents; it now imports
// as ordinary channels like every other clip.
//
// THE CLAIM IS READ OFF THE DRAWN MESH, not off the graph. The drawn world matrix at t = 0 fixes
// the import's own placement G; at every other time the drawn matrix must equal G · Cube(t), where
// Cube(t) is computed HERE from the spec's formula (Appendix C.5: Hermite over the four components,
// normalized at `:3628`) rather than borrowed from the code under test.
//
// The control that makes it a test of the TANGENTS: the same keys slerped — what a reader that
// dropped the tangents would draw, which is what Blender's importer does
// (`animation_node.py:67-69`) — must be VISIBLY different at the times checked. Without that row,
// a sampler that ignored the handles could still pass by landing near the arc.
//
// REF: src/core/import/nativeGltfClip.ts, src/nodes/keyframeInterp.ts (segmentQuat); glTF 2.0
//      Specification.adoc Appendix C.5; issues #1157, #1051.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { Matrix4, Quaternion, Vector3 } from 'three';

interface W {
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
        outputs: { scene?: unknown };
      };
    };
  };
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
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

// ── The spec's curve, Appendix C.5 ────────────────────────────────────────────────────────────
const D2R = Math.PI / 180;
const axisAngle = (axis: [number, number, number], deg: number): number[] => {
  const q = new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), deg * D2R);
  return [q.x, q.y, q.z, q.w];
};
const T = [0, 0.4, 1.5];
const V = [axisAngle([0, 1, 0], 0), axisAngle([0, 1, 0], 45), axisAngle([1, 1, 1], 120)];
const IN = [
  [0, 0, 0, 0],
  [0.3, -0.9, 0.2, 0.4],
  [-0.7, 0.25, 0.8, -0.3],
];
const OUT = [
  [0.8, 0.4, -0.2, 0.6],
  [-0.25, 0.7, 0.45, 0.1],
  [0, 0, 0, 0],
];

function segment(t: number): { k: number; u: number; td: number } {
  const c = Math.min(Math.max(t, T[0]), T[T.length - 1]);
  const k = c <= T[1] ? 0 : 1;
  const td = T[k + 1] - T[k];
  return { k, u: (c - T[k]) / td, td };
}

/** The spec's Hermite over the components, normalized (`:3615-3638`, `:3628`). */
function specRotation(t: number): Quaternion {
  const { k, u, td } = segment(t);
  const h = (i: number) =>
    (2 * u ** 3 - 3 * u ** 2 + 1) * V[k][i] +
    td * (u ** 3 - 2 * u ** 2 + u) * OUT[k][i] +
    (-2 * u ** 3 + 3 * u ** 2) * V[k + 1][i] +
    td * (u ** 3 - u ** 2) * IN[k + 1][i];
  return new Quaternion(h(0), h(1), h(2), h(3)).normalize();
}

/** The same keys with the tangents thrown away — the control, not the claim. */
function slerpedRotation(t: number): Quaternion {
  const { k, u } = segment(t);
  const a = new Quaternion(V[k][0], V[k][1], V[k][2], V[k][3]);
  const b = new Quaternion(V[k + 1][0], V[k + 1][1], V[k + 1][2], V[k + 1][3]);
  return a.clone().slerp(b, u);
}

const degreesApart = (a: Quaternion, b: Quaternion) =>
  (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;

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

/** The import's own Group, found by the channel the import wrote and the graph's edges. */
async function importedGroupId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const nodes = Object.values((window as unknown as W).__basher_dag!.getState().state.nodes);
    const rot = nodes.find((n) => n.type === 'KeyframeChannelQuat');
    if (!rot) return null;
    const target = rot.params.target as string;
    const holds = (id: string) => (n: (typeof nodes)[number]) => {
      const kids = (n as unknown as { inputs: Record<string, { node: string }[]> }).inputs.children;
      return Array.isArray(kids) && kids.some((k) => k.node === id);
    };
    // Walk up to the SCENE CHILD and stop there: only a top-level scene child carries its node id
    // on the drawn object (`SceneFromDAG.tsx`), and the Scene holds children too — walking past it
    // returns the scene, which draws nothing under that name.
    let id = target;
    for (;;) {
      const parent = nodes.find(holds(id));
      if (!parent) return null;
      if (parent.type === 'Scene') return id;
      id = parent.id;
    }
  });
}

test('#1157 — a CUBICSPLINE rotation imports native and draws the file’s own curve', async ({
  page,
}) => {
  test.slow();
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
    const response = await fetch('/assets/anim-cubic-rot.gltf');
    const bytes = new Uint8Array(await response.arrayBuffer());
    await w.__basher_ingestGltfFolder!([{ relativePath: 'anim-cubic-rot.gltf', bytes }], 'p1157');
  });

  // Native, and nothing refused it: no refusal banner, and a quaternion channel exists.
  await expect.poll(() => importedGroupId(page)).not.toBeNull();
  const groupId = (await importedGroupId(page))!;
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
  const shape = await page.evaluate(() => {
    const nodes = Object.values((window as unknown as W).__basher_dag!.getState().state.nodes);
    const rot = nodes.find((n) => n.type === 'KeyframeChannelQuat');
    const keys = (rot?.params.keyframes ?? []) as {
      time: number;
      inHandle?: unknown;
      outHandle?: unknown;
    }[];
    return {
      gltfNodes: nodes.filter((n) => n.type === 'GltfData' || n.type === 'GltfAsset').length,
      keyTimes: keys.map((k) => k.time),
      handled: keys.filter((k) => k.inHandle || k.outHandle).length,
    };
  });
  expect(shape.gltfNodes, 'nothing reads the file after import').toBe(0);
  expect(shape.keyTimes).toHaveLength(3);
  expect(shape.handled, 'the file’s tangents arrived as handles on the keys').toBe(3);

  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());

  // Calibrate the import's own placement off the draw at t = 0, then hold every other time to
  // G · Cube(t). The times are unordered so a draw that stopped following time cannot pass.
  await setTime(page, 0);
  await expect.poll(() => drawnMatrix(page, groupId)).not.toBeNull();
  const d0 = new Matrix4().fromArray((await drawnMatrix(page, groupId))!);
  const local0 = new Matrix4().makeRotationFromQuaternion(specRotation(0));
  const G = d0.multiply(local0.invert());

  const checked: number[] = [];
  for (const t of [0.9, 0.2, 1.4, 0.55, 1.1]) {
    await setTime(page, t);
    const want = G.clone()
      .multiply(new Matrix4().makeRotationFromQuaternion(specRotation(t)))
      .toArray();
    await expect
      .poll(
        async () => {
          const got = (await drawnMatrix(page, groupId))!;
          return Math.max(...got.map((v, i) => Math.abs(v - want[i])));
        },
        { message: `the drawn cube at t=${t} is the spec's curve` },
      )
      .toBeLessThan(1e-4);
    checked.push(t);
  }
  expect(checked).toHaveLength(5);

  // The handles are stored data, so they must survive the round trip through the project file.
  // Saved, reloaded, and the draw still holds to the spec's curve at a time it has to compute.
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForTimeout(500);
  await page.reload();
  await waitForEditor(page);
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());
  const reloadedId = (await importedGroupId(page))!;
  await setTime(page, 0);
  await expect.poll(() => drawnMatrix(page, reloadedId)).not.toBeNull();
  const r0 = new Matrix4().fromArray((await drawnMatrix(page, reloadedId))!);
  const G2 = r0.multiply(new Matrix4().makeRotationFromQuaternion(specRotation(0)).invert());
  await setTime(page, 0.9);
  const wantAfterReload = G2.clone()
    .multiply(new Matrix4().makeRotationFromQuaternion(specRotation(0.9)))
    .toArray();
  await expect
    .poll(
      async () => {
        const got = (await drawnMatrix(page, reloadedId))!;
        return Math.max(...got.map((v, i) => Math.abs(v - wantAfterReload[i])));
      },
      { message: 'after a save and reload, the curve is still the file’s' },
    )
    .toBeLessThan(1e-4);

  // The control: at these same times, dropping the tangents would have drawn something else.
  // Without this, a sampler that ignored the handles could pass the rows above.
  const apart = checked.map((t) => degreesApart(specRotation(t), slerpedRotation(t)));
  expect(
    Math.max(...apart),
    'the tangents change the curve, so the rows above test them',
  ).toBeGreaterThan(5);
});
