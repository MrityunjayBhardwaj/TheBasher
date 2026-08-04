// P568 — THE RENDER-RESOURCE BOUNDARY, ASKED OF THE PICTURE.
//
// ── WHY THIS TIER EXISTS ───────────────────────────────────────────────────────────────
//
// Every other gate at this boundary interrogates the SOURCE: which instance a node
// resolves to (p530), whether disjoint subgraphs stay disjoint (p535), who opened which
// registry door, what key was minted. Those are the right questions, they are well
// covered, and a build can pass all of them while drawing something no director would
// accept.
//
// p535 declared exactly this residual in its own file — it reads the scene graph in JS,
// never pixels, so "a violation that leaves every object, instance and matrix correct
// while drawing wrong is invisible to it by construction." One slice later #532 landed in
// it: wiring `vertexColors` onto the native road leaves the flag holding the value the
// director set, the instance correct and the matrix correct, and renders the box PURE
// BLACK, because the shader multiplies by a COLOR_0 attribute the geometry never supplies.
// 3810 unit tests, every e2e assertion, the type system, the issue and the plan all agreed
// with it. A manual screenshot was the only dissent.
//
// So this file's whole job is to be the dissenting voice, automatically.
//
// ── THE TIER, STATED, because a gate that overstates its reach is worse than none ──────
//
// This reads REAL COMPOSITED PIXELS off a viewport screenshot, at a point computed by
// projecting a known object's world position through the live camera. It therefore sees
// what the source-tier gates cannot: whether the surface actually shows what the graph
// says it should.
//
// What it does NOT see: anything about identity or sharing. Two objects drawing one
// instance and two objects drawing two identical instances are the same picture. That is
// p530's and p535's question and this file must never be read as covering it.
//
// It is also deliberately a SAMPLED COLOUR ASSERTION, not a pixel baseline. Baselines are
// expensive to maintain and flake across GPUs; the one baseline this repo keeps
// (`postfx-beauty.png`) earns it. A dominance assertion with a control does not, and is
// what p57 and p168 already do successfully.
//
// REF: issues #568, #532 (the defect that proved the gap), #535 (where the residual was
//      declared), #536 (the epic); `tests/e2e/p57-bright-scene-contrast.spec.ts` (the
//      sampling pattern this borrows); `tests/e2e/p535-render-locality.spec.ts`.

import { expect, test } from './_fixtures';
import type { Op } from '../../src/core/dag/ops';

interface UiWindow {
  __basher_three: { getState: () => { scene: unknown; camera: unknown } };
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], src: string, label: string) => void;
    };
  };
}

/** Saturated and far apart in hue, so shading cannot turn one into the other. */
const RED = '#ff0000';
const BLUE = '#0000ff';

type RGB = { r: number; g: number; b: number };

function cubeOps(data: string, obj: string, color: string, x: number): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: data,
      nodeType: 'BoxData',
      params: {
        size: [1.4, 1.4, 1.4],
        // Unlit-ish on purpose: high roughness, zero metalness. A metallic surface takes
        // its colour from the environment, which would make the assertion about lighting
        // rather than about the material reaching the screen.
        material: { name: color, base: { color, metalness: 0 }, specular: { roughness: 0.9 } },
      },
    },
    { type: 'addNode', nodeId: obj, nodeType: 'Object', params: { position: [x, 0, 0] } },
    { type: 'connect', from: { node: data, socket: 'out' }, to: { node: obj, socket: 'data' } },
  ] as Op[];
}

async function seed(page: import('@playwright/test').Page, ops: Op[], objs: string[]) {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(a.ops as Op[]),
          ...a.objs.map(
            (c) =>
              ({
                type: 'connect',
                from: { node: c, socket: 'out' },
                to: { node: scene, socket: 'children' },
              }) as Op,
          ),
        ],
        'e2e',
        '#568 fixture',
      );
    },
    { ops: ops as unknown, objs },
  );
  await page.waitForTimeout(700);
}

/**
 * Where a node's first mesh lands ON SCREEN, in CSS pixels relative to the canvas.
 *
 * Computed rather than hardcoded: a hardcoded coordinate silently starts sampling the
 * background the first time the starter scene's camera moves, and a background sample
 * fails in a way that looks like the material is wrong.
 */
async function screenPointOf(page: import('@playwright/test').Page, nodeId: string) {
  return page.evaluate((id) => {
    const w = window as unknown as UiWindow;
    const { scene, camera } = w.__basher_three.getState() as {
      scene: {
        getObjectByName: (n: string) => { traverse: (f: (o: unknown) => void) => void } | undefined;
      } | null;
      camera: unknown;
    };
    const grp = scene?.getObjectByName(id);
    if (!grp) return null;
    let mesh: unknown = null;
    grp.traverse((o) => {
      const m = o as { isMesh?: boolean };
      if (!mesh && m.isMesh) mesh = o;
    });
    if (!mesh) return null;

    const m = mesh as {
      position: { clone: () => unknown };
      getWorldPosition: (t: unknown) => {
        x: number;
        y: number;
        z: number;
        project: (c: unknown) => void;
      };
    };
    // `position.clone()` gives a Vector3 without importing THREE into the page.
    const p = m.getWorldPosition(m.position.clone());
    p.project(camera);

    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ((p.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - p.y) / 2) * rect.height,
      inFrustum: p.x > -1 && p.x < 1 && p.y > -1 && p.y < 1 && p.z < 1,
    };
  }, nodeId);
}

/**
 * The composited colour at a point, averaged over a small patch.
 *
 * A patch rather than a single pixel because one pixel can land on a specular highlight or
 * an antialiased edge; the median-ish average over a small box is stable without hiding a
 * real change (the two colours under test are maximally far apart).
 */
async function sampleAt(
  page: import('@playwright/test').Page,
  pt: { x: number; y: number },
): Promise<RGB> {
  const half = 6;
  const buf = await page.screenshot({
    clip: { x: pt.x - half, y: pt.y - half, width: half * 2, height: half * 2 },
  });
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  return page.evaluate(async (url) => {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('decode failed'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let r = 0;
    let g = 0;
    let b = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    return { r: r / n, g: g / n, b: b / n };
  }, dataUrl);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as UiWindow;
    return Boolean(
      w.__basher_three && w.__basher_dag && w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('#568 — a native primitive’s material reaches the SCREEN, and a second colour proves the sampler discriminates', async ({
  page,
}) => {
  await seed(
    page,
    [...cubeOps('d-red', 'o-red', RED, -2.2), ...cubeOps('d-blue', 'o-blue', BLUE, 2.2)],
    ['o-red', 'o-blue'],
  );

  const redPt = await screenPointOf(page, 'o-red');
  const bluePt = await screenPointOf(page, 'o-blue');

  // PRECONDITION, not an assertion about the fix: if either object is off-screen the
  // samples below would be measuring the background, and a background sample reads exactly
  // like a material that failed to arrive. Fail loudly here instead.
  expect(redPt, 'the red cube has no mesh on the live scene').not.toBeNull();
  expect(bluePt, 'the blue cube has no mesh on the live scene').not.toBeNull();
  expect(redPt!.inFrustum, 'the red cube is outside the camera frustum').toBe(true);
  expect(bluePt!.inFrustum, 'the blue cube is outside the camera frustum').toBe(true);

  const red = await sampleAt(page, redPt!);
  const blue = await sampleAt(page, bluePt!);

  // ── THE CARRYING ASSERTIONS ──────────────────────────────────────────────────────────
  //
  // Dominance, not equality: the surface is lit, so #ff0000 does not arrive as (255,0,0).
  // Dominance is still enough to catch the failure this file exists for — a black box has
  // no dominant channel at all, which is precisely why the vertex-colours experiment reds
  // here and nothing else could see it.
  expect(
    red.r,
    `the red cube renders ${JSON.stringify(red)} — its material never reached the screen`,
  ).toBeGreaterThan(red.g + 25);
  expect(
    red.r,
    `the red cube renders ${JSON.stringify(red)} — its material never reached the screen`,
  ).toBeGreaterThan(red.b + 25);

  // ── THE PRESENCE CONTROL, in the same case ───────────────────────────────────────────
  //
  // Without this a uniformly broken sampler — one reading the same patch twice, or the
  // background both times — passes the block above whenever the background happens to be
  // warm. The second cube must come back a DIFFERENT and specifically blue-dominant
  // colour, which no single-object assertion can establish.
  expect(
    blue.b,
    `the blue cube renders ${JSON.stringify(blue)} — either its material never reached the screen, or the sampler is reading one point twice`,
  ).toBeGreaterThan(blue.g + 25);
  expect(blue.b, `the blue cube renders ${JSON.stringify(blue)}`).toBeGreaterThan(blue.r + 25);
  expect(
    Math.abs(red.r - blue.r) + Math.abs(red.b - blue.b),
    `the two cubes sampled to nearly the same colour (${JSON.stringify(red)} vs ${JSON.stringify(blue)}) — the instrument is not discriminating`,
  ).toBeGreaterThan(60);
});
