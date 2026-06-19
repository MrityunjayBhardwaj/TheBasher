// #205 — the textured studio area light (epic #201). Observes the §1.5 PAIR on
// the LIVE app (Lokayata, not inference): an AreaLight with a `tex` renders BOTH
// a RectAreaLight (illumination, tinted by the texture's MEAN radiance) AND an
// emissive textured card (the visible look + reflections three's untexturable
// RectAreaLight can't provide).
//
// BOUNDARY-PAIR (render-side == resolver-side): the live RectAreaLight's color,
// reduced to a unit-luminance chroma, equals the MEAN radiance of the card's own
// texture — i.e. the renderer tints the light by the SAME reduction averageRadiance
// computes. The test recomputes the mean from the card texture independently
// (decoding half-float exactly as three's DataUtils does), so render and resolver
// are observed from opposite sides of the boundary.
//
// FALSIFICATION (guards a vacuous pass):
//   - A plain AreaLight (NO tex) → a RectAreaLight but NO emissive card mesh.
//   - The textured AreaLight → the card mesh APPEARS and shares the light's tex.
//
// PARITY (V37): the offscreen render succeeds with the studio light present.
//
// REF: src/viewport/SceneFromDAG.tsx (StudioAreaLightR); src/app/averageRadiance.ts;
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §1.5 / §7.1; vyapti V47/V37/V58.

import { expect, test } from './_fixtures';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface StudioWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_three: { getState: () => { scene: ThreeSceneLike | null } };
  __basher_importEnvHdri?: (bytes: Uint8Array, filename: string) => Promise<string>;
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
}
interface ThreeSceneLike {
  traverse: (cb: (o: ThreeObjLike) => void) => void;
}
interface ThreeObjLike {
  type: string;
  color?: { r: number; g: number; b: number };
  material?: { map?: { image?: { data?: ArrayLike<number>; width?: number; height?: number } } | null };
}

/** Counts of the studio-light render parts currently in the live scene, plus the
 *  RectAreaLight color and the card texture's DECODED mean radiance (both rgb). */
async function readStudioParts(page: import('@playwright/test').Page): Promise<{
  rectLights: number;
  cards: number;
  lightColor: [number, number, number] | null;
  texMean: [number, number, number] | null;
}> {
  return page.evaluate(() => {
    const w = window as unknown as StudioWindow;
    const scene = w.__basher_three.getState().scene;

    // three's DataUtils.fromHalfFloat — decode the Uint16 half-float storage the
    // RGBELoader/EXRLoader produce, so the mean matches averageRadiance exactly.
    const fromHalf = (val: number): number => {
      const s = (val & 0x8000) >> 15;
      const e = (val & 0x7c00) >> 10;
      const f = val & 0x03ff;
      if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
      if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
      return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    };

    let rectLights = 0;
    let cards = 0;
    let lightColor: [number, number, number] | null = null;
    let texMean: [number, number, number] | null = null;
    scene?.traverse((o) => {
      if (o.type === 'RectAreaLight') {
        rectLights++;
        if (o.color) lightColor = [o.color.r, o.color.g, o.color.b];
      }
      // The emissive card = a Mesh whose material carries a `.map` texture.
      const map = o.type === 'Mesh' ? o.material?.map : null;
      if (map) {
        cards++;
        const data = map.image?.data;
        const width = map.image?.width ?? 0;
        const height = map.image?.height ?? 0;
        if (data && data.length >= 3) {
          const texels = width > 0 && height > 0 ? width * height : Math.floor(data.length / 4);
          const comps = Math.max(1, Math.round(data.length / texels));
          // Half-float storage is a Uint16Array; float storage is Float32Array.
          const isHalf = (data as ArrayLike<number>).constructor?.name === 'Uint16Array';
          let sr = 0;
          let sg = 0;
          let sb = 0;
          for (let i = 0; i < texels; i++) {
            const b = i * comps;
            const r = isHalf ? fromHalf(data[b] as number) : (data[b] as number);
            const g = isHalf ? fromHalf(data[b + 1] as number) : (data[b + 1] as number);
            const bl = isHalf ? fromHalf(data[b + 2] as number) : (data[b + 2] as number);
            sr += r;
            sg += g;
            sb += bl;
          }
          texMean = [sr / texels, sg / texels, sb / texels];
        }
      }
    });
    return { rectLights, cards, lightColor, texMean };
  });
}

/** Unit-luminance chroma of an rgb triple (or null if luminance ~0). */
function chroma(rgb: [number, number, number] | null): [number, number, number] | null {
  if (!rgb) return null;
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  if (lum <= 1e-9) return null;
  return [rgb[0] / lum, rgb[1] / lum, rgb[2] / lum];
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
    const w = window as unknown as StudioWindow;
    return Boolean(
      w.__basher_dag &&
        w.__basher_three &&
        w.__basher_importEnvHdri &&
        w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('#205 — a textured AreaLight renders the §1.5 pair; the light is tinted by the texture', async ({
  page,
}) => {
  const before = await readStudioParts(page);

  // Add a textured AreaLight (the studio light) wired into scene.lights.
  await page.evaluate(async () => {
    const w = window as unknown as StudioWindow;
    const bytes = new Uint8Array(
      await fetch('/fixtures/env/test.hdr').then((r) => r.arrayBuffer()),
    );
    const assetRef = await w.__basher_importEnvHdri!(bytes, 'test.hdr');
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'studio_light_e2e',
          nodeType: 'AreaLight',
          params: {
            intensity: 5,
            position: [3, 4, 3],
            color: '#ffffff',
            width: 2,
            height: 2,
            lookAt: [0, 0, 0],
            tex: assetRef,
          },
        },
        {
          type: 'connect',
          from: { node: 'studio_light_e2e', socket: 'out' },
          to: { node: sceneId, socket: 'lights' },
        },
      ],
      'e2e',
      'add studio light',
    );
  });

  // The emissive card APPEARS (suspends on the OPFS read + decode first).
  await page.waitForFunction(
    (prevCards) => {
      const w = window as unknown as StudioWindow;
      const scene = w.__basher_three.getState().scene;
      let cards = 0;
      scene?.traverse((o) => {
        const m = o as ThreeObjLike;
        if (m.type === 'Mesh' && m.material?.map) cards++;
      });
      return cards > prevCards;
    },
    before.cards,
    { timeout: 15_000 },
  );

  const after = await readStudioParts(page);
  // The pair exists: an extra RectAreaLight AND an extra textured card.
  expect(after.rectLights).toBeGreaterThan(before.rectLights);
  expect(after.cards).toBe(before.cards + 1);

  // BOUNDARY-PAIR: the light's color chroma == the card texture's mean chroma —
  // the renderer tinted the light by the same reduction averageRadiance computes.
  const lightChroma = chroma(after.lightColor);
  const texChroma = chroma(after.texMean);
  expect(lightChroma).not.toBeNull();
  expect(texChroma).not.toBeNull();
  for (let i = 0; i < 3; i++) {
    expect(lightChroma![i]).toBeCloseTo(texChroma![i], 1);
  }

  // PARITY (V37): the offscreen render succeeds with the studio light present.
  const out = await page.evaluate(() => {
    const w = window as unknown as StudioWindow;
    return w.__basher_render_png!();
  });
  expect(out).not.toBeNull();
  expect(out!.dataUrl.startsWith('data:image/png')).toBe(true);
});

test('#205 — a plain AreaLight (no tex) renders NO emissive card (falsification)', async ({
  page,
}) => {
  const before = await readStudioParts(page);
  await page.evaluate(() => {
    const w = window as unknown as StudioWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'plain_area_e2e',
          nodeType: 'AreaLight',
          params: {
            intensity: 5,
            position: [3, 4, 3],
            color: '#ffffff',
            width: 2,
            height: 2,
            lookAt: [0, 0, 0],
          },
        },
        {
          type: 'connect',
          from: { node: 'plain_area_e2e', socket: 'out' },
          to: { node: sceneId, socket: 'lights' },
        },
      ],
      'e2e',
      'add plain area light',
    );
  });

  // The RectAreaLight mounts; NO new card appears (poll then assert stability).
  await page.waitForFunction(
    (prevRects) => {
      const w = window as unknown as StudioWindow;
      const scene = w.__basher_three.getState().scene;
      let rects = 0;
      scene?.traverse((o) => {
        if ((o as ThreeObjLike).type === 'RectAreaLight') rects++;
      });
      return rects > prevRects;
    },
    before.rectLights,
    { timeout: 15_000 },
  );

  const after = await readStudioParts(page);
  expect(after.rectLights).toBeGreaterThan(before.rectLights);
  expect(after.cards).toBe(before.cards); // no emissive card for a plain light
});
