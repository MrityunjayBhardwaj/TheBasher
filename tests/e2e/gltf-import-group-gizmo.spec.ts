// #222 — an imported glTF's parent GROUP is selectable AND transformable: it is
// the single import root (no separate Transform node), carries position + a
// bbox-centre pivot, and shows the transform gizmo when selected. Before #222 the
// import root was a non-transformable Group wrapping a nested Transform, so
// selecting the parent showed no gizmo.
//
// THE PROOF (boundary-pair): import → the DAG has ONE Group import root with
// position/pivot params and NO Transform wrapper (side A); selecting it mounts the
// gizmo (`__basher_gizmo_grab` installed) and resolveEvaluatedTransform returns a
// position (side B — exactly what makes the gizmo appear).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
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

test('imported glTF parent group is transformable + shows the gizmo', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'grp-gizmo');
  });

  // Side A — the import created ONE transformable Group root, no Transform wrapper.
  const dag = await page.evaluate(() => {
    const nodes = Object.values(
      (window as unknown as BasherWindow).__basher_dag.getState().state.nodes,
    );
    const groups = nodes.filter((n) => n.type === 'Group');
    const transforms = nodes.filter((n) => n.type === 'Transform');
    const grp = groups[0];
    return {
      groupCount: groups.length,
      transformCount: transforms.length,
      groupId: grp?.id ?? null,
      position: grp?.params.position ?? null,
      pivot: grp?.params.pivot ?? null,
    };
  });
  expect(dag.groupId).toBeTruthy();
  expect(dag.transformCount).toBe(0); // no separate Transform wrapper (#222)
  expect(Array.isArray(dag.position)).toBe(true);
  expect(Array.isArray(dag.pivot)).toBe(true);

  // Side B — selecting the group mounts the gizmo and resolves a position (the two
  // conditions that make the transform gizmo appear: getManipulable + resolver).
  await page.evaluate((id) => {
    (window as unknown as BasherWindow).__basher_selection.getState().select(id);
  }, dag.groupId);
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_gizmo_grab),
  );
  const resolved = await page.evaluate((id) => {
    const fn = (window as unknown as BasherWindow).__basher_evaluated_transform;
    return fn ? fn(id) : null;
  }, dag.groupId);
  expect(Array.isArray(resolved?.position)).toBe(true);
});
