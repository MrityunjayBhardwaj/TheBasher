// #1282 — the "Camera Path + AI Walk" example opens from the startup screen and plays with no
// motion server.
//
// It is the first example with a stored asset (the character's GLB, a seeded catalog asset — the
// convention for anything that ships with the app) and a generated motion (its clip holds
// the keys Kimodo produced). So what is checked is what a person would see: the example card
// opens it, the character's bones move with the playhead, and the camera travels its path —
// with every request to the motion server refused, so a quiet pass cannot come from a server
// that happened to be running.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

type Vec3 = [number, number, number];
interface Win {
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  /** The armature band's bones as drawn: world matrices, column-major. The example's character
   *  is stored native (#1424), so its bones are the band's. */
  __basher_armature?: { bones: number; names: string[]; matrices: number[][] };
  __basher_frustum_pose?: Record<string, { position: Vec3 }>;
}

/** At `t` seconds, once the frame after the time change has drawn: every bone's world rotation
 *  (the unit 3×3 of its drawn matrix) and the camera's evaluated position. */
function sampleAt(page: Page, t: number) {
  return page.evaluate(async (sec) => {
    const w = window as unknown as Win;
    w.__basher_time!.getState().setTime(sec);
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    const band = w.__basher_armature!;
    // The drawn matrix's columns carry the bone's display length, so each is normalised first:
    // the rotation alone, whatever size the bone is drawn at.
    const unit = (m: number[], c: number) => {
      const n = Math.hypot(m[c], m[c + 1], m[c + 2]) || 1;
      return [m[c] / n, m[c + 1] / n, m[c + 2] / n];
    };
    return {
      bones: band.matrices.map((m) => [...unit(m, 0), ...unit(m, 4), ...unit(m, 8)]),
      camera: w.__basher_frustum_pose?.['n_camera']?.position ?? null,
    };
  }, t);
}

test('the Camera Path + AI Walk example opens from the startup screen and plays offline', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let serverRequests = 0;
  await page.route(/:8600\//, (route) => {
    serverRequests++;
    return route.abort();
  });
  // A first run: no remembered project, so boot lands on the startup screen.
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('basher.lastProjectId');
    } catch {
      /* storage disabled */
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('home-view')).toBeVisible();
  await page.getByTestId('home-open-example_camera_path_ai_walk').click();

  await page.waitForFunction(
    () => ((window as unknown as Win).__basher_armature?.bones ?? 0) > 10,
    null,
    { timeout: 30_000 },
  );
  // The walk: each bone's WIDEST swing from its frame-0 pose over several times. Two instants
  // alone can land on the same phase of a stride and read a walking character as still. A swing is
  // a change of more than 0.2 in an entry of the bone's drawn rotation, about 11.5°.
  const times = [0, 0.4, 0.8, 1.2, 1.6, 2.0, 3.0];
  const samples: Awaited<ReturnType<typeof sampleAt>>[] = [];
  for (const t of times) samples.push(await sampleAt(page, t));
  const a = samples[0];
  const b = samples[samples.length - 1];
  const swung = a.bones.filter((q, i) =>
    samples.some((s) => {
      const r = s.bones[i];
      return q && r && Math.max(...q.map((v, k) => Math.abs(v - r[k]))) > 0.2;
    }),
  ).length;
  console.log(
    `[1282] bones=${a.bones.length} swung=${swung} camera ${JSON.stringify(a.camera)} -> ${JSON.stringify(b.camera)}`,
  );
  expect(a.bones.length, 'the character is rigged').toBeGreaterThan(10);
  expect(swung, 'the character walks').toBeGreaterThanOrEqual(5);

  // The camera path: the camera's evaluated position moves along its curve.
  expect(a.camera, 'the camera is drawn').not.toBeNull();
  const travelled = Math.hypot(...a.camera!.map((v, k) => v - b.camera![k]));
  expect(travelled, 'the camera travels its path').toBeGreaterThan(0.1);

  expect(errors).toEqual([]);
  expect(serverRequests, 'no request reached for the motion server').toBe(0);
});

// #1285 — the walker ends where its drawn path ends. Before the path was asked for in the
// generator's metres, the retarget's leg ratio (0.63 here) shrank the walk to a copy of the curve
// about its start: the Hips stopped about halfway along and strayed up to 0.79 m off it.
test('the example’s walker follows its drawn path to the end', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route(/:8600\//, (route) => route.abort());
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('basher.lastProjectId');
    } catch {
      /* storage disabled */
    }
  });
  await page.goto('/');
  await page.getByTestId('home-open-example_camera_path_ai_walk').click();
  await page.waitForFunction(
    () => {
      const w = window as unknown as Record<string, unknown>;
      const band = w.__basher_armature as { bones: number } | undefined;
      return (band?.bones ?? 0) > 10 && !!w.__basher_curve_sample;
    },
    null,
    { timeout: 30_000 },
  );

  const rows = await page.evaluate(async () => {
    type Sample = { point: number[] };
    type GraphNode = {
      type: string;
      inputs?: { path?: { node: string } };
      params: { duration?: number };
    };
    const w = window as unknown as {
      __basher_dag: { getState: () => { state: { nodes: Record<string, GraphNode> } } };
      __basher_curve_sample: (id: string, u: number) => Sample;
      __basher_armature: { names: string[]; matrices: number[][] };
      __basher_time: { getState: () => { setTime: (s: number) => void } };
    };
    const nodes = Object.values(w.__basher_dag.getState().state.nodes);
    const curve = nodes.find((n) => n.type === 'MotionGenerate')!.inputs!.path!.node;
    const duration = nodes.find((n) => n.type === 'AnimationClip')!.params.duration!;
    const N = 400;
    const pts = Array.from(
      { length: N + 1 },
      (_, i) => w.__basher_curve_sample(curve, i / N).point,
    );
    // The drawn Hips: the armature band's bone, read at each time.
    const hipsIndex = w.__basher_armature.names.findIndex((n) => /Hips$/.test(n));
    const out: { f: number; off: number; along: number; toEnd: number }[] = [];
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      w.__basher_time.getState().setTime(f * duration);
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
      const m = w.__basher_armature.matrices[hipsIndex];
      const h = { x: m[12], z: m[14] };
      let off = Infinity;
      let at = 0;
      pts.forEach((p, i) => {
        const d = Math.hypot(p[0] - h.x, p[2] - h.z);
        if (d < off) [off, at] = [d, i];
      });
      out.push({ f, off, along: at / N, toEnd: Math.hypot(pts[N][0] - h.x, pts[N][2] - h.z) });
    }
    return out;
  });
  console.log(
    `[1285] ${JSON.stringify(rows.map((r) => [r.f, +r.off.toFixed(2), +r.along.toFixed(2)]))}`,
  );
  // Kimodo tracks root waypoints to 4-12 cm; the retarget scales that by the leg ratio.
  for (const r of rows)
    expect(r.off, `off the drawn path at ${r.f} of the walk`).toBeLessThan(0.25);
  const last = rows[rows.length - 1];
  expect(last.along, 'how far along the path the walk ends').toBeGreaterThan(0.95);
  expect(last.toEnd, 'metres from the path’s end when the walk ends').toBeLessThan(0.25);
});
