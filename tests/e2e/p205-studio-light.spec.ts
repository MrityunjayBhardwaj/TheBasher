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
import { splitLightDataId, splitLightOps } from './_splitLight';

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
  material?: {
    map?: { image?: { data?: ArrayLike<number>; width?: number; height?: number } } | null;
  };
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

  // Add a textured SPLIT area light (Object + LightData, #386 C3) wired into scene.lights.
  // The `tex` assetRef is only known inside the page (the import runs there), so it is set
  // in the same atomic batch — onto the DATA half, which owns every shading param.
  const lightOps = splitLightOps({
    objectId: 'studio_light_e2e',
    lightKind: 'Area',
    position: [3, 4, 3],
    shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: [0, 0, 0] },
  }) as Op[];
  const studioDataId = splitLightDataId('studio_light_e2e');
  await page.evaluate(
    async ({ lightOps, studioDataId }) => {
      const w = window as unknown as StudioWindow;
      const bytes = new Uint8Array(
        await fetch('/fixtures/env/test.hdr').then((r) => r.arrayBuffer()),
      );
      const assetRef = await w.__basher_importEnvHdri!(bytes, 'test.hdr');
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...lightOps,
          {
            type: 'setParam',
            nodeId: studioDataId,
            paramPath: 'tex',
            value: assetRef,
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
    },
    { lightOps, studioDataId },
  );

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

test('#205 — a Track-To aims the area light at the constraint target (the rig, V60)', async ({
  page,
}) => {
  // The light is AUTHORED to look at the origin, but a Track-To aims it at a
  // DISTINCT point — so the test proves the CONSTRAINT wins (not the authored
  // lookAt), the third V60 consumer (mesh, camera, light).
  const POS: [number, number, number] = [3, 4, 3];
  const AIM: [number, number, number] = [5, 0, -5];
  const AUTHORED: [number, number, number] = [0, 0, 0];

  // The Track-To targets the OBJECT half — the constraint poses the light, and the pose
  // stayed on the Object when #386 split the fused AreaLight.
  const rigLightOps = splitLightOps({
    objectId: 'rig_light_e2e',
    lightKind: 'Area',
    position: POS,
    shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: AUTHORED },
  }) as Op[];
  await page.evaluate(
    ({ aim, rigLightOps }) => {
      const w = window as unknown as StudioWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...rigLightOps,
          {
            type: 'connect',
            from: { node: 'rig_light_e2e', socket: 'out' },
            to: { node: sceneId, socket: 'lights' },
          },
          // The rig's aim: a Track-To targeting the light, aiming at a fixed point.
          {
            type: 'addNode',
            nodeId: 'rig_trackto_e2e',
            nodeType: 'TrackTo',
            params: { target: 'rig_light_e2e', aimNode: '', aimPoint: aim, up: [0, 1, 0] },
          },
        ],
        'e2e',
        'add rig light + track-to',
      );
    },
    { aim: AIM, rigLightOps },
  );

  // Forward (toward the aim) = light's local -Z in world. Wait until it points at
  // the constraint target — the per-frame Track-To aim has taken over.
  const norm = (v: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const expected = norm([AIM[0] - POS[0], AIM[1] - POS[1], AIM[2] - POS[2]]);
  const authoredDir = norm([AUTHORED[0] - POS[0], AUTHORED[1] - POS[1], AUTHORED[2] - POS[2]]);

  await page.waitForFunction(
    (exp) => {
      const w = window as unknown as StudioWindow;
      const scene = w.__basher_three.getState().scene;
      let fwd: [number, number, number] | null = null;
      scene?.traverse((o) => {
        const obj = o as unknown as {
          type: string;
          updateMatrixWorld?: (f?: boolean) => void;
          matrixWorld?: { elements: number[] };
        };
        if (obj.type === 'RectAreaLight' && obj.matrixWorld) {
          obj.updateMatrixWorld?.(true);
          const e = obj.matrixWorld.elements;
          // -Z column (forward toward target), normalized.
          const z: [number, number, number] = [-e[8], -e[9], -e[10]];
          const l = Math.hypot(z[0], z[1], z[2]) || 1;
          fwd = [z[0] / l, z[1] / l, z[2] / l];
        }
      });
      if (!fwd) return false;
      return (
        Math.abs(fwd[0] - exp[0]) < 0.02 &&
        Math.abs(fwd[1] - exp[1]) < 0.02 &&
        Math.abs(fwd[2] - exp[2]) < 0.02
      );
    },
    expected,
    { timeout: 15_000 },
  );

  // Falsification: the light is NOT pointing where it was AUTHORED to (the
  // constraint overrode it). expected and authoredDir are distinct by construction.
  expect(expected).not.toEqual(authoredDir);
});

test('#205 — a plain AreaLight (no tex) renders NO emissive card (falsification)', async ({
  page,
}) => {
  const before = await readStudioParts(page);
  const plainLightOps = splitLightOps({
    objectId: 'plain_area_e2e',
    lightKind: 'Area',
    position: [3, 4, 3],
    shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: [0, 0, 0] },
  }) as Op[];
  await page.evaluate(
    ({ plainLightOps }) => {
      const w = window as unknown as StudioWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...plainLightOps,
          {
            type: 'connect',
            from: { node: 'plain_area_e2e', socket: 'out' },
            to: { node: sceneId, socket: 'lights' },
          },
        ],
        'e2e',
        'add plain area light',
      );
    },
    { plainLightOps },
  );

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
