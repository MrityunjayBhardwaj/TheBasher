// P581 — OCCUPANCY, ASKED OF THE PICTURE.
//
// ── WHY THIS TIER EXISTS ───────────────────────────────────────────────────────────────
//
// p568 established that a native primitive's material reaches the screen. It samples the
// object's PROJECTED CENTRE and asserts colour dominance, which is the right instrument for
// its question — "did this surface draw, and did it draw the right colour?"
//
// It cannot see a change in how much of the frame an object occupies. Measured on the
// un-fixed tree while scoping this file: a cube shrunk from 1.4 to 0.25 left p568 GREEN,
// because the centre pixel is still on the object — just a smaller one. Anything that
// changes an object's EXTENT rather than its PRESENCE passes every tier we had.
//
// That is exactly the tier a cook-consumed geometry param lives in. `BoxData.size` becomes
// an opaque `GeometryRef` on the way through evaluation, so no read-side assertion can
// observe it under the same path (`src/test-utils/splitKinds.ts` says so in as many words,
// which is why `observableDataParam` for a box is the material colour and not `size`). The
// picture is the only place the question can be asked.
//
// ── THE TIER, STATED, because a gate that overstates its reach is worse than none ──────
//
// This asserts OCCUPANCY: subject colour present at a point the large form reaches and
// absent there at the small form — something HERE, nothing THERE. It is a second tier
// ALONGSIDE p568, never a replacement: it says nothing about which colour is correct, only
// that the extent moved.
//
// What it does NOT see: identity or sharing (p530/p535's question), and the correctness of
// the colour itself (p568's). It also does not measure area — see the note on the
// difference count below, which is recorded rather than asserted.
//
// ── WHY THE CENTRE ASSERTION IS PART OF THE GATE ──────────────────────────────────────
//
// The centre sample is asserted UNCHANGED across the two extents. That looks redundant and
// is the most load-bearing line in the file: it is the standing proof that the cheaper
// centre-point instrument is BLIND to what this gate measures. Without it, a future reader
// has no way to tell this file apart from a second copy of p568, and the honest answer to
// "is this tier genuinely uncovered?" decays into an assertion nobody re-measured.
//
// Measured while writing it: centre reads (144,0,6) at size 1 and (144,0,6) at size 3 —
// identical — while the annulus probe goes (16,16,22) → (156,0,9).
//
// ── FALSIFIED AGAINST A BROKEN BUILD, and both arms came from ONE perturbation ─────────
//
// The perturbation was PRODUCTION, not the fixture: `overlayWithIdentity.ts` line ~272,
// `rebuildGeometryRef(ref, written)` → `ref`, which neuters the handle repair and reproduces
// exactly the frozen-picture bug that function's own comment describes. Perturbing the
// fixture instead would only have shown that this file reads its own inputs.
//
//   ARM 1 — it reds, at the CARRYING assertion.  The annulus at size 3 read
//     (15.6, 16.0, 21.6) — the background, to within a pixel of the documented (16,16,22).
//     The extent never moved. The failure frame is the subject assertion below, not a
//     fixture or precondition frame, which is the difference between a red that means
//     something and a red that means the harness broke.
//
//   ARM 2 — the centre-point tier stays GREEN through the identical break.  Both presence
//     assertions passed on that same run; execution reached the annulus line, which sits
//     after them. So a centre-point-only gate certifies this broken build.
//
// That pair is the whole claim. Arm 1 alone would only prove the gate is connected to
// something; it is arm 2 that proves this tier is genuinely UNCOVERED rather than a second
// copy of p568. Re-run both if this file's assertions are ever loosened.
//
// (Green → red → green on one tree, probe reverted by inverse edit; the passing runs either
// side reported an identical 3028 changed pixels and a centre delta of 0.0.)
//
// REF: issue #581 (this gate), #575 (the thread it was started for), #568 / the file above
//      (the tier this sits beside), `src/test-utils/splitKinds.ts` (why `size` is not
//      observable on the read side).

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
  __basher_time: { getState: () => { setTime: (s: number) => void } };
}

type RGB = { r: number; g: number; b: number };

/** Saturated, and far from the viewport background, which measured (16,16,22) here. */
const RED = '#ff0000';

const OBJ = 'p581_obj';
const DATA = 'p581_data';

/**
 * World-space offset of the annulus probe from the object's centre, along +x.
 *
 * MEASURED, not derived. The naive derivation — "half of the small extent < d < half of the
 * large extent" — is wrong, because what matters is the projected SILHOUETTE and not the
 * world half-extent: at d=0.75 the small cube's silhouette still covers the point (it read
 * (138,6,16), red) even though 0.75 is outside its world half-extent of 0.5. d=1.0 is the
 * measured first offset that is background at size 1 and subject at size 3.
 *
 * If the starter scene's camera moves, this needs RE-MEASURING, not recomputing.
 */
const PROBE_D = 1.0;

/** Size at t=0 and t=2. The channel lerps between them. */
const SIZE_SMALL = 1;
const SIZE_LARGE = 3;

function subjectOps(scene: string): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: DATA,
      nodeType: 'BoxData',
      params: {
        size: [SIZE_SMALL, SIZE_SMALL, SIZE_SMALL],
        // High roughness, zero metalness for the same reason p568 does it: a metallic
        // surface takes its colour from the environment, which would make this assertion
        // about lighting rather than about occupancy.
        material: { name: RED, base: { color: RED, metalness: 0 }, specular: { roughness: 0.9 } },
      },
    },
    { type: 'addNode', nodeId: OBJ, nodeType: 'Object', params: { position: [0, 0, 0] } },
    { type: 'connect', from: { node: DATA, socket: 'out' }, to: { node: OBJ, socket: 'data' } },
    {
      type: 'connect',
      from: { node: OBJ, socket: 'out' },
      to: { node: scene, socket: 'children' },
    },
    {
      // The overlay. It targets the DATA node's `size` — a param the COOK consumes to build
      // geometry — and deliberately not the Object's `scale`, which would only move a
      // matrix and would prove nothing about the cook seam.
      type: 'addNode',
      nodeId: 'p581_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'size',
        target: DATA,
        paramPath: 'size',
        keyframes: [
          { time: 0, value: [SIZE_SMALL, SIZE_SMALL, SIZE_SMALL], easing: 'linear' },
          { time: 2, value: [SIZE_LARGE, SIZE_LARGE, SIZE_LARGE], easing: 'linear' },
        ],
      },
    },
  ] as Op[];
}

/**
 * Project an arbitrary WORLD point through the live camera.
 *
 * Note what this deliberately does NOT do: walk the group for its first `isMesh` child, the
 * way p568's `screenPointOf` does. That walk certified a helper's child line in an earlier
 * gate in this family, and `isMesh` is the usual holder rather than the only one — a
 * `<line>` draws too. Here the subject is NAMED and the probe point is derived from the
 * named group's transform, so there is no traversal order to get wrong.
 */
async function projectWorld(
  page: import('@playwright/test').Page,
  world: [number, number, number],
) {
  return page.evaluate(
    ({ p, obj }) => {
      const w = window as unknown as UiWindow;
      const { scene, camera } = w.__basher_three.getState() as {
        scene: { getObjectByName: (n: string) => unknown } | null;
        camera: unknown;
      };
      const grp = scene?.getObjectByName(obj) as
        | {
            position: {
              clone: () => { x: number; y: number; z: number; project: (c: unknown) => void };
            };
          }
        | undefined;
      if (!grp) return null;
      // `position.clone()` yields a real Vector3 without importing THREE into the page.
      const v = grp.position.clone();
      v.x = p[0];
      v.y = p[1];
      v.z = p[2];
      v.project(camera);
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + ((v.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - v.y) / 2) * rect.height,
        inFrustum: v.x > -1 && v.x < 1 && v.y > -1 && v.y < 1 && v.z < 1,
      };
    },
    { p: world, obj: OBJ },
  );
}

/** The composited colour at a point, averaged over a small patch (p568's sampler). */
async function sampleAt(
  page: import('@playwright/test').Page,
  pt: { x: number; y: number },
): Promise<RGB> {
  const half = 6;
  const buf = await page.screenshot({
    clip: { x: pt.x - half, y: pt.y - half, width: half * 2, height: half * 2 },
  });
  return decodeAverage(page, buf);
}

async function decodeAverage(page: import('@playwright/test').Page, buf: Buffer): Promise<RGB> {
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

/**
 * How many pixels differ between two renders of the SAME clip.
 *
 * A difference rather than an absolute count, because anything present in both cancels —
 * the background, the grid, AA noise, and whatever else CI's GPU path renders differently
 * from a local one. That cancellation is why this number survives a machine change and an
 * absolute pixel count would not.
 *
 * RECORDED, not carrying: it is asserted only against a floor of zero, because the exact
 * count is a function of resolution and AA and pinning it would make this gate a baseline
 * by the back door.
 *
 * ITS SECOND JOB IS TO DISAMBIGUATE A FAILING ANNULUS (#602). "The probe reads background at
 * the large extent" has two causes that look identical at the probe point, and this number
 * separates them, which is why it is computed BEFORE those assertions rather than after:
 *
 *   changed == 0  → the extent genuinely never moved. The overlay did not reach the cook.
 *   changed  > 0  → the extent moved, but not where the probe is looking. PROBE_D is stale
 *                   (the usual cause: the starter scene's camera moved).
 *
 * An earlier version of this comment claimed the zero case covered a stale probe. It does
 * not — a misplaced probe still sees the extent move elsewhere in the clip, so that count is
 * comfortably non-zero exactly when the claim needed it to be zero.
 */
async function changedPixels(
  page: import('@playwright/test').Page,
  a: Buffer,
  b: Buffer,
): Promise<number> {
  const urls = {
    a: `data:image/png;base64,${a.toString('base64')}`,
    b: `data:image/png;base64,${b.toString('base64')}`,
  };
  return page.evaluate(async ({ a: ua, b: ub }) => {
    const load = async (url: string) => {
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
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const da = await load(ua);
    const db = await load(ub);
    if (da.length !== db.length) return -1;
    // 24 per channel: comfortably above AA dither, far below a background→subject flip,
    // which measured a ~140 jump on the red channel.
    const EPS = 24;
    let n = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (
        Math.abs(da[i] - db[i]) > EPS ||
        Math.abs(da[i + 1] - db[i + 1]) > EPS ||
        Math.abs(da[i + 2] - db[i + 2]) > EPS
      ) {
        n++;
      }
    }
    return n;
  }, urls);
}

const isSubject = (c: RGB) => c.r > c.g + 40 && c.r > c.b + 40;

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

test('#581 — an overlay on a cook-consumed geometry param moves the object’s OCCUPANCY, which the centre-point tier cannot see', async ({
  page,
}) => {
  const sceneNode = await page.evaluate(
    () => (window as unknown as UiWindow).__basher_dag.getState().state.outputs.scene!.node,
  );
  await page.evaluate(
    (ops) => {
      const w = window as unknown as UiWindow;
      w.__basher_dag.getState().dispatchAtomic(ops as Op[], 'e2e', '#581 fixture');
    },
    subjectOps(sceneNode) as unknown,
  );
  await page.waitForTimeout(900);

  const at = async (seconds: number) => {
    await page.evaluate((s) => {
      (window as unknown as UiWindow).__basher_time.getState().setTime(s);
    }, seconds);
    await page.waitForTimeout(600);

    const centre = await projectWorld(page, [0, 0, 0]);
    const annulus = await projectWorld(page, [PROBE_D, 0, 0]);

    // PRECONDITION, not an assertion about the subject: an off-screen probe reads the
    // background, which is indistinguishable from "the extent never reached here".
    expect(centre, 'the subject has no group on the live scene').not.toBeNull();
    expect(annulus, 'the annulus probe did not project').not.toBeNull();
    expect(centre!.inFrustum, 'the subject centre is outside the camera frustum').toBe(true);
    expect(annulus!.inFrustum, 'the annulus probe is outside the camera frustum').toBe(true);

    const half = 90;
    const clip = await page.screenshot({
      clip: { x: centre!.x - half, y: centre!.y - half, width: half * 2, height: half * 2 },
    });
    return {
      centre: await sampleAt(page, centre!),
      annulus: await sampleAt(page, annulus!),
      clip,
    };
  };

  const small = await at(0);
  const large = await at(2);

  // ── THE PRESENCE CONTROL, first, in the same case ────────────────────────────────────
  //
  // Without this the occupancy block below passes whenever the subject is simply ABSENT at
  // the small extent — nothing THERE is trivially true of nothing anywhere.
  expect(
    isSubject(small.centre),
    `the subject is not drawn at the small extent (centre ${JSON.stringify(small.centre)}) — every assertion below would be vacuous`,
  ).toBe(true);
  expect(
    isSubject(large.centre),
    `the subject is not drawn at the large extent (centre ${JSON.stringify(large.centre)})`,
  ).toBe(true);

  // The magnitude is computed HERE, ahead of the assertions that use it to name their own
  // cause (#602). See `changedPixels` for the two-case table.
  const changed = await changedPixels(page, small.clip, large.clip);

  // ── THE CARRYING ASSERTION: something HERE, nothing THERE ────────────────────────────
  expect(
    isSubject(small.annulus),
    `at size ${SIZE_SMALL} the annulus probe already reads as subject (${JSON.stringify(small.annulus)}) — the probe sits INSIDE the small silhouette, so this gate is measuring nothing. Re-measure PROBE_D.`,
  ).toBe(false);
  expect(
    isSubject(large.annulus),
    changed > 0
      ? `at size ${SIZE_LARGE} the annulus probe still reads background (${JSON.stringify(large.annulus)}), BUT ${changed} pixels changed elsewhere in the clip — so the extent DID move and the probe is looking in the wrong place. This is a stale PROBE_D (${PROBE_D}), not a broken overlay. Re-measure it against the current starter-scene camera; do not widen the colour test.`
      : `at size ${SIZE_LARGE} the annulus probe still reads background (${JSON.stringify(large.annulus)}) and NOTHING in the clip changed — the extent never moved at all, so the overlay never reached the cooked geometry.`,
  ).toBe(true);

  // ── THE TIER PROOF: the cheaper instrument is blind to all of the above ──────────────
  //
  // If this ever reds, the honest reading is NOT "loosen the tolerance" — it is that the
  // centre-point tier has become able to see extent, and this file's reason for existing
  // needs re-stating.
  const centreDelta =
    Math.abs(small.centre.r - large.centre.r) +
    Math.abs(small.centre.g - large.centre.g) +
    Math.abs(small.centre.b - large.centre.b);
  expect(
    centreDelta,
    `the centre pixel moved by ${centreDelta.toFixed(1)} across a ${SIZE_SMALL}→${SIZE_LARGE} extent change (${JSON.stringify(small.centre)} → ${JSON.stringify(large.centre)}). The centre-point tier is supposed to be BLIND here — that blindness is why this file exists.`,
  ).toBeLessThan(30);

  // ── THE MAGNITUDE, recorded ──────────────────────────────────────────────────────────
  console.log(
    `#581 occupancy: ${changed} pixels changed in the subject's neighbourhood across ${SIZE_SMALL}→${SIZE_LARGE}; centre delta ${centreDelta.toFixed(1)}`,
  );
  expect(
    changed,
    'no pixel in the subject neighbourhood changed — the extent did not move at all, and the annulus flip above would have to be an artefact',
  ).toBeGreaterThan(0);
});
