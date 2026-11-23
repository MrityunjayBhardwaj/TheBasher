// #1928 — on a MULTI-SLOT imported mesh, read == render for material channels.
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────────────────
//
// A multi-material glTF imports as one PolyMeshData carrying a `materialSlots[]` table. The
// renderer reads `materialSlots ?? [material]` (`dataSlotsOnly`), so on such a mesh the flat
// `material.*` field is DEAD — it is the single-slot fallback the table supersedes — and only
// `materialSlots.N.*` paints. The authoring surface offered the wrong spelling: the channel
// picker listed `material.*` (measured on a single-material import, where it IS what paints),
// so a director keying a slotted mesh's roughness saw the dopesheet move and the pixels not.
//
// ── THE BOUNDARY THIS PINS ────────────────────────────────────────────────────────────
//
// The fix is authoring-only (the picker's census now splits a slotted subject from a single
// one, #1928 Fix B); the render road already folded per slot. This guard is the render half of
// that claim, measured on the drawn three.js material so it cannot pass on inference:
//
//   · a channel on `materialSlots.N.specular.roughness` moves slot N's drawn material and only it;
//   · a channel on the dead `material.specular.roughness` moves nothing.
//
// If a later change makes the render road stop folding per slot (or start folding `material.*`
// onto a slotted mesh), this reds — and the authoring half (which spelling the picker offers)
// is pinned by the census subject split in src/app/animatableParams.test.ts +
// tests/e2e/p1235-animatable-census.spec.ts.
//
// REF: src/app/materialAssignment.ts (`dataSlotsOnly`); src/nodes/PolyMeshData.ts (the table);
//      src/app/animatableParams.ts (`animatableSubjectOf` — the subject split); issue #1928.

import { test, expect } from './_fixtures';
import { importCount, importedMeshes, drawnImportMeshes } from './_importedMesh';

interface W {
  __basher_dag: { getState: () => { dispatch: (op: unknown) => unknown } };
  __basher_time: { getState: () => { setTime: (s: number) => void; pause: () => void } };
  __basher_ingestGltfFolder: (
    files: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
    folderName: string,
  ) => Promise<string>;
}

// A constant value, distinct from the base roughness (~0.5), so "folded" and "base-only" separate.
const KEYED = 0.9;

/** Install a constant number channel on (target, paramPath), read the drawn roughnesses at the
 *  playhead, then remove the channel and return the scene to base. */
async function foldThenRead(
  page: import('@playwright/test').Page,
  rootId: string,
  targetId: string,
  paramPath: string,
): Promise<number[]> {
  const chId = `g1928_${Math.random().toString(36).slice(2, 8)}`;
  await page.evaluate(
    ({ id, t, p, v }) => {
      const w = window as unknown as W;
      w.__basher_dag.getState().dispatch({
        type: 'addNode',
        nodeId: id,
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'g1928', target: t, paramPath: p, keyframes: [{ time: 0, value: v }, { time: 2, value: v }] },
      });
      w.__basher_time.getState().pause();
      w.__basher_time.getState().setTime(1);
    },
    { id: chId, t: targetId, p: paramPath, v: KEYED },
  );
  await page.waitForTimeout(250);
  const drawn = (await drawnImportMeshes(page, rootId))
    .map((d) => d.roughness)
    .filter((r): r is number => r !== null);
  await page.evaluate((id) => {
    (window as unknown as W).__basher_dag.getState().dispatch({ type: 'removeNode', nodeId: id });
  }, chId);
  await page.waitForTimeout(150);
  return drawn;
}

test('#1928 — a multi-slot import folds per slot, and the dead `material.*` folds nothing', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(
    () => Boolean((window as unknown as W).__basher_ingestGltfFolder && (window as unknown as W).__basher_dag),
    { timeout: 20000 },
  );
  await page.evaluate(async () => {
    const w = window as unknown as W;
    const bytes = new Uint8Array(await fetch('/assets/two-material-quad.gltf').then((r) => r.arrayBuffer()));
    await w.__basher_ingestGltfFolder([{ relativePath: 'two-material-quad.gltf', bytes }], 'g1928');
  });
  await expect.poll(() => importCount(page), { timeout: 8000 }).toBeGreaterThan(0);

  const row = (await importedMeshes(page))[0];
  expect(row.slots.length, 'the fixture draws a two-slot mesh').toBe(2);

  const base = (await drawnImportMeshes(page, row.rootId))
    .map((d) => d.roughness)
    .filter((r): r is number => r !== null);
  expect(base.length, 'two drawn materials, one per slot').toBe(2);

  const slot0 = await foldThenRead(page, row.rootId, row.dataId, 'materialSlots.0.specular.roughness');
  const slot1 = await foldThenRead(page, row.rootId, row.dataId, 'materialSlots.1.specular.roughness');
  const flat = await foldThenRead(page, row.rootId, row.dataId, 'material.specular.roughness');

  // Each slot channel moves exactly one drawn material — its own — to the keyed value, and
  // leaves the other at base. (A broadcast fold, or a cross-slot fold, reds here.)
  const movedBy = (after: number[]) =>
    after.map((r, i) => (Math.abs(r - base[i]) > 1e-3 ? i : -1)).filter((i) => i >= 0);
  expect(movedBy(slot0), 'materialSlots.0 moves slot 0 alone').toEqual([0]);
  expect(movedBy(slot1), 'materialSlots.1 moves slot 1 alone').toEqual([1]);
  expect(slot0[0]).toBeCloseTo(KEYED, 3);
  expect(slot1[1]).toBeCloseTo(KEYED, 3);

  // The flat `material.*` field is the superseded single-slot fallback: it moves nothing.
  expect(movedBy(flat), '`material.*` is dead on a slotted mesh — folds nothing').toEqual([]);
});
