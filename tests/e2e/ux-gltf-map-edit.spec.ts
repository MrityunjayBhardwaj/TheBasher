// #178 (S5) → #1396, #1397 — the inspector's map row on an IMPORTED material, which is native.
//
// ── WHAT THE ROW MUST DO ──────────────────────────────────────────────────────────────
//
// An import's material holds its textures itself, so the row has two states, as Blender's Image
// Texture does: a map that is there → *replace* or *remove* (remove writes `null`, and the texture
// stops being drawn); a map that is not → *pick*. No "imported", "cleared" or "revert".
//
// ── WHY THIS SPEC MOVED OFF THE CLONE ROAD ────────────────────────────────────────────
//
// It used to stage a clone-road import on purpose (`ingestOnCloneRoad`), and so stayed green while
// every real import — native since #1062 — had the defect: the file's own texture read
// "● replaced", and its one action, "Revert … to imported", deleted it (#1396). On an empty slot,
// "clear" wrote an empty-hash placeholder the native renderer loads as a missing file and draws
// magenta (#1397). Each case below reads the DAG value, the label AND the drawn material, because
// the defect was a label and a value that disagreed with what is drawn.
//
// REF: src/app/NPanel.tsx (`MapRow`), tests/e2e/_importedMesh.ts (the road-aware reader),
//      tests/e2e/p997-replaced-map-uv-set.spec.ts (the same fixture, and the replace road's pixels);
//      issues #1396, #1397, #178, #1053.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';
import { openInspectorSection } from './_inspectorSections';

/** 64×64 PNG (the p997 replacement) — its width identifies it once drawn. */
const PNG_64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAjUlEQVR4nO3aQQrAMBDDQK3o/7+cviGEEgSdu2HBJ8MOLMokTuIkTuIkTuIkTuIkTuIkTuIkTuIk7tkNLIYvzeY+yTcgcRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRI3/7/QZRIncRIncRIncRIncRIncRIncRLn7QNOvS62BH8fnp+WAAAAAElFTkSuQmCC';

interface W {
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

async function albedo(page: Page): Promise<{ hash?: string } | null> {
  const m = await firstMaterialMesh(page);
  return ((m?.slots[0] as { maps?: { albedo?: { hash?: string } | null } }).maps?.albedo ??
    null) as { hash?: string } | null;
}

async function drawnWidth(page: Page): Promise<number | null> {
  const all = await drawnImportMeshes(page);
  return all[0]?.hasMap ? all[0].mapWidth : null;
}

test.describe('#1396 — the map row on a native import', () => {
  test('the file’s texture reads set; remove deletes it; pick puts one back', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as W).__basher_ingestGltfFolder === 'function',
    );
    await page.evaluate(async () => {
      const buf = await fetch('/assets/two-uv-quad.gltf').then((r) => r.arrayBuffer());
      await (window as unknown as W).__basher_ingestGltfFolder(
        [{ relativePath: 'two-uv-quad.gltf', bytes: new Uint8Array(buf) }],
        'mapedit',
      );
    });
    await expect.poll(async () => (await firstMaterialMesh(page))?.dataId ?? null).not.toBeNull();
    const mesh = (await firstMaterialMesh(page))!;
    // The subject is the native road; a file that falls back to the clone reds here.
    expect(mesh.road).toBe('native');
    // The file's own 4×4 image is drawn before any premise is read.
    await expect.poll(() => drawnWidth(page)).toBe(4);
    await page.evaluate(
      (id) => (window as unknown as W).__basher_selection.getState().select(id),
      mesh.dataId,
    );
    await openInspectorSection(page, 'material');

    const id = mesh.dataId;
    const state = page.getByTestId(`inspector-map-state-${id}-albedo`);
    const pick = page.getByTestId(`inspector-map-pick-${id}-albedo`);
    const remove = page.getByTestId(`inspector-map-remove-${id}-albedo`);
    const legacy = page.locator(
      `[data-testid="inspector-map-clear-${id}-albedo"], [data-testid="inspector-map-revert-${id}-albedo"]`,
    );

    // 1. The file's texture is simply THERE: replace + remove, nothing about "imported".
    expect((await albedo(page))?.hash ?? '').not.toBe('');
    await expect(state).toHaveText('● set');
    await expect(page.getByRole('button', { name: 'Replace albedo map' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove albedo map' })).toBeVisible();
    await expect(legacy).toHaveCount(0);

    // 2. Remove → `null`, and the texture is no longer drawn. Only pick is offered.
    await remove.click();
    await expect.poll(() => albedo(page)).toBeNull();
    await expect.poll(() => drawnWidth(page)).toBeNull();
    await expect(state).toHaveText('— none');
    await expect(pick).toHaveAttribute('aria-label', 'Pick albedo map');
    await expect(remove).toHaveCount(0);
    await expect(legacy).toHaveCount(0);

    // 3. Pick → a stored ref, drawn (64 wide), and the row is back to replace + remove.
    await page.getByTestId(`inspector-map-file-${id}-albedo`).setInputFiles({
      name: 'replacement.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_64, 'base64'),
    });
    await expect.poll(async () => (await albedo(page))?.hash ?? '').not.toBe('');
    await expect.poll(() => drawnWidth(page)).toBe(64);
    await expect(state).toHaveText('● set');
    await expect(remove).toBeVisible();

    // No step on this road raised an asset error (#1397's magenta placeholder did).
    await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
  });
});
