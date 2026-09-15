// #1081 / #1098 — Apply's animated guard asks what the road it takes consumes, and the N panel
// offers exactly what dispatch accepts.
//
// ── THE TWO DEFECTS THIS PINS ───────────────────────────────────────────────────────────
//
// The guard asked the Object and its first `data` hop. On a box under an ArrayModifier that hop
// is the modifier, so a keyframed `size` on the box was invisible: the N panel offered Apply, and
// Apply baked the animation away (#1081). On stored mesh data the road writes only the mesh and
// the pose, yet a keyframe on the top operator greyed Apply out (#1098).
//
// ── WHAT IS OBSERVED, AND WHY BOTH SIDES ────────────────────────────────────────────────
//
// For each subject: the OFFER (the N panel's Apply buttons and the animated message, read off the
// rendered DOM) and the ACCEPT (the same dispatch the buttons call, and what the graph holds
// after). A guard fixed on one side only would still disagree with the other, which is the
// boundary this file exists to hold.
//
// The controls come first in each half. An un-animated box under the same modifier must still be
// offered — otherwise a guard that became blanket-true passes the refusal half. An animated pose
// on the stored mesh must still be refused — otherwise a guard that asked nothing passes the
// offered half.
//
// REF: src/app/animate/dispatchApplyTransform.ts (`applyRoadOf`, `isApplySourceAnimated`);
//      src/app/NPanel.tsx (`ApplyTransformControl`); issues #1081, #1098, #1077.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface GraphNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, { node: string } | { node: string }[]>;
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, GraphNode>; outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => unknown;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

async function openFresh(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene &&
        w.__basher_selection &&
        w.__basher_ingestGltfFolder,
      );
    },
    { timeout: 20_000 },
  );
}

async function dispatch(page: Page, ops: Op[], label: string): Promise<void> {
  await page.evaluate(
    ({ o, l }) => {
      (window as unknown as BasherWindow).__basher_dag!.getState().dispatchAtomic(o, 'e2e', l);
    },
    { o: ops, l: label },
  );
}

function keyframe(
  id: string,
  target: string,
  paramPath: string,
  type: string,
  a: unknown,
  b: unknown,
): Op {
  return {
    type: 'addNode',
    nodeId: id,
    nodeType: type,
    params: {
      name: id,
      target,
      paramPath,
      keyframes: [
        { time: 0, value: a, easing: 'linear' },
        { time: 2, value: b, easing: 'linear' },
      ],
    },
  };
}

/** What the N panel offers for `objectId`, read off the rendered controls. */
async function offer(
  page: Page,
  objectId: string,
): Promise<{ enabled: boolean; message: boolean }> {
  await page.evaluate((id) => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select(id);
  }, objectId);
  await expect(page.getByTestId('npanel-apply-transform')).toBeVisible({ timeout: 10_000 });
  return {
    enabled: await page.getByTestId('npanel-apply-all').isEnabled(),
    message: await page.getByTestId('npanel-apply-animated-msg').isVisible(),
  };
}

/** Apply through the same helper the N panel's buttons call. */
async function accept(page: Page, objectId: string): Promise<{ ok: boolean; reason?: string }> {
  return page.evaluate(async (id) => {
    const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
    return (await mod.dispatchApplyTransform(id, 'all')) as { ok: boolean; reason?: string };
  }, objectId);
}

async function nodes(page: Page): Promise<Record<string, GraphNode>> {
  return page.evaluate(
    () => (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes,
  );
}

const dataOf = (all: Record<string, GraphNode>, id: string) =>
  (all[id]?.inputs.data as { node: string } | undefined)?.node ?? null;

test('#1081 / #1098 — Apply is offered and accepted by what its road consumes', async ({
  page,
}) => {
  test.slow(); // a native import plus two roads, observed on both sides
  await openFresh(page);
  const scene = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_dag!.getState().state.outputs.scene!.node,
  );

  // ── BAKE ROAD: a box under an ArrayModifier ─────────────────────────────────────────
  const boxUnderArray = (prefix: string): Op[] => [
    { type: 'addNode', nodeId: `${prefix}_box`, nodeType: 'BoxData', params: { size: [1, 1, 1] } },
    { type: 'addNode', nodeId: `${prefix}_arr`, nodeType: 'ArrayModifier', params: { count: 2 } },
    { type: 'addNode', nodeId: `${prefix}_o`, nodeType: 'Object', params: { position: [0, 0, 0] } },
    {
      type: 'connect',
      from: { node: `${prefix}_box`, socket: 'out' },
      to: { node: `${prefix}_arr`, socket: 'target' },
    },
    {
      type: 'connect',
      from: { node: `${prefix}_arr`, socket: 'out' },
      to: { node: `${prefix}_o`, socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: `${prefix}_o`, socket: 'out' },
      to: { node: scene, socket: 'children' },
    },
  ];
  await dispatch(
    page,
    [...boxUnderArray('p1081_ctl'), ...boxUnderArray('p1081_bake')],
    'p1081 boxes',
  );
  await dispatch(
    page,
    [
      keyframe(
        'p1081_bake_kf',
        'p1081_bake_box',
        'size',
        'KeyframeChannelVec3',
        [1, 1, 1],
        [3, 1, 1],
      ),
    ],
    'p1081 animate the box under the modifier',
  );

  // Control first: nothing animated, the same stack — offered.
  expect(await offer(page, 'p1081_ctl_o'), 'un-animated box under a modifier').toEqual({
    enabled: true,
    message: false,
  });

  // #1081 — the keyframe sits on the box, BELOW the modifier. Refused on both sides.
  expect(await offer(page, 'p1081_bake_o'), 'animated size under a modifier').toEqual({
    enabled: false,
    message: true,
  });
  const baked = await accept(page, 'p1081_bake_o');
  expect(baked.ok, 'dispatch must refuse the bake').toBe(false);
  expect(baked.reason).toContain('animated');
  const afterBake = await nodes(page);
  expect(dataOf(afterBake, 'p1081_bake_o'), 'the stack is still there, nothing was baked').toBe(
    'p1081_bake_arr',
  );
  expect(afterBake['p1081_bake_kf']?.params.target, 'the animation survived').toBe(
    'p1081_bake_box',
  );

  // ── STORED-MESH ROAD: a native import under a MaterialOverrideOp ────────────────────
  //
  // The subject is a keyframed override colour, not an Array `count`: an animated count over
  // stored mesh data currently takes the editor down on its own, before Apply is ever asked
  // (filed separately), and a crash would pass or fail this file for a reason unrelated to it.
  // The override is the same #1098 cell — the top operator is keyframed and this road never
  // reads it.
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(await fetch('/assets/cube.gltf').then((r) => r.arrayBuffer()));
    await w.__basher_ingestGltfFolder!([{ relativePath: 'cube.gltf', bytes }], 'p1081-cube');
  });
  await page.waitForFunction(
    () =>
      Object.values((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes).some(
        (n) => n.type === 'PolyMeshData',
      ),
    undefined,
    { timeout: 20_000 },
  );
  const imported = await nodes(page);
  const meshId = Object.values(imported).find((n) => n.type === 'PolyMeshData')!.id;
  const objectId = Object.values(imported).find(
    (n) => n.type === 'Object' && dataOf(imported, n.id) === meshId,
  )!.id;

  await dispatch(
    page,
    [
      {
        type: 'disconnect',
        from: { node: meshId, socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
      {
        type: 'addNode',
        nodeId: 'p1081_mesh_ovr',
        nodeType: 'MaterialOverrideOp',
        params: {},
      },
      {
        type: 'connect',
        from: { node: meshId, socket: 'out' },
        to: { node: 'p1081_mesh_ovr', socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: 'p1081_mesh_ovr', socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
      keyframe(
        'p1081_mesh_kf',
        'p1081_mesh_ovr',
        'color',
        'KeyframeChannelColor',
        '#ff0000',
        '#00ff00',
      ),
    ],
    'p1081 animate an operator on stored mesh data',
  );

  // #1098 — the keyframe is on the TOP operator, which this road never reads. Offered and accepted.
  expect(await offer(page, objectId), 'animated operator over stored mesh data').toEqual({
    enabled: true,
    message: false,
  });
  const applied = await accept(page, objectId);
  expect(applied, 'dispatch must apply into the mesh').toEqual({ ok: true, bakedId: objectId });
  const afterApply = await nodes(page);
  expect(dataOf(afterApply, objectId), 'the operator still sits on the Object').toBe(
    'p1081_mesh_ovr',
  );
  expect(afterApply[meshId]?.type, 'still stored mesh data, not a bake').toBe('PolyMeshData');
  expect(
    Object.values(afterApply).filter((n) => n.type === 'BakedData'),
    'no bake was minted',
  ).toEqual([]);
  expect(afterApply['p1081_mesh_kf']?.params.target, 'the operator animation is still live').toBe(
    'p1081_mesh_ovr',
  );

  // Control last: the pose IS written on this road, so an animated pose still refuses.
  await dispatch(
    page,
    [keyframe('p1081_pose_kf', objectId, 'position', 'KeyframeChannelVec3', [0, 0, 0], [3, 0, 0])],
    'p1081 animate the pose',
  );
  expect(await offer(page, objectId), 'animated pose over stored mesh data').toEqual({
    enabled: false,
    message: true,
  });
});
