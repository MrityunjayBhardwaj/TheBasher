// #1727 (0.3) — does an exported animation show a keyed object where scrubbing puts it, when the
// frame is loaded and something is selected? Playback freezes in that state (#1726,
// p1727-playback-under-load); export renders the same live scene, one frame at a time, so this
// answers whether the freeze reaches the file.
//
// Fixture: the playback-under-load one — the default `n_box` keyed along z, N static spheres, the
// last sphere selected, and a busy-wait of LOAD_MS in every animation frame — exported as a
// 30-frame PNG sequence through the real action (`__basher_render_animation`).
//
// What is read: the box's DRAWN world z at the moment each frame is captured. The export renders
// the live scene through its own camera (`renderToImage.ts` builds one from the camera pose), so
// the spec wraps `renderer.render` and, on each call that draws the live scene through a camera
// other than the viewport's, reads the box's world position (`__basher_mesh_world_position`, the
// real three.js object) and the scene time the frame was set to. Each must equal the scrubbed z
// at that time within 1e-3. The control — nothing selected — separates "the frame is busy" from
// "the selection starves the update".
//
// The answer, measured 2026-10-29 on the dev build (400 spheres, 12 ms load): export WAS affected.
// With the sphere selected, 21 and then 10 of 30 frames (two runs) were captured with the box one
// frame behind (drawn 3, scrubbed 4 at t = 1/15 s); with nothing selected, 0 of 30 both times.
// The selected sphere's gizmo searched the whole scene for its parent's world on every playhead
// change, at a cost quadratic in the scene (#1729); with that read walking up its parents instead,
// 0 of 30 on three runs. This pins it. It does not show the freeze itself is gone: playback under
// the same load still freezes (p1727-playback-under-load, #1726).

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

const STATIC_NODES = parseInt(process.env.P1727_NODES ?? '400', 10);
const LOAD_MS = parseFloat(process.env.P1727_LOAD_MS ?? '12');
const FRAMES = 30;
// z travels 60 units a second, one unit per exported frame — far above the 1e-3 tolerance.
const SPEED = 60;
const zAt = (s: number) => SPEED * Math.min(Math.max(s, 0), 1);

interface Capture {
  seconds: number;
  z: number | null;
}

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene: { node: string } } };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void; seconds: number } };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_mesh_world_position: (nodeId: string) => [number, number, number] | null;
  __basher_perf_stress: (opts: { meshes: number; segments?: number }) => unknown;
  __basher_perf_stress_ids?: string[];
  __basher_three: {
    getState: () => {
      gl: { render: (scene: unknown, camera: unknown) => void } | null;
      scene: unknown;
      camera: unknown;
    };
  };
  __basher_render_animation: (format: 'png-sequence') => Promise<{ ok: boolean; reason?: string }>;
  __basher_render_png?: () => Promise<unknown>;
  __p1727_captures?: Capture[];
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
    const w = window as unknown as Partial<W>;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_selection &&
      w.__basher_perf_stress &&
      w.__basher_three?.getState().gl &&
      w.__basher_render_animation &&
      w.__basher_mesh_world_position?.('n_box'),
    );
  });
  // Warm the offscreen pipeline once (p189: the first readback after a cold load can drop the
  // context, and the setup should absorb that, not the measurement).
  await page.evaluate(() => (window as unknown as W).__basher_render_png?.()).catch(() => {});
  const last = await page.evaluate(
    ({ n, frames, speed }) => {
      const w = window as unknown as W;
      w.__basher_perf_stress({ meshes: n, segments: 8 });
      const dag = w.__basher_dag.getState();
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'p1727x_ch',
            nodeType: 'KeyframeChannelVec3',
            params: {
              name: 'position',
              target: 'n_box',
              paramPath: 'position',
              keyframes: [
                { time: 0, value: [0, 0, 0], easing: 'linear' },
                { time: 1, value: [0, 0, speed], easing: 'linear' },
              ],
            },
          },
          {
            type: 'setParam',
            nodeId: dag.state.outputs.scene.node,
            paramPath: 'frameEnd',
            value: frames - 1,
          },
        ],
        'user',
        'p1727-export-fixture',
      );
      const ids = w.__basher_perf_stress_ids ?? [];
      return ids[ids.length - 1] ?? null;
    },
    { n: STATIC_NODES, frames: FRAMES, speed: SPEED },
  );
  // The scrubbed side: paused, the drawn box is where the channel says.
  for (const s of [0.1, 0.4]) {
    await page.evaluate((t) => (window as unknown as W).__basher_time.getState().setTime(t), s);
    await page.waitForFunction(
      (exp) => {
        const p = (window as unknown as W).__basher_mesh_world_position('n_box');
        return p !== null && Math.abs(p[2] - exp) < 1e-3;
      },
      zAt(s),
      { timeout: 10_000 },
    );
  }
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0));
  return last;
}

/** Export under load; return the drawn box z at each captured frame, in order. */
async function exportAndRead(page: Page): Promise<{ ok: boolean; captures: Capture[] }> {
  const [, result] = await Promise.all([
    page.waitForEvent('download', { timeout: 240_000 }),
    page.evaluate(async (loadMs) => {
      const w = window as unknown as W;
      const three = w.__basher_three.getState();
      const gl = three.gl!;
      const viewCamera = three.camera;
      const original = gl.render;
      const captures: Capture[] = [];
      gl.render = function (this: unknown, scene: unknown, camera: unknown) {
        if (scene === three.scene && camera !== viewCamera) {
          const seconds = w.__basher_time.getState().seconds;
          // One read per exported frame: a capture may draw more than once (MSAA, passes).
          if (captures.length === 0 || captures[captures.length - 1].seconds !== seconds) {
            const p = w.__basher_mesh_world_position('n_box');
            captures.push({ seconds, z: p ? p[2] : null });
          }
        }
        return original.call(this, scene, camera);
      } as typeof gl.render;
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
      try {
        const r = await w.__basher_render_animation('png-sequence');
        return { ok: r.ok, reason: r.reason, captures };
      } finally {
        running = false;
        gl.render = original;
      }
    }, LOAD_MS),
  ]);
  return result;
}

function offTrack(captures: Capture[]): string[] {
  return captures
    .filter((c) => c.z === null || Math.abs(c.z - zAt(c.seconds)) > 1e-3)
    .map(
      (c) =>
        `t=${c.seconds.toFixed(4)} drawn=${c.z?.toFixed(3)} scrubbed=${zAt(c.seconds).toFixed(3)}`,
    );
}

test.describe('#1727 — an export under load shows the keyed object where scrubbing does', () => {
  test.setTimeout(300_000);

  test('with an object selected, every exported frame has the box on its keys', async ({
    page,
  }) => {
    const selectId = await stage(page);
    expect(selectId, 'a static node to select').not.toBeNull();
    await page.evaluate(
      (id) => (window as unknown as W).__basher_selection.getState().select(id),
      selectId,
    );
    const { ok, captures } = await exportAndRead(page);
    const bad = offTrack(captures);
    console.log(
      `[p1727 export selected] nodes=${STATIC_NODES} load=${LOAD_MS}ms captured=${captures.length} offTrack=${bad.length}`,
      bad.slice(0, 4).join('; '),
    );
    expect(ok).toBe(true);
    expect(captures.length, 'one read per exported frame').toBe(FRAMES);
    expect(bad, 'frames whose drawn box is off its keys').toEqual([]);
  });

  test('control: with nothing selected, every exported frame has the box on its keys', async ({
    page,
  }) => {
    await stage(page);
    await page.evaluate(() => (window as unknown as W).__basher_selection.getState().select(null));
    const { ok, captures } = await exportAndRead(page);
    const bad = offTrack(captures);
    console.log(
      `[p1727 export control] nodes=${STATIC_NODES} load=${LOAD_MS}ms captured=${captures.length} offTrack=${bad.length}`,
      bad.slice(0, 4).join('; '),
    );
    expect(ok).toBe(true);
    expect(captures.length, 'one read per exported frame').toBe(FRAMES);
    expect(bad, 'frames whose drawn box is off its keys').toEqual([]);
  });
});
