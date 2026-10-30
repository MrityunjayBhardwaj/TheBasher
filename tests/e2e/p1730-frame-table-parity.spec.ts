// #1730 — the frame table's world for a node equals the world it is DRAWN at.
//
// The frame evaluator keeps this frame's answers (`__basher_frame_table`): a node's world matrix,
// asked for by id, as `resolveWorldTransform` gives it on the node's clock at the live playhead,
// and the three.js objects drawn as carrying that node's world (the overlay group the keyed
// transform is written onto). Readers move onto the table next (#1731), so the table must say
// where things are drawn, not where some other road thinks they are. This is that check, on both
// sides of the boundary: the table's matrix against the drawn object's `matrixWorld`, element by
// element, at 20 playhead times.
//
// Subject: the default scene's `n_box`, keyed on position AND rotation (so every part of the
// matrix moves), drawn through the mesh overlay.

import { test, expect } from './_fixtures';

const TIMES = Array.from({ length: 20 }, (_, i) => +(i * 0.37 + 0.05).toFixed(3));

test('the frame table world equals the drawn world at 20 times', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, unknown>;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_frame_table);
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
              const table = (
                window as unknown as {
                  __basher_frame_table: {
                    world: (id: string) => number[] | null;
                    drawn: (id: string) => Set<{ matrixWorld: { elements: number[] } }>;
                  };
                }
              ).__basher_frame_table;
              const world = table.world('n_box');
              const drawn = [...table.drawn('n_box')];
              let maxDiff = world && drawn.length ? 0 : Infinity;
              for (const o of drawn)
                for (let i = 0; i < 16; i++)
                  maxDiff = Math.max(maxDiff, Math.abs(o.matrixWorld.elements[i] - world![i]));
              resolve({ t: s, maxDiff, drawn: drawn.length, x: world ? world[12] : NaN });
            }),
          ),
        ),
      t,
    );
    rows.push(row);
  }
  console.log(`[p1730] ${JSON.stringify(rows.map((r) => [r.t, r.drawn, r.maxDiff]))}`);
  for (const r of rows) {
    expect(r.drawn, `t=${r.t}: n_box is drawn by a registered object`).toBeGreaterThan(0);
    // float32 matrixWorld vs float64 compose: equal to well under a millionth of a unit.
    expect(r.maxDiff, `t=${r.t}: table world vs drawn matrixWorld`).toBeLessThan(1e-5);
  }
  // The subject did move: a check of two frozen worlds would pass too.
  expect(rows.length).toBe(20);
  expect(Math.abs(rows[19].x - rows[0].x)).toBeGreaterThan(1);
});
