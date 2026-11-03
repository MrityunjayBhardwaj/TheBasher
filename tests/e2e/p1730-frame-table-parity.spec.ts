// #1730 — the world a reader resolves for a node equals the world it is DRAWN at.
//
// The gizmo, the camera aim and a constraint read a node's world through `resolveWorldTransform`
// (`__basher_world_transform`); the viewport draws it through the frame evaluator's ticks. This
// checks both sides of that boundary at 20 playhead times: the resolved matrix's translation and
// rotation against the drawn mesh's world position and quaternion. (#1730 read the resolved side
// off a frame table; nothing in the app read that table, and #1748 cut it.)
//
// Subject: the default scene's `n_box`, keyed on position AND rotation (so every part of the
// matrix moves), drawn through the mesh overlay.

import { test, expect } from './_fixtures';

const TIMES = Array.from({ length: 20 }, (_, i) => +(i * 0.37 + 0.05).toFixed(3));

test('the resolved world equals the drawn world at 20 times', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, unknown>;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_world_transform &&
      w.__basher_mesh_world_position &&
      w.__basher_mesh_world_quaternion,
    );
  });
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_dag: {
        getState: () => {
          state: { nodes: Record<string, { params: { position?: number[] } }> };
          dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
        };
      };
    };
    const base = w.__basher_dag.getState().state.nodes.n_box.params.position ?? [0, 0, 0];
    const key = (id: string, name: string, a: number[], b: number[]) => ({
      type: 'addNode',
      nodeId: id,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name,
        target: 'n_box',
        paramPath: name,
        keyframes: [
          { time: 0, value: a, easing: 'linear' },
          { time: 8, value: b, easing: 'linear' },
        ],
      },
    });
    w.__basher_dag
      .getState()
      .dispatchAtomic(
        [
          key('p1730_pos', 'position', base, [base[0] + 3, base[1] - 1, base[2] + 5]),
          key('p1730_rot', 'rotation', [0, 0, 0], [40, 120, -70]),
        ],
        'user',
        'p1730-seed',
      );
  });

  const rows: { t: number; maxDiff: number; drawn: number; x: number }[] = [];
  for (const t of TIMES) {
    await page.evaluate(
      (s) =>
        (
          window as unknown as {
            __basher_time: { getState: () => { setTime: (s: number) => void } };
          }
        ).__basher_time
          .getState()
          .setTime(s),
      t,
    );
    // Two frames: the evaluator writes at the start of one, the render updates matrixWorld.
    const row = await page.evaluate(
      (s) =>
        new Promise<{ t: number; maxDiff: number; drawn: number; x: number }>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const w = window as unknown as {
                __basher_world_transform: (
                  id: string,
                  ctx: unknown,
                ) => { matrix: readonly number[] } | null;
                __basher_mesh_world_position: (id: string) => number[] | null;
                __basher_mesh_world_quaternion: (id: string) => number[] | null;
              };
              const m =
                w.__basher_world_transform('n_box', {
                  time: { frame: Math.round(s * 30), seconds: s, normalized: 0 },
                })?.matrix ?? null;
              const p = w.__basher_mesh_world_position('n_box');
              const q = w.__basher_mesh_world_quaternion('n_box');
              if (!m || !p || !q) return resolve({ t: s, maxDiff: Infinity, drawn: 0, x: NaN });
              // The drawn rotation as a column-major 3×3 (unit scale), against the resolved one.
              const [x, y, z, qw] = q;
              const r = [
                [1 - 2 * (y * y + z * z), 2 * (x * y + qw * z), 2 * (x * z - qw * y)],
                [2 * (x * y - qw * z), 1 - 2 * (x * x + z * z), 2 * (y * z + qw * x)],
                [2 * (x * z + qw * y), 2 * (y * z - qw * x), 1 - 2 * (x * x + y * y)],
              ];
              let maxDiff = 0;
              for (let c = 0; c < 3; c++) {
                maxDiff = Math.max(maxDiff, Math.abs(p[c] - m[12 + c]));
                for (let k = 0; k < 3; k++)
                  maxDiff = Math.max(maxDiff, Math.abs(r[c][k] - m[c * 4 + k]));
              }
              resolve({ t: s, maxDiff, drawn: 1, x: m[12] });
            }),
          ),
        ),
      t,
    );
    rows.push(row);
  }
  console.log(`[p1730] ${JSON.stringify(rows.map((r) => [r.t, r.drawn, r.maxDiff]))}`);
  for (const r of rows) {
    expect(r.drawn, `t=${r.t}: n_box is drawn and resolves`).toBeGreaterThan(0);
    // float32 matrixWorld vs float64 compose: equal to well under a millionth of a unit.
    expect(r.maxDiff, `t=${r.t}: resolved world vs drawn world`).toBeLessThan(1e-5);
  }
  // The subject did move: a check of two frozen worlds would pass too.
  expect(rows.length).toBe(20);
  expect(Math.abs(rows[19].x - rows[0].x)).toBeGreaterThan(1);
});
