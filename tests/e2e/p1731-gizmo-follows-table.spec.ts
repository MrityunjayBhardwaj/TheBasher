// #1731 (4.1) — the gizmos follow the playhead from the frame loop, not through React.
//
// Each gizmo (one object, several, a camera) subscribed React to the playhead, so while
// something was selected the gizmo — and the TransformControls under it — re-rendered on every
// playback frame, only to move a proxy group. The proxy now moves in a frame callback that runs
// after the frame evaluator, whenever the playhead has moved.
//
// What is read:
//   - commits of the gizmo subtree (`<PerfBoundary id="gizmo">`) per playback frame, for each
//     kind of selection, from the profiler's per-subtree commit count. Load-independent: a count,
//     not a time;
//   - where the proxy sits against the frame table's world (`__basher_frame_table.world`) and the
//     drawn object (`__basher_mesh_world_position`), at scrubbed times and after playback stops.
//
// Fixture: N stress spheres; Group pg1 (keyed along x) ⊃ pg2 ⊃ `p_sel`; the default box keyed
// along z. The camera row selects the default camera, which nothing keys: its proxy must still
// not commit per frame.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

const OBJECTS = parseInt(process.env.P1731_OBJECTS ?? '100', 10);
const FRAMES = 90;

type V3 = [number, number, number];
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene: { node: string } } };
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_time: {
    getState: () => { setTime: (s: number) => void; play: () => void; pause: () => void };
  };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void; selectMany: (ids: string[]) => void };
  };
  __basher_perf_stress: (opts: { meshes: number; segments?: number }) => unknown;
  __basher_perf: {
    start: () => void;
    stop: () => { subtreeCommits: Record<string, number>; frames: number };
  };
  __basher_frame_table: { world: (id: string) => readonly number[] | null };
  __basher_mesh_world_position: (id: string) => V3 | null;
  __basher_gizmo?: () => { position: V3 } | null;
  __basher_gizmo_multi?: () => { count: number; pivot: V3 };
  __basher_camera_gizmo?: () => { position: V3 | null };
}

async function stage(page: Page) {
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
      w.__basher_perf &&
      w.__basher_frame_table &&
      w.__basher_mesh_world_position,
    );
  });
  await page.evaluate((objects) => {
    const w = window as unknown as W;
    w.__basher_perf_stress({ meshes: objects, segments: 8 });
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    const key = (nodeId: string, target: string, from: V3, to: V3) => ({
      type: 'addNode',
      nodeId,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: from, easing: 'linear' },
          { time: 4, value: to, easing: 'linear' },
        ],
      },
    });
    dag.dispatchAtomic(
      [
        { type: 'addNode', nodeId: 'pg1', nodeType: 'Group', params: { position: [0, 2, 0] } },
        { type: 'addNode', nodeId: 'pg2', nodeType: 'Group', params: { position: [1, 0, 0] } },
        {
          type: 'addNode',
          nodeId: 'p_sel_data',
          nodeType: 'SphereData',
          params: { radius: 0.3, widthSegments: 8, heightSegments: 8 },
        },
        {
          type: 'addNode',
          nodeId: 'p_sel',
          nodeType: 'Object',
          params: { position: [0, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          type: 'connect',
          from: { node: 'p_sel_data', socket: 'out' },
          to: { node: 'p_sel', socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: 'p_sel', socket: 'out' },
          to: { node: 'pg2', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'pg2', socket: 'out' },
          to: { node: 'pg1', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'pg1', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        key('pk_g1', 'pg1', [0, 2, 0], [8, 2, 0]),
        key('pk_box', 'n_box', [0, 0, 0], [0, 0, 8]),
        { type: 'setParam', nodeId: sceneId, paramPath: 'frameEnd', value: 600 },
      ],
      'user',
      'p1731 fixture',
    );
  }, OBJECTS);
  await page.waitForTimeout(300);
}

async function select(page: Page, ids: string[]) {
  await page.evaluate((ids) => {
    (window as unknown as W).__basher_selection.getState().selectMany(ids);
  }, ids);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** Gizmo-subtree commits per frame over FRAMES frames of playback. */
async function commitsPerFrame(page: Page): Promise<{ commits: number; frames: number }> {
  return page.evaluate(async (frames) => {
    const w = window as unknown as W;
    const t = w.__basher_time.getState();
    t.setTime(0);
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    t.play();
    w.__basher_perf.start();
    for (let i = 0; i < frames; i++)
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const s = w.__basher_perf.stop();
    t.pause();
    return { commits: s.subtreeCommits.gizmo ?? 0, frames: s.frames };
  }, FRAMES);
}

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      ),
  );
}

const translation = (m: readonly number[] | null): V3 | null => (m ? [m[12], m[13], m[14]] : null);
const far = (a: V3 | null, b: V3 | null) =>
  !a || !b ? Infinity : Math.max(...a.map((v, i) => Math.abs(v - b[i])));

test('#1731 the gizmos follow the playhead without re-rendering', async ({ page }) => {
  test.setTimeout(300_000);
  await stage(page);

  // Where the single gizmo sits, against the table and the drawn sphere: scrubbed, paused.
  await select(page, ['p_sel']);
  for (const s of [0.5, 1.7, 3.2]) {
    await page.evaluate((s) => (window as unknown as W).__basher_time.getState().setTime(s), s);
    await settle(page);
    const got = await page.evaluate(() => {
      const w = window as unknown as W;
      return {
        gizmo: w.__basher_gizmo?.()?.position ?? null,
        table: w.__basher_frame_table.world('p_sel'),
        drawn: w.__basher_mesh_world_position('p_sel'),
      };
    });
    // pg1 at (2s, 2, 0), pg2 +1 in x, p_sel +1 in z.
    const want: V3 = [2 * s + 1, 2, 1];
    expect(far(got.gizmo, want), `gizmo at ${s}: ${JSON.stringify(got.gizmo)}`).toBeLessThan(1e-6);
    expect(far(translation(got.table), want), `table at ${s}`).toBeLessThan(1e-6);
    expect(far(got.drawn, want), `drawn at ${s}`).toBeLessThan(1e-6);
  }

  const rows: { kind: string; commits: number; frames: number }[] = [];
  for (const [kind, ids] of [
    ['nothing', []],
    ['single (nested, keyed parent)', ['p_sel']],
    ['multi (box + nested)', ['n_box', 'p_sel']],
    ['camera', ['n_camera']],
  ] as const) {
    if (ids.length === 0)
      await page.evaluate(() =>
        (window as unknown as W).__basher_selection.getState().select(null),
      );
    else await select(page, [...ids]);
    const r = await commitsPerFrame(page);
    rows.push({ kind, ...r });
    // After playback stops, the proxy is where the selection is drawn.
    await settle(page);
    const after = await page.evaluate((kind) => {
      const w = window as unknown as W;
      const drawn = (id: string) => w.__basher_mesh_world_position(id);
      if (kind.startsWith('single'))
        return { gizmo: w.__basher_gizmo?.()?.position ?? null, want: drawn('p_sel') };
      if (kind.startsWith('multi')) {
        const a = drawn('n_box');
        const b = drawn('p_sel');
        return {
          gizmo: w.__basher_gizmo_multi?.().pivot ?? null,
          want: a && b ? (a.map((v, i) => (v + b[i]) / 2) as V3) : null,
        };
      }
      if (kind === 'camera') {
        const m = w.__basher_frame_table.world('n_camera');
        return {
          gizmo: w.__basher_camera_gizmo?.().position ?? null,
          want: m ? ([m[12], m[13], m[14]] as V3) : null,
        };
      }
      return null;
    }, kind);
    if (after)
      expect(
        far(after.gizmo, after.want),
        `${kind}: proxy after playback ${JSON.stringify(after)}`,
      ).toBeLessThan(1e-6);
  }
  console.log(
    `\n[p1731] gizmo-subtree commits over ${FRAMES} playback frames, ${OBJECTS} stress spheres\n` +
      rows
        .map((r) => `  ${r.kind.padEnd(30)} ${r.commits} commits / ${r.frames} frames`)
        .join('\n') +
      '\n',
  );
  for (const r of rows) {
    expect(r.frames, `${r.kind}: the run counted frames`).toBeGreaterThan(FRAMES / 2);
    expect(
      r.commits,
      `${r.kind}: the gizmo does not re-render per playback frame`,
    ).toBeLessThanOrEqual(2);
  }
});
