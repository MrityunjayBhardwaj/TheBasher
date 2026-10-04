// #222 — an imported glTF's root is selectable AND transformable: it is the single
// import root (no separate Transform node), carries its own position, and shows the
// transform gizmo when selected. Before #222 the import root was a non-transformable
// Group wrapping a nested Transform, so selecting the parent showed no gizmo.
// #1451 — and since then there is no wrapper Group at all: the root is the file's own
// node (cube-draco.glb's one Object), standing in the scene as Blender links it.
//
// THE PROOF (boundary-pair): import → the DAG gains no Group and no Transform, and the
// root the Scene holds carries a position (side A); selecting it mounts the gizmo
// (`__basher_gizmo_grab` installed) and resolveEvaluatedTransform returns a position
// (side B — exactly what makes the gizmo appear).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<
          string,
          {
            id: string;
            type: string;
            params: Record<string, unknown>;
            inputs: Record<string, unknown>;
          }
        >;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gizmo_grab?: (mode: string, target: [number, number, number]) => void;
  __basher_evaluated_transform?: (nodeId: string) => { position?: [number, number, number] } | null;
}

test('an imported glTF root is transformable + shows the gizmo', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  const census = () =>
    page.evaluate(() => {
      const { state } = (window as unknown as BasherWindow).__basher_dag.getState();
      const nodes = Object.values(state.nodes);
      const kids = state.outputs.scene ? state.nodes[state.outputs.scene.node].inputs.children : [];
      return {
        ids: nodes.map((n) => n.id),
        groups: nodes.filter((n) => n.type === 'Group').length,
        transforms: nodes.filter((n) => n.type === 'Transform').length,
        sceneKids: (Array.isArray(kids) ? kids : []).map((k) => (k as { node: string }).node),
      };
    });
  const before = await census();
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'grp-gizmo');
  });

  // Side A — the import's root stands in the scene, with no Group or Transform wrapper.
  await expect
    .poll(async () => (await census()).sceneKids.length)
    .toBe(before.sceneKids.length + 1);
  const after = await census();
  const rootId = after.sceneKids.find((id) => !before.ids.includes(id))!;
  expect(rootId).toBeTruthy();
  expect(after.groups).toBe(before.groups); // no wrapper Group (#1451)
  expect(after.transforms).toBe(before.transforms); // no separate Transform wrapper (#222)
  const root = await page.evaluate((id) => {
    const n = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes[id];
    return { type: n.type, position: n.params.position ?? null };
  }, rootId);
  expect(root.type).toBe('Object');
  expect(Array.isArray(root.position)).toBe(true);

  // Side B — selecting the root mounts the gizmo and resolves a position (the two
  // conditions that make the transform gizmo appear: getManipulable + resolver).
  await page.evaluate((id) => {
    (window as unknown as BasherWindow).__basher_selection.getState().select(id);
  }, rootId);
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_gizmo_grab),
  );
  const resolved = await page.evaluate((id) => {
    const fn = (window as unknown as BasherWindow).__basher_evaluated_transform;
    return fn ? fn(id) : null;
  }, rootId);
  expect(Array.isArray(resolved?.position)).toBe(true);
});
