// P6 W4 (v0.6 #4) — Spline-style HOME surface + first-run boot routing.
//
// Proves the home/editor split end-to-end on a CLEAN store:
//   #1 true first run (no lastProjectId) → HOME, editor NOT mounted, and the
//      key is STILL absent afterwards (catches the boot.ts persist-on-boot trap
//      — without the guard the home would show for exactly one boot).
//   #2 the seeded example(s) appear under the Examples section.
//   #3 opening an example mounts the editor on a REAL Op-built DAG with exactly
//      ONE canvas (single-canvas invariant) and persists the opened id.
//   #4 back-to-home from the editor unmounts the editor tree (canvas torn down).
//   #5 a persisted lastProjectId resumes the EDITOR (the resume contract holds —
//      returning users are NOT hijacked onto the home).
//   #6 a stale/unloadable lastProjectId clears the key and lands HOME.
//
// The shared fixture seeds lastProjectId='default' (so ordinary editor specs
// resume); each test here registers a LATER init script to set the exact
// first-run / resume / stale state it needs (per-test wins — see _fixtures.ts).
//
// REF: .planning/phases/v06.4-director-ux/PLAN.md WAVE W4; CONTEXT D-08/D-09/
//      D-W4-ROUTE/D-W4-SEED; src/app/{Home,App,boot}.tsx, stores/routeStore.ts.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
}

const KEY = 'basher.lastProjectId';

/** Register the desired lastProjectId state, then load the app. */
async function bootWithLastId(page: Page, value: string | null): Promise<void> {
  await page.addInitScript(
    ({ k, v }) => {
      try {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        /* storage disabled */
      }
    },
    { k: KEY, v: value },
  );
  await page.goto('/');
}

function lastIdOf(page: Page): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), KEY);
}

test('P6-W4#1 first run (no lastProjectId) → HOME, no editor canvas, key stays absent', async ({
  page,
}) => {
  await bootWithLastId(page, null);
  await expect(page.getByTestId('home-view')).toBeVisible();
  // Editor tree (and its R3F canvas) must NOT be mounted on the home.
  await expect(page.getByTestId('viewport')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  // The persist-on-boot trap guard: landing on home must NOT have written the key.
  expect(await lastIdOf(page)).toBeNull();
});

test('P6-W4#2 the gallery shows the seeded example(s) under Examples', async ({ page }) => {
  await bootWithLastId(page, null);
  await expect(page.getByTestId('home-view')).toBeVisible();
  await expect(page.getByTestId('home-example-card').first()).toBeVisible();
});

test('P6-W4#3 opening an example mounts the editor on a real DAG (ONE canvas) + persists the id', async ({
  page,
}) => {
  await bootWithLastId(page, null);
  await expect(page.getByTestId('home-view')).toBeVisible();
  await page.getByTestId('home-open-example_starter').click();
  // Editor mounted, exactly one viewport canvas (single-canvas invariant).
  await expect(page.getByTestId('layout')).toBeVisible();
  await expect(page.getByTestId('viewport').locator('canvas')).toHaveCount(1);
  // The opened example is a real Op-built DAG (V34), not a static blob.
  const nodeCount = await page.evaluate(
    () =>
      Object.keys((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes).length,
  );
  expect(nodeCount).toBeGreaterThanOrEqual(5);
  // Opening persisted the resume target.
  expect(await lastIdOf(page)).toBe('example_starter');
});

test('P6-W4#4 back-to-home from the editor unmounts the editor tree', async ({ page }) => {
  await bootWithLastId(page, null);
  await page.getByTestId('home-open-example_starter').click();
  await expect(page.getByTestId('layout')).toBeVisible();
  await page.getByTestId('editor-home-button').click();
  await expect(page.getByTestId('home-view')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('P6-W4#5 a persisted lastProjectId resumes the EDITOR (resume contract holds)', async ({
  page,
}) => {
  await bootWithLastId(page, 'default');
  await expect(page.getByTestId('layout')).toBeVisible();
  await expect(page.getByTestId('home-view')).toHaveCount(0);
  await expect(page.getByTestId('viewport').locator('canvas')).toHaveCount(1);
});

test('P6-W4#6 a stale/unloadable lastProjectId clears the key and lands HOME', async ({ page }) => {
  await bootWithLastId(page, 'proj_does_not_exist_xyz');
  await expect(page.getByTestId('home-view')).toBeVisible();
  expect(await lastIdOf(page)).toBeNull();
});
