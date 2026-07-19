// #207 — the Light Brush (epic #201). Observes the modal on the LIVE app: with the
// brush active, clicking a scene mesh PAINTS the selected rig light onto the rig
// sphere at the hit — and the live light follows (panel == viewport, V37).
//
// BOUNDARY-PAIR: after a brush click the selected light's DAG position moves to a
// new spot on its OWN shell (radius preserved, same coordinate system as a panel
// drag, V62), and a live RectAreaLight sits at that DAG position (render == author).
//
// FALSIFICATION: with the brush OFF, clicking the model does NOT move the light
// (it selects the mesh instead) — proving the move is the brush, not a coincidence.
//
// REF: src/app/resolveLightBrushPlacement.ts; src/app/lightBrush.ts;
//      src/viewport/SceneFromDAG.tsx (the onClick brush branch); vyapti V60/V37/V62.

import { expect, test } from './_fixtures';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface BrushWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { params?: { position?: [number, number, number] } }>;
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_three: {
    getState: () => {
      scene: {
        traverse: (
          cb: (o: { type: string; position: { x: number; y: number; z: number } }) => void,
        ) => void;
      } | null;
      camera: {
        position: {
          clone: () => {
            set: (
              x: number,
              y: number,
              z: number,
            ) => { project: (c: unknown) => { x: number; y: number } };
          };
        };
        updateMatrixWorld: () => void;
        matrixWorld: unknown;
        matrixWorldInverse: { copy: (m: unknown) => { invert: () => void } };
      } | null;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string) => void; primaryNodeId: string | null };
  };
  __basher_mesh_world_position: (id: string) => [number, number, number] | null;
}

async function addRigLight(page: import('@playwright/test').Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as BrushWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        // Move + enlarge the cube into the UPPER viewport — clear of the agent-chat
        // island (floats over centre) and the camera-helper frustum lines (cross the
        // origin) — so the projected click lands on solid cube body, not chrome.
        { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [0, 4, 0] },
        // #365 Slice 2: `size` lives on the split cube's BoxData; a setParam aimed at
        // the Object (`n_box`) is silently rejected, so target `n_box_data`.
        { type: 'setParam', nodeId: 'n_box_data', paramPath: 'size', value: [3, 3, 3] },
        {
          type: 'addNode',
          nodeId: id,
          nodeType: 'AreaLight',
          params: {
            intensity: 5,
            position: [6, 0, 0],
            color: '#ffffff',
            width: 2,
            height: 2,
            lookAt: [0, 0, 0],
          },
        },
        {
          type: 'connect',
          from: { node: id, socket: 'out' },
          to: { node: sceneId, socket: 'lights' },
        },
        {
          type: 'addNode',
          nodeId: `${id}_tt`,
          nodeType: 'TrackTo',
          params: { target: id, aimNode: '', aimPoint: [0, 0, 0], up: [0, 1, 0], mute: false },
        },
      ],
      'e2e',
      'add rig light',
    );
  }, id);
}

const lightPos = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((id) => {
    const w = window as unknown as BrushWindow;
    return w.__basher_dag.getState().state.nodes[id]?.params?.position ?? null;
  }, id);

/** Click the on-screen pixel where the cube (n_box, world origin) renders — by
 *  projecting its world position through the live editor camera (the
 *  p6-w5-first-run pattern), so the click lands on the mesh regardless of framing. */
async function clickCube(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as BrushWindow).__basher_three.getState().camera != null,
  );
  const pt = await page.evaluate(() => {
    const w = window as unknown as BrushWindow;
    const cam = w.__basher_three.getState().camera!;
    const pos = w.__basher_mesh_world_position('n_box');
    if (!pos) return null;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    // The cube was moved to [0,4,0] (upper viewport); project its centre straight.
    const v = cam.position.clone().set(pos[0], pos[1], pos[2]).project(cam);
    const canvas = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  });
  if (!pt) throw new Error('could not project n_box');
  await page.mouse.click(pt.x, pt.y);
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
    const w = window as unknown as BrushWindow;
    return Boolean(
      w.__basher_dag &&
      w.__basher_three &&
      w.__basher_selection &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('#207 — brushing the model moves the selected light onto its shell; the live light follows', async ({
  page,
}) => {
  await addRigLight(page, 'brush_light_e2e');
  await page.evaluate(() =>
    (window as unknown as BrushWindow).__basher_selection.getState().select('brush_light_e2e'),
  );

  // Open the Light Studio tab and enable the brush.
  const toggle = page.getByTestId('timeline-drawer-toggle');
  if ((await page.getByTestId('timeline-drawer').getAttribute('data-open')) !== 'true')
    await toggle.click();
  await page.getByTestId('timeline-tab-lightStudio').click();
  await page.getByTestId('light-studio-brush-toggle').click();
  await expect(page.getByTestId('light-studio-brush-toggle')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const before = await lightPos(page, 'brush_light_e2e');
  expect(before).toEqual([6, 0, 0]);

  await clickCube(page);

  // The light moved to a NEW spot on the SAME radius-6 shell.
  const after = await lightPos(page, 'brush_light_e2e');
  expect(after).not.toBeNull();
  expect(after).not.toEqual(before);
  expect(Math.hypot(...after!)).toBeCloseTo(6, 3);

  // A live RectAreaLight sits at the new DAG position (render == author, V37).
  const nearest = await page.evaluate(
    (exp) => {
      const w = window as unknown as BrushWindow;
      let best: number | null = null;
      w.__basher_three.getState().scene?.traverse((o) => {
        if (o.type !== 'RectAreaLight') return;
        const d = Math.hypot(o.position.x - exp[0], o.position.y - exp[1], o.position.z - exp[2]);
        if (best === null || d < best) best = d;
      });
      return best;
    },
    after as [number, number, number],
  );
  expect(nearest).not.toBeNull();
  expect(nearest!).toBeLessThan(0.1);
});

test('#207 — with the brush OFF, clicking the model does NOT move the light (falsification)', async ({
  page,
}) => {
  await addRigLight(page, 'nobrush_light_e2e');
  await page.evaluate(() =>
    (window as unknown as BrushWindow).__basher_selection.getState().select('nobrush_light_e2e'),
  );

  // Brush stays OFF.
  const before = await lightPos(page, 'nobrush_light_e2e');
  await clickCube(page);
  const after = await lightPos(page, 'nobrush_light_e2e');
  expect(after).toEqual(before); // a plain click selects a mesh; the light is untouched
});
