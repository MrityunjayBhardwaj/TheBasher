// #1727 / #1726 — a keyed object keeps moving during playback while something is selected and the
// frame is busy.
//
// What this guards: per-frame animation must reach what is drawn every frame, whatever else React
// has to do. A keyed object used to move by a React state update made inside the frame loop, while
// the gizmo of the selected object re-renders on every playhead tick at a higher React priority.
// When the frame is full, the keyed object's update is never rendered and it stands still until
// playback pauses (#1726).
//
// Fixture: one keyed subject, plus N static spheres (the scene-size half of the load) and a
// busy-wait of LOAD_MS inside every animation frame (the frame-budget half). Nothing in the
// product is changed to make the load. Three subjects, one per road a keyed thing is drawn on:
//   - the default scene's `n_box` (a mesh: `DirectChannelsR`), read from the drawn mesh;
//   - the default scene's `n_light` (a light: `DirectChannelsLightR`), read from the drawn light;
//   - the default scene's `n_camera` (its frustum: `CameraFrustumFollower`), read from the pose
//     the frustum was drawn with.
// Each is keyed on position z, base → base + TRAVEL over DURATION seconds, linear.
//
// Observation, per animation frame during play: the subject's DRAWN world z and the playhead's
// seconds. It must move on at least 90% of the frames the playhead advanced, and each drawn z must
// sit within one frame of where scrubbing puts it.
//
// The control: the box under the same load with nothing selected. It separates "the frame is slow"
// from "the selected object's per-tick work starves the animation".

import { test, expect, type Page } from './_fixtures';

const STATIC_NODES = parseInt(process.env.P1727_NODES ?? '400', 10);
const LOAD_MS = parseFloat(process.env.P1727_LOAD_MS ?? '12');
const SAMPLE_FRAMES = 90;
// z travels base → base + 150 over 60 s, linear, so z(t) = base + 2.5 t. Long enough that a slow
// headless frame (~100 ms here) never runs the playhead past the last key while sampling.
const DURATION = 60;
const TRAVEL = 150;
const zAt = (base: number, s: number) =>
  base + (TRAVEL * Math.min(Math.max(s, 0), DURATION)) / DURATION;

type SubjectKind = 'mesh' | 'light' | 'frustum';
interface Subject {
  kind: SubjectKind;
  id: string;
}
/** Where to read a staged subject: its kind and id, which drawn light is it, and its base z. */
interface Staged extends Subject {
  lightIndex: number;
  baseZ: number;
  selectId: string | null;
}

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_time?: {
    getState: () => {
      play: () => void;
      pause: () => void;
      setTime: (s: number) => void;
      seconds: number;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
  __basher_light_world_positions?: () => [number, number, number][];
  __basher_frustum_pose?: Record<string, { position: [number, number, number] }>;
  __basher_perf_stress?: (opts: { meshes: number; segments?: number }) => {
    firstMeshId: string | null;
  };
}

interface Sample {
  seconds: number;
  z: number | null;
}

/** The drawn z of `subject`, in the page. Serialised into each `page.evaluate`, so it reads only
 *  its arguments and `window`. */
function drawnZ(subject: { kind: SubjectKind; id: string; lightIndex: number }): number | null {
  const w = window as unknown as BasherWindow;
  if (subject.kind === 'mesh') return w.__basher_mesh_world_position!(subject.id)?.[2] ?? null;
  if (subject.kind === 'light')
    return w.__basher_light_world_positions!()[subject.lightIndex]?.[2] ?? null;
  return w.__basher_frustum_pose?.[subject.id]?.position[2] ?? null;
}

async function stage(page: Page, subject: Subject): Promise<Staged> {
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
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow & {
      __basher_dag?: { getState: () => { state: { nodes: Record<string, unknown> } } };
    };
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_selection &&
      w.__basher_perf_stress &&
      w.__basher_light_world_positions &&
      w.__basher_mesh_world_position?.('n_box'),
    );
  });
  const seeded = await page.evaluate(
    ({ n, id, travel, duration }) => {
      const w = window as unknown as BasherWindow & {
        __basher_dag: {
          getState: () => {
            state: { nodes: Record<string, { params: { position?: [number, number, number] } }> };
          };
        };
      };
      w.__basher_perf_stress!({ meshes: n, segments: 8 });
      const base = w.__basher_dag.getState().state.nodes[id]?.params.position ?? null;
      const before = w.__basher_light_world_positions!().map((p) => p[2]);
      if (!base) return { base: null, before, selectId: null };
      w.__basher_dag!.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'p1727_ch',
            nodeType: 'KeyframeChannelVec3',
            params: {
              name: 'position',
              target: id,
              paramPath: 'position',
              keyframes: [
                { time: 0, value: base, easing: 'linear' },
                {
                  time: duration,
                  value: [base[0], base[1], base[2] + travel],
                  easing: 'linear',
                },
              ],
            },
          },
        ],
        'user',
        'p1727-seed-keyed-subject',
      );
      const ids =
        (window as unknown as { __basher_perf_stress_ids?: string[] }).__basher_perf_stress_ids ??
        [];
      return { base, before, selectId: ids[ids.length - 1] ?? null };
    },
    { n: STATIC_NODES, id: subject.id, travel: TRAVEL, duration: DURATION },
  );
  expect(seeded.base, `${subject.id} has a position param to key`).not.toBeNull();
  const setTime = (t: number) =>
    page.evaluate(
      (s) => (window as unknown as BasherWindow).__basher_time!.getState().setTime(s),
      t,
    );
  // A light is found among the drawn lights as the one that moved by the keyed amount.
  let lightIndex = -1;
  if (subject.kind === 'light') {
    await setTime(2);
    await page.waitForFunction(
      ({ before, dz }) =>
        (window as unknown as BasherWindow).__basher_light_world_positions!().some(
          (p, i) => Math.abs(p[2] - (before[i] ?? NaN) - dz) < 1e-3,
        ),
      { before: seeded.before, dz: zAt(0, 2) },
      { timeout: 10_000 },
    );
    lightIndex = await page.evaluate(
      ({ before, dz }) =>
        (window as unknown as BasherWindow).__basher_light_world_positions!().findIndex(
          (p, i) => Math.abs(p[2] - (before[i] ?? NaN) - dz) < 1e-3,
        ),
      { before: seeded.before, dz: zAt(0, 2) },
    );
  }
  // The drawn base: where the subject is drawn at t=0 (its world z; equal to the param unless
  // something above it moves it).
  await setTime(0);
  const staged: Staged = { ...subject, lightIndex, baseZ: NaN, selectId: seeded.selectId };
  // `!== null`, not truthiness: a subject drawn at z = 0 is drawn.
  await page.waitForFunction(
    (sub) => {
      const w = window as unknown as BasherWindow;
      const z =
        sub.kind === 'mesh'
          ? (w.__basher_mesh_world_position!(sub.id)?.[2] ?? null)
          : sub.kind === 'light'
            ? (w.__basher_light_world_positions!()[sub.lightIndex]?.[2] ?? null)
            : (w.__basher_frustum_pose?.[sub.id]?.position[2] ?? null);
      return z !== null;
    },
    staged,
    { timeout: 10_000 },
  );
  staged.baseZ = (await page.evaluate(drawnZ, staged))!;
  // Scrubbed side first: the drawn subject is where the channel says when paused.
  for (const s of [0.5, 2]) {
    await setTime(s);
    await page.waitForFunction(
      ({ sub, exp }) => {
        // Inlined: a serialised function cannot call another one.
        const w = window as unknown as BasherWindow;
        const z =
          sub.kind === 'mesh'
            ? (w.__basher_mesh_world_position!(sub.id)?.[2] ?? null)
            : sub.kind === 'light'
              ? (w.__basher_light_world_positions!()[sub.lightIndex]?.[2] ?? null)
              : (w.__basher_frustum_pose?.[sub.id]?.position[2] ?? null);
        return z !== null && Math.abs(z - exp) < 1e-3;
      },
      { sub: staged, exp: zAt(staged.baseZ, s) },
      { timeout: 10_000 },
    );
  }
  await setTime(0);
  return staged;
}

/** Play under load and sample the drawn z once per animation frame. The busy-wait is a rAF
 *  callback of its own, so it shares every frame with the renderer and React. */
async function playAndSample(page: Page, sub: Staged): Promise<Sample[]> {
  return page.evaluate(
    ({ loadMs, frames, sub }) =>
      new Promise<Sample[]>((resolve) => {
        const w = window as unknown as BasherWindow;
        const read = (): number | null =>
          sub.kind === 'mesh'
            ? (w.__basher_mesh_world_position!(sub.id)?.[2] ?? null)
            : sub.kind === 'light'
              ? (w.__basher_light_world_positions!()[sub.lightIndex]?.[2] ?? null)
              : (w.__basher_frustum_pose?.[sub.id]?.position[2] ?? null);
        const time = w.__basher_time!.getState();
        const out: Sample[] = [];
        let running = true;
        const burn = () => {
          if (!running) return;
          const until = performance.now() + loadMs;
          while (performance.now() < until) {
            /* busy frame */
          }
          requestAnimationFrame(burn);
        };
        requestAnimationFrame(burn);
        time.play();
        let warm = 10;
        const sample = () => {
          if (warm > 0) {
            warm -= 1;
            requestAnimationFrame(sample);
            return;
          }
          out.push({ seconds: w.__basher_time!.getState().seconds, z: read() });
          if (out.length < frames) requestAnimationFrame(sample);
          else {
            running = false;
            w.__basher_time!.getState().pause();
            resolve(out);
          }
        };
        requestAnimationFrame(sample);
      }),
    { loadMs: LOAD_MS, frames: SAMPLE_FRAMES, sub },
  );
}

function verdict(samples: Sample[], base: number) {
  let advanced = 0;
  let moved = 0;
  let offTrack = 0;
  const offTrackExamples: string[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (cur.z === null || prev.z === null) continue;
    // The playhead steps at the film's frame rate, not every browser frame: only a frame on which
    // the playhead advanced is one on which the box must move.
    if (Math.abs(cur.seconds - prev.seconds) > 1e-9) {
      advanced += 1;
      if (Math.abs(cur.z - prev.z) > 1e-6) moved += 1;
    }
    // Within one frame of the scrubbed value: the drawn z may still show the previous tick.
    const lo = Math.min(zAt(base, prev.seconds), zAt(base, cur.seconds)) - 1e-3;
    const hi = Math.max(zAt(base, prev.seconds), zAt(base, cur.seconds)) + 1e-3;
    if (cur.z < lo || cur.z > hi) {
      offTrack += 1;
      if (offTrackExamples.length < 4)
        offTrackExamples.push(
          `t=${cur.seconds.toFixed(3)} drawn=${cur.z.toFixed(3)} scrubbed=${zAt(base, cur.seconds).toFixed(3)}`,
        );
    }
  }
  return {
    advanced,
    moved,
    movedRate: advanced > 0 ? moved / advanced : 0,
    offTrack,
    offTrackExamples,
  };
}

async function expectKeepsMoving(page: Page, sub: Staged, label: string) {
  const samples = await playAndSample(page, sub);
  const v = verdict(samples, sub.baseZ);
  console.log(`[p1727 ${label}] nodes=${STATIC_NODES} load=${LOAD_MS}ms`, JSON.stringify(v));
  expect(
    samples.every((s) => s.z !== null),
    `${sub.id} is drawn on every sampled frame`,
  ).toBe(true);
  expect(v.advanced, 'the playhead advanced on at least 20 sampled frames').toBeGreaterThanOrEqual(
    20,
  );
  expect(
    v.movedRate,
    `${sub.id} moved on ${v.moved} of ${v.advanced} frames the playhead advanced`,
  ).toBeGreaterThanOrEqual(0.9);
  expect(v.offTrack, `off its keys: ${v.offTrackExamples.join('; ')}`).toBe(0);
}

async function selectStatic(page: Page, sub: Staged) {
  expect(sub.selectId, 'a static node to select').not.toBeNull();
  await page.evaluate(
    (id) => (window as unknown as BasherWindow).__basher_selection!.getState().select(id),
    sub.selectId,
  );
}

test.describe('#1726 — a keyed object moves during playback under load', () => {
  test.setTimeout(120_000);

  // #1728 — red before the transform was written directly (moved on 0 of 89 frames); turning
  // `drawsTransformAsGroup` off in `useOverlayDraw` turns it red again.
  test('with an object selected, a keyed box moves every frame and stays on its keys', async ({
    page,
  }) => {
    const sub = await stage(page, { kind: 'mesh', id: 'n_box' });
    await selectStatic(page, sub);
    await expectKeepsMoving(page, sub, 'box selected');
  });

  test('with an object selected, a keyed light moves every frame and stays on its keys', async ({
    page,
  }) => {
    const sub = await stage(page, { kind: 'light', id: 'n_light' });
    await selectStatic(page, sub);
    await expectKeepsMoving(page, sub, 'light selected');
  });

  test("with an object selected, a keyed camera's frustum moves every frame and stays on its keys", async ({
    page,
  }) => {
    const sub = await stage(page, { kind: 'frustum', id: 'n_camera' });
    await selectStatic(page, sub);
    await expectKeepsMoving(page, sub, 'frustum selected');
  });

  test('control: with nothing selected, the same load still moves the box', async ({ page }) => {
    const sub = await stage(page, { kind: 'mesh', id: 'n_box' });
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_selection!.getState().select(null),
    );
    await expectKeepsMoving(page, sub, 'box control');
  });
});
