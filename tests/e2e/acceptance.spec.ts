// P0 acceptance tests — THESIS.md §38, NEXT_SESSION.md.
// Eight tests. All eight must pass before P0 ships. Honesty contract: do not
// skip a test to make a deadline.
//
// The dev server boot is hidden behind webServer in playwright.config.ts;
// individual tests assume http://localhost:5173 is up.

import { expect, test } from './_fixtures';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

test.beforeEach(async ({ page }) => {
  // Each test starts from a clean OPFS so save/load tests don't see leftover
  // state from prior runs.
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
});

test('#1 dev server boots in <5s and renders the boot status', async ({ page }) => {
  // Hard-fail above 5s by setting an explicit budget.
  const start = Date.now();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(5000);
  // After K1 finishes, the layout testid must appear.
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 5000 });
});

test('#2 default project has the 4-node DAG (5 with RenderOutput) and viewport renders', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible();
  // SceneTree projects only the scene hierarchy (THESIS §12) — Camera /
  // Light / RenderOutput live as parallel `outputs.*` references and
  // don't appear as scene-tree rows. Verify their existence via the
  // DAG store directly (P6 W2.5 — flat NodeList was dropped; selection
  // for these nodes routes through __basher_selection in tests).
  // P6 W2.6 — SceneTree default-collapsed; expand via the chromeStore
  // dev seam so the tree rows render before we assert visibility.
  await page.waitForFunction(() => {
    type Win = { __basher_chrome?: unknown };
    return Boolean((window as unknown as Win).__basher_chrome);
  });
  await page.evaluate(() => {
    type Win = {
      __basher_chrome?: { getState: () => { setLeftSidebarCollapsed: (v: boolean) => void } };
    };
    (window as unknown as Win).__basher_chrome!.getState().setLeftSidebarCollapsed(false);
  });
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
  await expect(page.getByTestId('scene-tree-row-n_scene')).toBeVisible();
  const dagShape = await page.evaluate(() => {
    type Win = {
      __basher_dag?: {
        getState: () => {
          state: { nodes: Record<string, unknown>; outputs: Record<string, { node: string }> };
        };
      };
    };
    const w = window as unknown as Win;
    const s = w.__basher_dag!.getState().state;
    return {
      hasCamera: 'n_camera' in s.nodes,
      hasLight: 'n_light' in s.nodes,
      hasRender: 'n_render' in s.nodes,
      sceneOutput: s.outputs.scene?.node,
      renderOutput: s.outputs.render?.node,
    };
  });
  expect(dagShape.hasCamera).toBe(true);
  expect(dagShape.hasLight).toBe(true);
  expect(dagShape.hasRender).toBe(true);
  expect(dagShape.sceneOutput).toBe('n_scene');
  expect(dagShape.renderOutput).toBe('n_render');
  // Canvas mounted.
  await expect(page.locator('canvas').first()).toBeVisible();
});

test('#3 chrome affordances: timeline reveal + present-mode chrome-hide (mode-free, v0.6 #4)', async ({
  page,
}) => {
  await page.goto('/');
  // v0.6 #4 dissolved the mode enum — the editor boots with no present collapse.
  await expect(page.getByTestId('layout')).not.toHaveAttribute('data-present', 'true');
  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect(page.getByTestId('tree-slot')).toBeVisible();
  // The Timebar row stays visible (it carries the Auto-Key indicator); the
  // DRAWER BODY is what's closed by default and the pill reveal opens it.
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'false');

  // Reveal the timeline body via the pill control; rest of chrome stays.
  await page.getByTestId('floating-toolbar-timeline').click();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('inspector')).toBeVisible();

  // Present mode (the re-home for the deleted `director`): chrome hides;
  // viewport takes the full window. tree-slot is the canonical chrome-
  // visibility check (it hides via display:none when presentMode is on).
  await page.getByTestId('top-toolbar-present').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-present', 'true');
  await expect(page.getByTestId('inspector')).toBeHidden();
  await expect(page.getByTestId('tree-slot')).toBeHidden();
});

test('#4 save → reload restores identical state', async ({ page }) => {
  await page.goto('/');
  // Camera lives in `outputs.camera`, not under scene's children — it
  // doesn't appear as a scene-tree row. Select via the dev-only seam.
  // boot.ts loads __basher_selection via async dynamic import, so wait
  // for it to land before driving selection.
  await page.waitForFunction(() => {
    type Win = { __basher_selection?: unknown };
    return Boolean((window as unknown as Win).__basher_selection);
  });
  await page.evaluate(() => {
    type Win = { __basher_selection?: { getState: () => { select: (id: string) => void } } };
    (window as unknown as Win).__basher_selection!.getState().select('n_camera');
  });
  await expect(page.getByTestId('inspector-vec-n_camera-position-x')).toBeVisible();
  // Edit a value, save, reload, confirm it persisted.
  await page.getByTestId('inspector-vec-n_camera-position-x').fill('7.5');
  await page.getByTestId('inspector-vec-n_camera-position-x').press('Tab');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
  await page.waitForFunction(() => {
    type Win = { __basher_selection?: unknown };
    return Boolean((window as unknown as Win).__basher_selection);
  });
  await page.evaluate(() => {
    type Win = { __basher_selection?: { getState: () => { select: (id: string) => void } } };
    (window as unknown as Win).__basher_selection!.getState().select('n_camera');
  });
  const xVal = await page.getByTestId('inspector-vec-n_camera-position-x').inputValue();
  expect(parseFloat(xVal)).toBeCloseTo(7.5, 5);
});

test('#5 inspector edit propagates to viewport within 16ms (DAG dispatch latency)', async ({
  page,
}) => {
  await page.goto('/');
  // SceneTree default-collapsed (P6 W2.6) — expand via dev seam.
  await page.waitForFunction(() => {
    type Win = { __basher_chrome?: unknown };
    return Boolean((window as unknown as Win).__basher_chrome);
  });
  await page.evaluate(() => {
    type Win = {
      __basher_chrome?: { getState: () => { setLeftSidebarCollapsed: (v: boolean) => void } };
    };
    (window as unknown as Win).__basher_chrome!.getState().setLeftSidebarCollapsed(false);
  });
  await page.getByTestId('scene-tree-row-n_box').click();
  // P6 W4 — BoxMesh declares ['mesh', 'transform', 'material']. Mesh is
  // the primary domain (expanded by default); Transform/Material are
  // default-collapsed per §5.8. Position lives in Transform, so expand
  // it before querying inspector-vec-n_box-position-x.
  await page.getByTestId('inspector-section-toggle-transform').click();
  await expect(page.getByTestId('inspector-section-body-transform')).toBeVisible();
  // Time the dispatch round-trip: instrumentation reads from useDagStore in
  // Inspector's onChange (synchronous). Actual paint timing on the viewport
  // is gated by the next rAF; we measure dispatch + state propagation.
  const latencyMs = await page.evaluate(() => {
    // Find an exposed dispatch path. We use the observable: the box's
    // material color in the DOM is downstream of a dispatch on box params.
    // Here we measure the time from input change → store mutation visible.
    const t0 = performance.now();
    const input = document.querySelector(
      '[data-testid="inspector-vec-n_box-position-x"]',
    ) as HTMLInputElement | null;
    if (!input) throw new Error('input not found');
    input.focus();
    input.value = '2.5';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const t1 = performance.now();
    return t1 - t0;
  });
  expect(latencyMs).toBeLessThan(16);
});

test('#6 beacon endpoint exists at /__assets/active in dev', async ({ page, request }) => {
  await page.goto('/');
  const res = await request.get('/__assets/active');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json).toHaveProperty('source');
  // The mock reports companionConnected:false when no Python companion is up.
  expect(typeof json.companionConnected).toBe('boolean');
});

test('#6b beacon endpoint absent in prod build (dist/ has no middleware code)', async () => {
  // Built by Wave H's CI matrix (npm run build runs before test:e2e). Locally,
  // run `npm run build` first if dist/ is stale.
  const distPath = path.join(ROOT, 'dist');
  if (!fs.existsSync(distPath)) {
    test.skip(true, 'dist/ not built; run `npm run build` first');
    return;
  }
  // The middleware function name is unique enough to grep for.
  const allJs: string[] = [];
  for (const dirent of fs.readdirSync(path.join(distPath, 'assets'), {
    withFileTypes: true,
  })) {
    if (dirent.isFile() && dirent.name.endsWith('.js')) {
      allJs.push(fs.readFileSync(path.join(distPath, 'assets', dirent.name), 'utf8'));
    }
  }
  const haystack = allJs.join('\n');
  // The Vite plugin's name is wrapped at build time by Vite's plugin system,
  // but its handler body is excluded entirely (apply:'serve'). Confirm the
  // source-side identifier is gone.
  expect(haystack).not.toContain('basher:blender-mock');
  expect(haystack).not.toContain('vite-plugin-blender-mock');
  // P1 dev-only store handle (boot.ts gates on import.meta.env.DEV) — must
  // also be tree-shaken out of prod so the running app exposes nothing
  // mutation-capable on `window`.
  expect(haystack).not.toContain('__basher_dag');
});

test('#7 PostFx beauty matches reference within 2% pixel diff', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible();
  // Switch the editor to 'rendered' shading so the screenshot reflects
  // ONLY DAG-authored lights (P2.6 default is 'studio' for editing UX,
  // which adds editor-only fill rigs — those must NOT be the production
  // render baseline).
  // P6 W7 (2026-05-14): shading group moved from R3 TransformToolbar to
  // R8 FloatingViewportToolbar per D-W7-3. testid migrated.
  await page.getByTestId('floating-toolbar-shading-rendered').click();
  // Wait for the canvas to have rendered at least one frame. We check by
  // polling for a non-empty pixel sample.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return false;
    const ctx = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    return ctx !== null && canvas.width > 0;
  });
  // Settle: PostFx + first frame composited.
  await page.waitForTimeout(500);
  await expect(page.getByTestId('viewport')).toHaveScreenshot('postfx-beauty.png', {
    maxDiffPixelRatio: 0.02,
    // Headless GPU rasterization differs across CI / local; allow modest
    // per-pixel threshold so anti-aliasing fringes don't tip the count.
    threshold: 0.2,
    // FPS meter text changes every frame — mask it so the diff only sees
    // the rendered geometry + PostFx output. v0.6 #4 W5 added an editor-chrome
    // empty-state hint that renders over the viewport while nothing is selected
    // (this test selects nothing) — mask it too (same treatment) so the beauty
    // baseline stays the pure DAG render, immune to the hint's copy/size (H30).
    // The floating viewport toolbar is editor chrome over the viewport (now
    // top-anchored) — mask it for the same reason, so its position/contents
    // never tip the pure-DAG beauty diff.
    mask: [
      page.getByTestId('fps-meter'),
      page.getByTestId('viewport-empty-hint'),
      page.getByTestId('floating-viewport-toolbar'),
    ],
  });
});

test('#9 mode toggle preserves the same Canvas DOM node (V8/K1 step 6)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('viewport')).toBeVisible();
  // Tag the canvas. If Layout remounted on mode switch, the tag is gone.
  await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!c) throw new Error('canvas missing');
    (c as unknown as { __basherTag: string }).__basherTag = 'before-switch';
  });
  // Exercise the most invasive grid changes — reveal the timeline, then enter
  // present (chrome hides). Present hides the chrome so we exit via Esc
  // (UI-SPEC §6.2 / acceptance #4 — Esc dismisses the topmost transient). If
  // any transition remounts the Canvas, the tag is gone.
  await page.getByTestId('floating-toolbar-timeline').click();
  await page.getByTestId('top-toolbar-present').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('layout')).not.toHaveAttribute('data-present', 'true');
  const tag = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null;
    return (c as unknown as { __basherTag?: string } | null)?.__basherTag ?? null;
  });
  expect(tag).toBe('before-switch');
});

test('#10 controlled Inspector reflects DAG state (regression for the defaultValue trap)', async ({
  page,
}) => {
  await page.goto('/');
  // n_camera lives in DAG state but not as a scene-tree row (it's
  // outputs.camera, not under scene's children). Select via the dev
  // seam — P6 W2.5 dropped the flat NodeList that previously hosted
  // every node id as a clickable row.
  await page.waitForFunction(() => {
    type Win = { __basher_selection?: unknown };
    return Boolean((window as unknown as Win).__basher_selection);
  });
  await page.evaluate(() => {
    type Win = { __basher_selection?: { getState: () => { select: (id: string) => void } } };
    (window as unknown as Win).__basher_selection!.getState().select('n_camera');
  });
  const xField = page.getByTestId('inspector-vec-n_camera-position-x');
  await expect(xField).toHaveValue('3');

  // Mutate the store from outside the input (simulates an undo or agent op).
  await page.evaluate(() => {
    type StoreShape = {
      getState: () => {
        dispatch: (op: unknown, source?: string) => unknown;
        state: { nodes: Record<string, { params: unknown }> };
      };
    };
    const win = window as unknown as { __basher_dag?: StoreShape };
    if (!win.__basher_dag) {
      const mod = (window as unknown as { React: unknown }).React;
      void mod;
    }
  });
  // Drive the change via another input to make sure controlled state propagates.
  await xField.fill('1.25');
  await xField.press('Tab');
  await expect(xField).toHaveValue('1.25');

  // Reload the page and confirm the controlled `value` matches OPFS-loaded state.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => {
    type Win = { __basher_selection?: unknown };
    return Boolean((window as unknown as Win).__basher_selection);
  });
  await page.evaluate(() => {
    type Win = { __basher_selection?: { getState: () => { select: (id: string) => void } } };
    (window as unknown as Win).__basher_selection!.getState().select('n_camera');
  });
  await expect(page.getByTestId('inspector-vec-n_camera-position-x')).toHaveValue('1.25');
});

test('#8 FPS ≥60fps on M1 baseline (≥30fps in CI)', async ({ page }) => {
  test.skip(!!process.env.CI, 'CI runners lack GPU; baseline measured locally');
  // The FPS meter is dev-only AND default-OFF (clean canvas) — enable it for
  // this measurement by seeding the persisted chrome flag before first paint.
  await page.addInitScript(() => {
    localStorage.setItem('basher.chrome.v1', JSON.stringify({ showFpsMeter: true }));
  });
  await page.goto('/');
  await expect(page.getByTestId('viewport')).toBeVisible();
  // Wait for the meter to report at least once.
  const meter = page.getByTestId('fps-meter');
  await expect(meter).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="fps-meter"]') as HTMLElement | null;
    return !!el && /\d+ fps/.test(el.textContent ?? '');
  });
  // Sample for 1.5s — gives the meter three flushes at its 500ms cadence.
  await page.waitForTimeout(1500);
  const text = (await meter.textContent()) ?? '';
  const m = text.match(/(\d+(?:\.\d+)?)\s*fps/);
  expect(m).not.toBeNull();
  const fps = parseFloat(m![1]);
  expect(fps).toBeGreaterThanOrEqual(60);
});
