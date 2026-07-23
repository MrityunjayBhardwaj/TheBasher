// #343 — a Follow-Path is a CONSTRAINT, so it must move ANY object kind end to end, exactly
// as Blender's Follow Path applies to any object. This spec is the KIND-COVERAGE INVARIANT:
// it drives one FollowPath per object kind and asserts the object RENDERS on the path. If a
// future kind gains a new pose road and nothing wires the position band into it, the matching
// case here goes red — "any object follows" becomes true by construction, not by luck.
//
// The four pose roads (H170/V103): mesh-render (ConstrainedR), mesh-read
// (resolveEvaluatedTransform), camera (resolveCameraPoseAt), light (LightKindR). #339 proved
// mesh + camera; #343 adds the LIGHT road (a light is flat in scene.lights, never a scene
// child) and closes the container kinds. A kind with a render body (mesh/light/camera) is
// observed on the RENDER road via that body's world seam — where it actually appears. A
// bodyless container (Null/Group) has no body of its own, so it is observed via its evaluated
// transform (what the gizmo/inspector and every child's world compose read); render == read is
// guaranteed there because both roads fold the same resolveConstraintPosition (the H40 pair).

import { expect, test } from './_fixtures';
import { splitCurveOps } from './_splitCurve';

type V3 = [number, number, number];
interface CurveSample {
  point: V3;
}
interface UiWindow {
  __basher_dag: {
    getState(): { dispatchAtomic: (ops: unknown[], src: string, d: string) => void };
  };
  __basher_curve_sample: (nodeId: string, u: number) => CurveSample | null;
  __basher_mesh_world_position: (nodeId: string) => V3 | null;
  __basher_light_world_positions: () => V3[];
  __basher_frustum_pose?: Record<string, { position: number[] }>;
  __basher_evaluated_transform: (nodeId: string) => { position: V3 } | null;
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    name: string,
  ) => Promise<void>;
}

const U = 0.5; // sample mid-path so every kind visibly leaves its authored spot

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForSelector('canvas');
  await page.waitForFunction(() => Boolean((window as unknown as UiWindow).__basher_curve_sample));
}

/** A curve wired into the scene, offset + rotated + non-uniformly scaled. Named `n_path`. */
async function addPosedCurve(page: import('@playwright/test').Page): Promise<string> {
  const ops = splitCurveOps({
    objectId: 'n_path',
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [11, 0, 0],
      [12, 0, 0],
    ],
    closed: false,
    resolution: 32,
    position: [1, 2, -3],
    rotation: [0, 35, 0],
    scale: [2, 1, 0.5],
  });
  await page.evaluate((ops) => {
    (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
      [
        ...ops,
        {
          type: 'connect',
          from: { node: 'n_path', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
      ],
      'user',
      'add a posed path',
    );
  }, ops);
  await page.waitForTimeout(300);
  return 'n_path';
}

async function seamPoint(page: import('@playwright/test').Page): Promise<V3> {
  const s = await page.evaluate(
    (u) => (window as unknown as UiWindow).__basher_curve_sample('n_path', u),
    U,
  );
  expect(s, 'the seam must resolve the posed curve').toBeTruthy();
  return s!.point;
}

function gap(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function follow(page: import('@playwright/test').Page, ops: unknown[], targetId: string) {
  await page.evaluate(
    ({ ops, targetId }) => {
      (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
        [
          ...(ops as unknown[]),
          {
            type: 'addNode',
            nodeId: `${targetId}_fp`,
            nodeType: 'FollowPath',
            params: { target: targetId, curve: 'n_path', evalTime: 0.5, offset: 0, order: 0 },
          },
        ],
        'user',
        'follow',
      );
    },
    { ops, targetId },
  );
  await page.waitForTimeout(400);
}

test('a followed MESH renders on the path (baseline, mesh-render road)', async ({ page }) => {
  await boot(page);
  await addPosedCurve(page);
  const seam = await seamPoint(page);
  await follow(page, [], 'n_box');
  const rendered = await page.evaluate(() =>
    (window as unknown as UiWindow).__basher_mesh_world_position('n_box'),
  );
  expect(rendered, 'the box mesh must be mounted').toBeTruthy();
  expect(gap(rendered!, seam)).toBeLessThan(1e-3);
});

test('a followed OBJECT renders on the path (#362 — the split-native kind, mesh-render road)', async ({
  page,
}) => {
  // The case that could not exist before the object↔data split: an `Object` (the pose
  // half) wired to a `BoxData` (the data half). It is a mesh-bearing scene child, so it is
  // observed on the RENDER road via its named group's world seam — exactly like the fused
  // box baseline above. If a future change stops folding the Follow-Path position band into
  // the Object's pose, this goes red, keeping "any object follows" true by construction.
  await boot(page);
  await addPosedCurve(page);
  const seam = await seamPoint(page);
  await follow(
    page,
    [
      { type: 'addNode', nodeId: 'n_objdata', nodeType: 'BoxData', params: { size: [1, 1, 1] } },
      { type: 'addNode', nodeId: 'n_obj', nodeType: 'Object', params: { position: [0, 0, 0] } },
      {
        type: 'connect',
        from: { node: 'n_objdata', socket: 'out' },
        to: { node: 'n_obj', socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: 'n_obj', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ],
    'n_obj',
  );
  const rendered = await page.evaluate(() =>
    (window as unknown as UiWindow).__basher_mesh_world_position('n_obj'),
  );
  expect(rendered, 'the Object must be mounted (its named group renders its data)').toBeTruthy();
  expect(gap(rendered!, seam), 'the followed Object must render on the path').toBeLessThan(1e-3);
  // Boundary pair: the READ road (what the gizmo seeds from + the inspector shows) must
  // fold the same Follow-Path band as the RENDER road — else the Object renders on the
  // path while the gizmo sits at its authored spot (the H40 displayed≠rendered hole).
  const read = await page.evaluate(() =>
    (window as unknown as UiWindow).__basher_evaluated_transform('n_obj'),
  );
  expect(read, 'the read road must resolve the Object too (gizmo/inspector)').toBeTruthy();
  expect(gap(read!.position, seam), 'render == read for the followed Object').toBeLessThan(1e-3);
});

test('a followed LIGHT illuminates from the path (the 4th road, #343)', async ({ page }) => {
  await boot(page);
  await addPosedCurve(page);
  const seam = await seamPoint(page);
  await follow(
    page,
    [
      {
        type: 'addNode',
        nodeId: 'n_spot',
        nodeType: 'SpotLight',
        params: { position: [0, 0, 0], intensity: 1 },
      },
      {
        type: 'connect',
        from: { node: 'n_spot', socket: 'out' },
        to: { node: 'n_scene', socket: 'lights' },
      },
    ],
    'n_spot',
  );
  // The rendered light nearest the seam point IS our followed spot (the default scene's light
  // sits elsewhere). Pre-#343 no light would be near the path — the light stayed at [0,0,0].
  const lights = await page.evaluate(() =>
    (window as unknown as UiWindow).__basher_light_world_positions(),
  );
  const nearest = lights.reduce<V3 | null>(
    (best, p) => (best === null || gap(p, seam) < gap(best, seam) ? p : best),
    null,
  );
  expect(nearest, 'at least one light must be rendered').toBeTruthy();
  expect(gap(nearest!, seam), 'the followed light must render on the path').toBeLessThan(1e-3);
});

// A bodyless container (an Empty/Null, a Group) has no render body of its own — it poses its
// CHILDREN, which inherit its resolved transform. So the meaningful "where is it" is its
// evaluated transform, which is exactly what the gizmo, the inspector AND every child's world
// compose read; render == read is guaranteed because ConstrainedR (render) and
// resolveEvaluatedTransform (read/this seam) both fold the SAME resolveConstraintPosition (the
// H40 boundary pair). For a top-level container local == world, so it equals the seam point.
for (const kind of ['Null', 'Group'] as const) {
  test(`a followed ${kind} (bodyless container) lands its transform on the path`, async ({
    page,
  }) => {
    await boot(page);
    await addPosedCurve(page);
    const seam = await seamPoint(page);
    const id = `n_${kind.toLowerCase()}`;
    await follow(
      page,
      [
        { type: 'addNode', nodeId: id, nodeType: kind, params: { position: [0, 0, 0] } },
        {
          type: 'connect',
          from: { node: id, socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
      ],
      id,
    );
    const t = await page.evaluate(
      (nid) => (window as unknown as UiWindow).__basher_evaluated_transform(nid),
      id,
    );
    expect(t, `${kind} must resolve an evaluated transform`).toBeTruthy();
    expect(gap(t!.position, seam), `the ${kind} must ride the path`).toBeLessThan(1e-3);
  });
}

test('a followed glTF (its import-root Group) rides the path (#362 — glTF in the kind set)', async ({
  page,
}) => {
  // §7 Phase 2 — glTF added to the kind set. A glTF's pose lives on its import-root Group
  // (#222/V67), a bodyless container, so it follows exactly as a Group does (observed via
  // its evaluated transform, which render == read fold through the same resolveConstraintPosition).
  // Before the pose contract a glTF advertised an inert Constraints panel (#356); now the
  // real posable thing — the Group — rides the path. Phase 3 promotes it to an Object.
  await boot(page);
  await addPosedCurve(page);
  const seam = await seamPoint(page);
  await page.evaluate(async () => {
    const w = window as unknown as UiWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'follow-gltf');
  });
  // The import creates ONE Group root (V67). Wait for it, then follow it.
  const groupId = await page
    .waitForFunction(() => {
      const st = (
        window as unknown as {
          __basher_dag: { getState(): { state: { nodes: Record<string, { type: string }> } } };
        }
      ).__basher_dag.getState().state.nodes;
      return Object.entries(st).find(([, n]) => n.type === 'Group')?.[0] ?? null;
    })
    .then((h) => h.jsonValue() as Promise<string>);
  await follow(page, [], groupId);
  const t = await page.evaluate(
    (id) => (window as unknown as UiWindow).__basher_evaluated_transform(id),
    groupId,
  );
  expect(t, 'the glTF import-root Group must resolve an evaluated transform').toBeTruthy();
  expect(gap(t!.position, seam), 'the followed glTF must ride the path').toBeLessThan(1e-3);
});

test('a followed CAMERA renders on the path (camera pose road, frustum)', async ({ page }) => {
  await boot(page);
  await addPosedCurve(page);
  const seam = await seamPoint(page);
  // The default production camera n_camera is drawn as a frustum (the editor view is active),
  // and the frustum follows the evaluated pose per playhead (#240) — which includes the
  // Follow-Path position band (resolveCameraPoseAt, #339). Observe the frustum's rendered pose.
  await follow(page, [], 'n_camera');
  const pose = await page.evaluate(
    () => (window as unknown as UiWindow).__basher_frustum_pose?.['n_camera']?.position ?? null,
  );
  expect(pose, 'the camera frustum pose seam must report n_camera').toBeTruthy();
  expect(gap(pose as V3, seam), 'the camera must fly onto the path').toBeLessThan(1e-3);
});
