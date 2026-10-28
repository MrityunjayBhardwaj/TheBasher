// #1727 / #1726 — a keyed object keeps moving during playback while something is selected and the
// frame is busy.
//
// What this guards: per-frame animation must reach the drawn object every frame, whatever else
// React has to do. Today a keyed object moves by a React state update made inside the frame loop
// (`DirectChannelsR`), while the gizmo of the selected object re-renders on every playhead tick at a
// higher React priority. When the frame is full, the keyed object's update is never rendered and it
// stands still until playback pauses (#1726).
//
// Fixture: the default scene's `n_box`, keyed by a free-floating position channel (the #197 road),
// plus N static spheres (the scene-size half of the load) and a busy-wait of LOAD_MS inside every
// animation frame (the frame-budget half). Nothing in the product is changed to make the load.
//
// Observation, per animation frame during play: the box's DRAWN world z (`__basher_mesh_world_position`,
// the real three.js object) and the playhead's seconds. The box must move on at least 90% of
// sampled frames, and each drawn z must sit within one frame of where scrubbing puts it.
//
// The second test is the control: the same load with nothing selected. It separates "the frame is
// slow" from "the selected object's per-tick work starves the animation".

import { test, expect, type Page } from './_fixtures';

const STATIC_NODES = parseInt(process.env.P1727_NODES ?? '400', 10);
const LOAD_MS = parseFloat(process.env.P1727_LOAD_MS ?? '12');
const SAMPLE_FRAMES = 90;
// The box travels z 0 → 150 over 60 s, linear, so z(t) = 2.5 t. Long enough that a slow headless
// frame (~100 ms here) never runs the playhead past the last key while sampling.
const DURATION = 60;
const TRAVEL = 150;
const zAt = (s: number) => (TRAVEL * Math.min(Math.max(s, 0), DURATION)) / DURATION;

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
  __basher_perf_stress?: (opts: { meshes: number; segments?: number }) => {
    firstMeshId: string | null;
  };
}

interface Sample {
  seconds: number;
  z: number | null;
}

async function stage(page: Page): Promise<string | null> {
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
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_selection &&
      w.__basher_perf_stress &&
      w.__basher_mesh_world_position?.('n_box'),
    );
  });
  const lastMeshId = await page.evaluate(
    ({ n }) => {
      const w = window as unknown as BasherWindow;
      const seeded = w.__basher_perf_stress!({ meshes: n, segments: 8 });
      w.__basher_dag!.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'p1727_ch',
            nodeType: 'KeyframeChannelVec3',
            params: {
              name: 'position',
              target: 'n_box',
              paramPath: 'position',
              keyframes: [
                { time: 0, value: [0, 0, 0], easing: 'linear' },
                { time: 60, value: [0, 0, 150], easing: 'linear' },
              ],
            },
          },
        ],
        'user',
        'p1727-seed-keyed-box',
      );
      void seeded;
      const ids =
        (window as unknown as { __basher_perf_stress_ids?: string[] }).__basher_perf_stress_ids ??
        [];
      return ids[ids.length - 1] ?? null;
    },
    { n: STATIC_NODES },
  );
  // Scrubbed side first: the drawn box is where the channel says when paused.
  for (const s of [0.5, 2]) {
    await page.evaluate(
      (t) => (window as unknown as BasherWindow).__basher_time!.getState().setTime(t),
      s,
    );
    await page.waitForFunction(
      (exp) => {
        const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
        return p !== null && Math.abs(p[2] - exp) < 1e-3;
      },
      zAt(s),
      { timeout: 10_000 },
    );
  }
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(0),
  );
  return lastMeshId;
}

/** Play under load and sample the drawn z once per animation frame. The busy-wait is a rAF
 *  callback of its own, so it shares every frame with the renderer and React. */
async function playAndSample(page: Page): Promise<Sample[]> {
  return page.evaluate(
    ({ loadMs, frames }) =>
      new Promise<Sample[]>((resolve) => {
        const w = window as unknown as BasherWindow;
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
          const p = w.__basher_mesh_world_position!('n_box');
          out.push({ seconds: w.__basher_time!.getState().seconds, z: p ? p[2] : null });
          if (out.length < frames) requestAnimationFrame(sample);
          else {
            running = false;
            w.__basher_time!.getState().pause();
            resolve(out);
          }
        };
        requestAnimationFrame(sample);
      }),
    { loadMs: LOAD_MS, frames: SAMPLE_FRAMES },
  );
}

function verdict(samples: Sample[]) {
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
    const lo = Math.min(zAt(prev.seconds), zAt(cur.seconds)) - 1e-3;
    const hi = Math.max(zAt(prev.seconds), zAt(cur.seconds)) + 1e-3;
    if (cur.z < lo || cur.z > hi) {
      offTrack += 1;
      if (offTrackExamples.length < 4)
        offTrackExamples.push(
          `t=${cur.seconds.toFixed(3)} drawn=${cur.z.toFixed(3)} scrubbed=${zAt(cur.seconds).toFixed(3)}`,
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

test.describe('#1726 — a keyed object moves during playback under load', () => {
  test.setTimeout(120_000);

  test('with an object selected, the keyed box moves every frame and stays on its keys', async ({
    page,
  }) => {
    // RED TODAY (#1726): the box stays where it was when play began. Marked expected-to-fail so
    // the suite stays green until #1728 lands; the fix turns this into an unexpected pass, which
    // fails the run until this line is removed.
    test.fail(true, '#1726: keyed objects freeze during playback while something is selected');
    const selectId = await stage(page);
    expect(selectId, 'a static node to select').not.toBeNull();
    await page.evaluate(
      (id) => (window as unknown as BasherWindow).__basher_selection!.getState().select(id),
      selectId,
    );
    const samples = await playAndSample(page);
    const v = verdict(samples);
    console.log(`[p1727 selected] nodes=${STATIC_NODES} load=${LOAD_MS}ms`, JSON.stringify(v));
    expect(
      samples.every((s) => s.z !== null),
      'the box is drawn on every sampled frame',
    ).toBe(true);
    expect(
      v.advanced,
      'the playhead advanced on at least 20 sampled frames',
    ).toBeGreaterThanOrEqual(20);
    expect(
      v.movedRate,
      `moved on ${v.moved} of ${v.advanced} frames the playhead advanced`,
    ).toBeGreaterThanOrEqual(0.9);
    expect(v.offTrack, `off its keys: ${v.offTrackExamples.join('; ')}`).toBe(0);
  });

  test('control: with nothing selected, the same load still moves the box', async ({ page }) => {
    await stage(page);
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_selection!.getState().select(null),
    );
    const samples = await playAndSample(page);
    const v = verdict(samples);
    console.log(`[p1727 control] nodes=${STATIC_NODES} load=${LOAD_MS}ms`, JSON.stringify(v));
    expect(samples.every((s) => s.z !== null)).toBe(true);
    expect(
      v.movedRate,
      `moved on ${v.moved} of ${v.advanced} frames the playhead advanced`,
    ).toBeGreaterThanOrEqual(0.9);
    expect(v.offTrack, `off its keys: ${v.offTrackExamples.join('; ')}`).toBe(0);
  });
});
