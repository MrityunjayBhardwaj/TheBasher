// UX #9 slice 2 — scene-level environment (HDRI/IBL) from an imported .hdr.
//
// Observes the WHOLE file pipeline on the LIVE app (Lokayata, not inference):
//   import .hdr bytes → OPFS (content-hash store) → set the Scene's envSource to
//   {kind:'file', assetRef} → the renderer's drei <Environment map> assigns the
//   decoded equirect texture to `scene.environment` (a scene PROPERTY, never a
//   traversed object — vyapti V47).
//
// FALSIFICATION (guards a vacuous pass):
//   - BEFORE: scene.environment is null (the default `none`).
//   - AFTER file source: scene.environment is a non-null Texture; with the
//     background toggle on, scene.background is non-null too.
//   - CLEAR back to `none`: scene.environment AND scene.background return to
//     null — proves the binding is driven by the param, not a one-way latch.
//
// Uses the .hdr fixture at public/fixtures/env/test.hdr (a tiny flat-RGBE map).
//
// REF: src/viewport/SceneEnvironment.tsx; src/app/asset/envHdriStore.ts; V47.

import { expect, test } from './_fixtures';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface EnvWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { params?: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_three: {
    getState: () => {
      scene: {
        environment: { isTexture?: boolean } | null;
        background: { isTexture?: boolean } | null;
        environmentIntensity?: number;
      } | null;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_importEnvHdri?: (bytes: Uint8Array, filename: string) => Promise<string>;
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
  __basher_export_scene_bundle?: () => Promise<{
    bundle: { assets?: Record<string, string> };
    missingAssets: string[];
  }>;
}

// `env` = scene.environment is bound (only an env source sets it — default null).
// `bg` (skybox) = scene.background is the env TEXTURE; the editor's default dark
// stage is a Color (`#0a0a0a`), so we test `isTexture` to tell a skybox from it.

/** Read the live scene's env/background binding state. */
async function readEnv(
  page: import('@playwright/test').Page,
): Promise<{ env: boolean; bg: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as EnvWindow;
    const s = w.__basher_three.getState().scene;
    return {
      env: Boolean(s && s.environment),
      bg: Boolean(s && s.background && s.background.isTexture),
    };
  });
}

/** Wait until the scene env binding matches `want`. */
async function waitEnv(
  page: import('@playwright/test').Page,
  want: { env: boolean; bg: boolean },
): Promise<void> {
  await page.waitForFunction(
    (w2) => {
      const w = window as unknown as EnvWindow;
      const s = w.__basher_three.getState().scene;
      const env = Boolean(s && s.environment);
      const bg = Boolean(s && s.background && s.background.isTexture);
      return env === w2.env && bg === w2.bg;
    },
    want,
    { timeout: 15_000 },
  );
}

test.beforeEach(async ({ page }) => {
  // '/' lands on EITHER the home page (fresh state) or the editor (persisted
  // route). Enter the editor deterministically: race the two possible first
  // screens, and if it's home, open the Starter Scene example (it has n_scene).
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) {
    await starter.click();
  }
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as EnvWindow;
    return Boolean(
      w.__basher_dag &&
      w.__basher_three &&
      w.__basher_importEnvHdri &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('UX #9 — an imported .hdr lights the scene via scene.environment, and clears', async ({
  page,
}) => {
  // BEFORE — no environment (default `none`).
  expect(await readEnv(page)).toEqual({ env: false, bg: false });

  // Import the fixture HDRI to OPFS and bind it as the Scene env (with skybox).
  await page.evaluate(async () => {
    const w = window as unknown as EnvWindow;
    const bytes = new Uint8Array(
      await fetch('/fixtures/env/test.hdr').then((r) => r.arrayBuffer()),
    );
    const assetRef = await w.__basher_importEnvHdri!(bytes, 'test.hdr');
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: sceneId,
          paramPath: 'envSource',
          value: { kind: 'file', assetRef },
        },
        { type: 'setParam', nodeId: sceneId, paramPath: 'envBackground', value: true },
      ],
      'e2e',
      'set env file',
    );
  });

  // AFTER — the equirect texture is bound to scene.environment + scene.background.
  await waitEnv(page, { env: true, bg: true });
  expect(await readEnv(page)).toEqual({ env: true, bg: true });

  // CLEAR — set the source back to `none`; both bindings release (falsification:
  // proves the binding tracks the param, not a one-way latch).
  await page.evaluate(() => {
    const w = window as unknown as EnvWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [{ type: 'setParam', nodeId: sceneId, paramPath: 'envSource', value: { kind: 'none' } }],
      'e2e',
      'clear env',
    );
  });
  await waitEnv(page, { env: false, bg: false });
  expect(await readEnv(page)).toEqual({ env: false, bg: false });
});

test('UX #9 — the Scene inspector Environment control imports an .hdr and binds it', async ({
  page,
}) => {
  // Select the Scene node so the inspector shows its Environment section.
  const sceneId = await page.evaluate(() => {
    const w = window as unknown as EnvWindow;
    const id = w.__basher_dag.getState().state.outputs.scene!.node;
    w.__basher_selection!.getState().select(id);
    return id;
  });

  // The Environment section + its custom control render for the Scene node.
  await expect(page.getByTestId(`inspector-environment-${sceneId}`)).toBeVisible({
    timeout: 10_000,
  });
  // Default source = none → mode buttons present, no file bound yet.
  expect(await readEnv(page)).toEqual({ env: false, bg: false });

  // Drive the inspector's Import path directly: set the (always-mounted) hidden
  // file input to the fixture .hdr — the real onChange → importEnvironmentHdri →
  // setParam wiring. (We set the input directly rather than clicking the File
  // mode button, which would pop a native file chooser and hang the run.)
  await page
    .getByTestId(`inspector-env-file-${sceneId}`)
    .setInputFiles('public/fixtures/env/test.hdr');

  // The env param is now a file source, the inspector shows the file name, and
  // the equirect texture is bound to scene.environment.
  await waitEnv(page, { env: true, bg: false });
  await expect(page.getByTestId(`inspector-env-file-name-${sceneId}`)).toHaveText('test.hdr');
  const src = await page.evaluate((id) => {
    const w = window as unknown as EnvWindow;
    return w.__basher_dag.getState().state.nodes[id].params?.envSource as { kind?: string };
  }, sceneId);
  expect(src.kind).toBe('file');

  // Toggle "show as background" → scene.background becomes the env texture.
  await page.getByTestId(`inspector-env-background-${sceneId}`).check();
  await waitEnv(page, { env: true, bg: true });

  // Edit intensity → it flows to scene.environmentIntensity.
  await page.getByTestId(`inspector-env-intensity-${sceneId}`).fill('2.5');
  await page.waitForFunction(
    () => {
      const w = window as unknown as EnvWindow;
      return w.__basher_three.getState().scene?.environmentIntensity === 2.5;
    },
    null,
    { timeout: 10_000 },
  );
});

test('UX #9 — the environment flows into the offscreen render (V47 parity)', async ({ page }) => {
  // Bind a file env source.
  await page.evaluate(async () => {
    const w = window as unknown as EnvWindow;
    const bytes = new Uint8Array(
      await fetch('/fixtures/env/test.hdr').then((r) => r.arrayBuffer()),
    );
    const assetRef = await w.__basher_importEnvHdri!(bytes, 'test.hdr');
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: sceneId,
          paramPath: 'envSource',
          value: { kind: 'file', assetRef },
        },
      ],
      'e2e',
      'set env file',
    );
  });
  await waitEnv(page, { env: true, bg: false });

  // renderToImage reuses the LIVE scene; `scene.environment` is a PROPERTY, not a
  // traversed object, so the editorChrome hide-pass never touches it. The render
  // therefore succeeds WITH the env, and the env is still bound afterwards (the
  // hide-pass restores visibility but cannot affect a scene property).
  const out = await page.evaluate(() => {
    const w = window as unknown as EnvWindow;
    return w.__basher_render_png!();
  });
  expect(out).not.toBeNull();
  expect(out!.dataUrl.startsWith('data:image/png')).toBe(true);
  // Env survives the render — proves it was NOT hidden as chrome (V47 inverse).
  expect(await readEnv(page)).toEqual({ env: true, bg: false });
});

test('UX #9 — an imported HDRI embeds in the .basher bundle (V41 self-contained)', async ({
  page,
}) => {
  // Import + bind a file env source, capturing its assetRef.
  const assetRef = await page.evaluate(async () => {
    const w = window as unknown as EnvWindow;
    const bytes = new Uint8Array(
      await fetch('/fixtures/env/test.hdr').then((r) => r.arrayBuffer()),
    );
    const ref = await w.__basher_importEnvHdri!(bytes, 'test.hdr');
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: sceneId,
          paramPath: 'envSource',
          value: { kind: 'file', assetRef: ref },
        },
      ],
      'e2e',
      'set env file',
    );
    return ref;
  });
  await waitEnv(page, { env: true, bg: false });

  // The real bundle builder (collectAssetRefs → resolveAssetFiles → embed) must
  // carry the HDRI bytes — so the .basher opens identically on another machine.
  const out = await page.evaluate(() => {
    const w = window as unknown as EnvWindow;
    return w.__basher_export_scene_bundle!();
  });
  expect(out.missingAssets).toEqual([]);
  expect(out.bundle.assets).toBeTruthy();
  expect(Object.keys(out.bundle.assets!)).toContain(assetRef);
  expect((out.bundle.assets![assetRef] ?? '').length).toBeGreaterThan(0);
});
