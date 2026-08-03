// #168 — Render to image: produce & download a final PNG.
//
// These tests OBSERVE the REAL render (Lokayata), not the DAG or inferred
// state: the actual decoded pixels of the offscreen render, and a real
// browser download event. Each behavioral assertion is FALSIFIABLE — reverting
// the feature makes it fail (noted per assertion).
//
// The default project = green cube (#5af07a) lit by one DirectionalLight,
// framed by the PerspectiveCamera at [3,2,3]→origin, RenderOutput 1920×1080.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_dag?: { getState: () => { state: { nodes: Record<string, unknown> } } };
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_render_png),
  );
  await page.waitForTimeout(400); // let the first frame paint
}

/** Render via the DEV seam and decode the PNG, sampling pixels in-page. */
async function renderAndSample(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const out = await (window as unknown as BasherWindow).__basher_render_png!();
    if (!out) return null;
    const img = new Image();
    await new Promise((r) => {
      img.onload = r;
      img.src = out.dataUrl;
    });
    const cv = document.createElement('canvas');
    cv.width = out.width;
    cv.height = out.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const at = (x: number, y: number) => {
      const p = ctx.getImageData(x, y, 1, 1).data;
      return [p[0], p[1], p[2], p[3]] as [number, number, number, number];
    };
    // The background reference is the actual corner pixel, NOT a hardcoded
    // colour — the dark redesign moved the ambient stage from ~[10,10,10] to
    // [26,27,32], so a literal made every pixel read "non-bg" (the H27/V39
    // re-validation trap). Chrome leak = DEVIATION from the true background.
    const bg = at(2, 2);
    const isNonBg = (x: number, y: number) => {
      const [r, g, b] = at(x, y);
      return Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24;
    };
    // Dense sample of the bottom-LEFT quadrant — cube-free, and where the floor
    // grid used to be densest. This counted ~221 leaked grid pixels when it was
    // written (Wave D); re-measured 2026-08-04 it reads 93 with the hide-pass call
    // site neutralised and 0 with the flag clause dropped, because that clause also
    // reframes the editor view and the grid is camera-relative (#557). Kept as the
    // call-site witness; the per-clause witnesses do not depend on this region.
    let chromeRegionNonBg = 0;
    for (let y = Math.floor(out.height * 0.55); y < out.height * 0.98; y += 4) {
      for (let x = Math.floor(out.width * 0.02); x < out.width * 0.3; x += 4) {
        if (isNonBg(x, y)) chromeRegionNonBg++;
      }
    }
    // Saturation counts, deliberately ABSOLUTE rather than measured against the
    // `bg` reference above. Every DAG object in this fixture is neutral (a grey
    // cube on a near-grey stage), while editor chrome is not: the gizmo draws
    // saturated R/G/B axes and the planted occluder below is magenta. Measured on
    // a clean render: 0 saturated pixels in the whole frame.
    //
    // Absolute matters. `bg` is sampled at (2,2), and a chrome leak can COVER that
    // pixel — which is how the first probe for #557 reported a leak four times the
    // real one: the reference itself had been contaminated, so true background read
    // as deviation everywhere. A count that never consults the reference cannot be
    // fooled that way.
    let saturated = 0;
    let magenta = 0;
    for (let y = 0; y < out.height; y += 4) {
      for (let x = 0; x < out.width; x += 4) {
        const [r, g, b] = at(x, y);
        if (Math.max(r, g, b) - Math.min(r, g, b) > 40 && Math.max(r, g, b) > 60) saturated++;
        if (r > 90 && b > 90 && g < r - 40 && g < b - 40) magenta++;
      }
    }
    return {
      width: out.width,
      height: out.height,
      center: at(Math.floor(out.width / 2), Math.floor(out.height / 2)),
      corner: at(2, 2),
      chromeRegionNonBg,
      saturated,
      magenta,
    };
  });
}

/**
 * Plant a chrome-flagged occluder big enough to ENCLOSE the DAG content, and
 * bright magenta so its presence is unmistakable.
 *
 * Why the test owns the subject instead of sampling the real grid: `sceneBounds`
 * reads the SAME predicate to frame the editor view, so dropping the flag clause
 * moves the editor camera from ~(1.9,1.3,1.9) to ~(61.6,41.1,63.0) — measured —
 * and drei's grid is camera-relative, so the perturbation that unhides the grid
 * also shrinks it to a far thin line. No fixed sample region can be reliable
 * against a subject the perturbation itself moves (this is what made the original
 * quadrant assertion decay). An object placed by the test does not move: it is
 * drawn by the PRODUCTION camera, which the predicate does not touch.
 */
async function plantOccluder(page: import('@playwright/test').Page, flagged: boolean) {
  return page.evaluate(async (flagged) => {
    const w = window as unknown as BasherWindow;
    const scene = w.__basher_three!.getState().scene as {
      add: (o: unknown) => void;
      remove: (o: unknown) => void;
      getObjectByName: (n: string) => Record<string, unknown> | undefined;
      traverse: (cb: (o: Record<string, unknown>) => void) => void;
    };
    scene.remove(scene.getObjectByName('__probe_occluder') ?? {});
    // The source must be DAG CONTENT, decided by ANCESTRY. A chrome group's child
    // mesh carries no flag of its own — only the root does — so "the first mesh
    // without the flag" can be a helper's line, which is exactly the mistake that
    // made the first draft of this case vacuous: it cloned something tiny and
    // off-centre, so nothing was ever in frame to be excluded.
    const { isEditorChrome } = await import('/src/app/editorChrome.ts');
    const chrome = (o: Record<string, unknown>) =>
      isEditorChrome(o as Parameters<typeof isEditorChrome>[0]);
    let src: Record<string, unknown> | null = null;
    scene.traverse((o) => {
      if (src || o.isMesh !== true) return;
      for (let a: Record<string, unknown> | null = o; a; a = a.parent as typeof a) {
        if (chrome(a)) return;
      }
      src = o;
    });
    if (!src) return false;
    const m = (src as { clone: () => Record<string, unknown> }).clone();
    m.name = '__probe_occluder';
    m.userData = flagged ? { editorChrome: true } : {};
    const mat = (src as { material: { clone: () => Record<string, unknown> } }).material.clone();
    (mat.color as { setRGB: (r: number, g: number, b: number) => void })?.setRGB(1, 0, 1);
    (mat.emissive as { setRGB: (r: number, g: number, b: number) => void })?.setRGB(1, 0, 1);
    m.material = mat;
    // Scale 4 (half-extent 2) on purpose: big enough to swallow the content, small
    // enough that the production camera at ~(3,2,3) stays OUTSIDE it. At 6 the camera
    // is inside the box, back faces cull, and the occluder renders as nothing — the
    // control caught that, which is the whole reason the control renders it first.
    (m.scale as { setScalar: (n: number) => void }).setScalar(4);
    // World position of the content it must swallow, read off the matrix so this
    // does not assume the content sits at the origin.
    const e = (src as { matrixWorld: { elements: number[] } }).matrixWorld.elements;
    (m.position as { set: (x: number, y: number, z: number) => void }).set(e[12], e[13], e[14]);
    scene.add(m);
    return true;
  }, flagged);
}

/**
 * Select each DAG node in turn and report what its selection MOUNTS: how many
 * gizmo-typed objects, and how many flagged-chrome objects, against the
 * nothing-selected baseline.
 *
 * Two different cases below need two different nodes, and naming them ('n_box',
 * 'n_camera') would tie this file to one fixture. Deriving them instead:
 *
 *   · a node that adds ONLY the gizmo  → the clause-2 subject. Its selection delta
 *     contains nothing but TransformControls*, so the case cannot red on clause 1.
 *   · a node that also adds flagged chrome → the camera, whose aim reticle mounts
 *     with it. That is the subject for the regression case (#558).
 *
 * Selection goes through the STORE, not a viewport click: a click lands on the cube
 * only under the current framing, and the flag clause MOVES that framing (measured —
 * the editor camera goes from ~(1.9,1.3,1.9) to ~(61.6,41.1,63.0)). A precondition
 * that depends on what the sibling perturbation changes makes the case witness both.
 */
async function surveySelections(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const scene = w.__basher_three!.getState().scene as {
      traverse: (cb: (o: Record<string, unknown>) => void) => void;
    };
    const { isEditorChrome } = await import('/src/app/editorChrome.ts');
    // `chrome` asks the PRODUCTION question through the production function. `gizmo`
    // asks a different one — did drei's control mount at all — which the predicate
    // cannot answer, since by design it says only "chrome / not chrome". Non-gizmo
    // chrome is then the difference, so the flag itself is never re-read here.
    const counts = () => {
      let gizmo = 0;
      let chrome = 0;
      scene.traverse((o) => {
        if (String(o.type ?? '').startsWith('TransformControls')) gizmo++;
        if (isEditorChrome(o as Parameters<typeof isEditorChrome>[0])) chrome++;
      });
      return { gizmo, chrome: chrome - gizmo };
    };
    w.__basher_selection!.getState().select(null);
    await new Promise((r) => setTimeout(r, 250));
    const base = counts();
    const rows: { id: string; gizmo: number; extraChrome: number }[] = [];
    for (const id of Object.keys(w.__basher_dag!.getState().state.nodes ?? {})) {
      w.__basher_selection!.getState().select(id);
      await new Promise((r) => setTimeout(r, 250)); // let the affordances mount
      const c = counts();
      rows.push({ id, gizmo: c.gizmo, extraChrome: c.chrome - base.chrome });
    }
    w.__basher_selection!.getState().select(null);
    await new Promise((r) => setTimeout(r, 250));
    return rows;
  });
}

/**
 * The DAG node that owns the content the render actually frames: walk up from the
 * first drawable non-chrome mesh to an ancestor whose name is a node id.
 *
 * Clause 2's subject has to be a gizmo that lands INSIDE the shot, and "the first
 * node that mounts a gizmo" is not that. Measured: it picks the light, whose gizmo
 * sits at (5,5,3) — out of frame — so dropping the gizmo clause changed nothing and
 * the case certified a clause it never exercised. The same vacuity the planted
 * occluder's control was added to prevent, arriving from the other direction.
 * Attaching the gizmo to the framed content is in-shot by construction: it is the
 * object the render is pointed at.
 */
async function framedContentNodeId(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const { isEditorChrome } = await import('/src/app/editorChrome.ts');
    const ids = new Set(Object.keys(w.__basher_dag!.getState().state.nodes ?? {}));
    const scene = w.__basher_three!.getState().scene as {
      traverse: (cb: (o: Record<string, unknown>) => void) => void;
    };
    let found: string | null = null;
    scene.traverse((o) => {
      if (found || o.isMesh !== true) return;
      let named: string | null = null;
      for (let a: Record<string, unknown> | null = o; a; a = a.parent as typeof a) {
        if (isEditorChrome(a as Parameters<typeof isEditorChrome>[0])) return;
        if (!named && ids.has(String(a.name ?? ''))) named = String(a.name);
      }
      found = named;
    });
    return found;
  });
}

async function select(page: import('@playwright/test').Page, id: string) {
  await page.evaluate((id) => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select(id);
  }, id);
  await page.waitForTimeout(300);
}

test.describe('#168 render to image', () => {
  test('renders at the explicit RenderOutput resolution, not the viewport size', async ({
    page,
  }) => {
    await waitReady(page);
    const canvasSize = await page.evaluate(() => {
      const cv = document.querySelector(
        '[data-testid="viewport-canvas"] canvas',
      ) as HTMLCanvasElement;
      return { w: cv.width, h: cv.height };
    });
    const res = (await renderAndSample(page))!;
    expect(res).not.toBeNull();
    // 1920×1080 from RenderOutput.width/height — NOT the viewport canvas size.
    // Revert Wave A (explicit resolution) → render matches the viewport → fails.
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);
    expect(res.width).not.toBe(canvasSize.w);
  });

  test('the render is NOT blank — the cube is visible (defeats the H68 trap)', async ({ page }) => {
    await waitReady(page);
    const res = (await renderAndSample(page))!;
    // Center pixel is the lit cube, not the #0a0a0a background and not blank.
    // Revert Wave B (offscreen render) → toDataURL of preserveDrawingBuffer:false
    // canvas → uniform blank → center collapses to the background and this fails.
    //
    // Asserted as centre-vs-corner SEPARATION, not by hue. The cube used to be the
    // seed's green so "g dominates" doubled as a liveness check; the standard material
    // is a neutral grey (#394 D7), so brightness separation is the property that
    // actually distinguishes "a cube was drawn" from "a uniform fill".
    const [, , , a] = res.center;
    const centerLum = (res.center[0] + res.center[1] + res.center[2]) / 3;
    const cornerLum = (res.corner[0] + res.corner[1] + res.corner[2]) / 3;
    expect(centerLum).toBeGreaterThan(60); // the cube is lit, not black
    expect(centerLum).toBeGreaterThan(cornerLum + 40); // …and it is not a uniform fill
    expect(a).toBe(255);
    // Background corner is the scene bg (#0a0a0a ≈ 10,10,10), proving a real
    // render with a real background, not a uniform fill.
    expect(res.corner[0]).toBeLessThan(40);
    expect(res.corner[1]).toBeLessThan(40);
  });

  test('editor chrome is excluded — the hide-pass runs at all', async ({ page }) => {
    await waitReady(page);
    const res = (await renderAndSample(page))!;
    // The cube-free bottom-left quadrant is pure background when chrome is excluded.
    //
    // ⚠️ WHAT THIS DISCRIMINATES, RE-MEASURED 2026-08-04 (#557). The note here used
    // to read "revert the chrome marks or the hide-pass → the floor grid leaks ~221
    // non-bg pixels → this fails (Wave D: 0 excluded vs 221 leaked)". That was true
    // when written. Measured today, one clause at a time:
    //
    //   neutralise the CALL SITE (`if (false && isEditorChrome(o))`) → 93 non-bg
    //     here → RED. So this case does witness "the hide-pass ran".
    //   drop the FLAG CLAUSE from isEditorChrome              → 0 non-bg → GREEN.
    //
    // Both leave the same objects visible, so the second result looks impossible
    // until you follow the predicate's other consumer: `sceneBounds` frames the
    // editor view with it, so dropping the flag clause ALSO pushes the editor
    // camera from ~(1.9,1.3,1.9) to ~(61.6,41.1,63.0), and drei's grid is
    // camera-relative — it collapses to a far thin line that misses this quadrant.
    // The perturbation moves the very scene this sample depends on.
    //
    // ⇒ This assertion is kept as the CALL-SITE witness and nothing more. The two
    // clauses are asserted below on subjects the perturbation cannot move. Do not
    // re-broaden this comment to "chrome is excluded" — that claim is what decayed.
    expect(res.chromeRegionNonBg).toBeLessThan(20);
  });

  test('CLAUSE 1 — the SAME object renders unflagged and vanishes once flagged', async ({
    page,
  }) => {
    await waitReady(page);

    // The control comes first, and it is the point. An assertion that a flagged
    // object is absent passes for two different reasons — the hide-pass worked, or
    // the object was never in frame. The first draft of this case had exactly the
    // second problem (it cloned a helper's child line, off-centre and tiny) and it
    // passed under the very perturbation it was written to catch. Rendering the
    // SAME object unflagged first makes that impossible: one subject, one position,
    // one difference between the two renders.
    expect(await plantOccluder(page, false)).toBe(true);
    const visible = (await renderAndSample(page))!;
    expect(visible.magenta).toBeGreaterThan(1000); // it is genuinely in shot, and huge

    expect(await plantOccluder(page, true)).toBe(true);
    const excluded = (await renderAndSample(page))!;
    // Drop the flag clause from isEditorChrome → the occluder renders → both fail.
    // It is 6× the content and centred on it, so a regression does not merely add
    // pixels: it swallows the cube, which the second assertion reads independently.
    expect(excluded.magenta).toBe(0);
    const centerLum = (excluded.center[0] + excluded.center[1] + excluded.center[2]) / 3;
    expect(centerLum).toBeGreaterThan(60);
    // Carries no TransformControls type, so dropping the gizmo clause leaves this
    // case green — one clause per case, verified in the matrix (see the commit).
  });

  test('CLAUSE 2 — mounting the selection gizmo changes the image by nothing', async ({ page }) => {
    await waitReady(page);
    // Nothing is selected at boot — measured — so without the click below clause 2
    // has no subject and any assertion about it passes vacuously.
    const before = (await renderAndSample(page))!;

    // Selection goes through the STORE, not a viewport click. A click at the canvas
    // centre only lands on the cube under the current framing, and the flag clause
    // moves that framing — measured: with it dropped the editor camera sits at
    // ~(61.6,41.1,63.0) and the click misses, so the gizmo never mounts and this
    // case fails for a reason that has nothing to do with the gizmo. The precondition
    // must not depend on the thing the other clause perturbs.
    const id = await framedContentNodeId(page);
    expect(id).not.toBeNull();
    const survey = await surveySelections(page);
    const row = survey.find((r) => r.id === id);
    // Two properties, both required and neither implied by the other: a gizmo really
    // mounts (else the absence is unearned), and selection adds NO flagged chrome
    // (else this reds when the flag clause goes and certifies nothing about clause 2).
    expect(row?.gizmo, `no gizmo for ${id}: ${JSON.stringify(survey)}`).toBeGreaterThan(0);
    expect(row?.extraChrome, `${id} also mounts flagged chrome`).toBe(0);
    await select(page, id!);
    const after = (await renderAndSample(page))!;

    // A DIFFERENCE, not an absolute count. drei's gizmo draws saturated R/G/B axes
    // and this fixture's DAG content is neutral grey, so an absolute "saturated ===
    // 0" looks like it isolates the gizmo — and does not: with the FLAG clause
    // dropped, leaked light and camera helpers are coloured too, so the absolute
    // form reds on clause 1 and certifies clause 2. Measured, on the first draft.
    // Taking both renders under identical conditions cancels any such leak, because
    // it is present in both. What is left is the gizmo alone.
    //
    // Drop the TransformControls clause → the axes appear only in `after` → fails,
    // measured at +130 saturated samples at frame centre.
    expect(after.saturated - before.saturated).toBe(0);
    expect(after.chromeRegionNonBg).toBe(before.chromeRegionNonBg);
  });

  test('selecting a CAMERA adds nothing to the image either (the aim reticle)', async ({
    page,
  }) => {
    await waitReady(page);
    const before = (await renderAndSample(page))!;

    // The camera is the selection that mounts the most editor-only geometry: the
    // gizmo AND the lookAt aim reticle. Derived, not named — it is the node whose
    // selection adds flagged chrome beyond the baseline.
    const survey = await surveySelections(page);
    const withChrome = survey.find((r) => r.extraChrome > 0);
    expect(withChrome, `nothing mounts extra chrome: ${JSON.stringify(survey)}`).toBeTruthy();
    await select(page, withChrome!.id);
    const after = (await renderAndSample(page))!;

    // This is a regression case for a leak that WAS live (#558): the aim reticle
    // draws at the lookAt point with depthTest off and renderOrder 999 — over the
    // director's content — and carried no chrome mark, so it reached every image
    // exported while a camera was selected. Measured before the fix: +109 saturated
    // samples at frame centre. Remove either mark in Gizmo.tsx → this fails.
    //
    // Kept separate from the clause-2 case on purpose: this subject is FLAGGED
    // chrome, so it also reds when the flag clause goes. That is the right coupling
    // for a mark regression and the wrong one for a gizmo-clause witness, which is
    // why the two cases select different nodes.
    expect(after.saturated - before.saturated).toBe(0);
  });

  test('File ▸ Render Image shows the result in the 2D view, then Save downloads the PNG', async ({
    page,
  }) => {
    await waitReady(page);
    // Blender F12 model: Render shows the result in the Render Result view (no
    // auto-download); Save is the explicit export. File ▸ Render Image renders
    // into the 2D view and switches there.
    await page.getByTestId('menu-file-button').click();
    await page.getByTestId('menu-file-render-image').click();
    await expect(page.getByTestId('render-result-status')).toHaveAttribute('data-status', 'ready', {
      timeout: 15000,
    });
    await expect(page.getByTestId('twodview-render-pane')).toHaveAttribute('data-active', 'true');

    // The explicit Save action downloads a PNG named for the resolution.
    // Revert the Save affordance → no download event → times out.
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('render-result-save').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/-1920x1080\.png$/);
  });
});
