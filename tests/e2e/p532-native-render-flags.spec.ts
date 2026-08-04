// #532 / #536 S6 — the native road honours the render-mode flags its own editor offers.
//
// The material editor has always shown Double sided / Alpha cutout / Vertex colors. On a
// native primitive they ticked, persisted, saved — and drew nothing: `openpbrToThree`
// compiled all three, only the glTF road consumed them, and the native build never read
// them. A control the inspector offers must be one the fold honours.
//
// TWO of the three are now honoured. The third, `vertexColors`, is honoured by NOT being
// applied, and that is a decision with a measurement behind it: it asks the shader for a
// COLOR_0 attribute a BoxGeometry does not have, and wiring it through renders the box
// pure black. The inspector already hides that checkbox on this road — its comment said
// "toggling is a no-op", a premise this slice would otherwise have quietly falsified.
//
// ── WHY THIS NEEDS A BROWSER AT ALL ────────────────────────────────────────────────
//
// The unit tier covers both halves of the seam — that the spec carries the fields
// (`primitiveMaterialInputs.test.ts`, where a dropped field collapses its corpus world
// onto the base and reds the vacuity check) and that the build applies them
// (`materialRegistry.test.ts`, enumerated off the spec). What no unit case can say is
// that the flags reach a mesh in a live scene through the real evaluator, the real
// suspense hooks and the real registry — the road #532 was actually lost on.
//
// ── THE CONTROLS ───────────────────────────────────────────────────────────────────
//
// Every flag is read BEFORE the edit and asserted to sit at three's own default, so
// "it is 2 afterwards" is a statement about the edit rather than about the default. And
// roughness — a field the native road has always applied — moves in the same case, so a
// red here is about these three fields and not about a road that stopped working.
//
// REF: src/app/materialRegistry.ts (`build`), src/app/material/primitiveMaterialInputs.ts
//      (`primitiveMaterialSpec` — where `doubleSided` becomes `side`),
//      src/app/material/openpbrToThree.ts (the compile, which was always correct),
//      issues #532, #536.

import { expect, test } from './_fixtures';
import type { Op } from '../../src/core/dag/ops';

interface UiWindow {
  __basher_three: { getState: () => { scene: unknown } };
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], src: string, label: string) => void;
    };
  };
}

const FRONT_SIDE = 0;
const DOUBLE_SIDE = 2;
const CUTOFF = 0.5;
const ROUGH_BEFORE = 0.5;
const OWN_COLOR = '#ff0000';
const ROUGH_AFTER = 0.11;

/** The render-mode state of the first mesh under a node, read off the live scene. */
async function renderMode(page: import('@playwright/test').Page, id: string) {
  return page.evaluate((nodeId) => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene as {
      getObjectByName: (n: string) => { traverse: (f: (o: unknown) => void) => void } | undefined;
    } | null;
    const grp = scene?.getObjectByName(nodeId);
    if (!grp) return null;
    let target: unknown = null;
    grp.traverse((o) => {
      const m = o as { isMesh?: boolean };
      if (!target && m.isMesh) target = o;
    });
    const mat = (
      target as {
        material?: {
          uuid: string;
          side: number;
          alphaTest: number;
          vertexColors: boolean;
          roughness: number;
          color?: { getHexString(): string };
        };
      } | null
    )?.material;
    return mat
      ? {
          uuid: mat.uuid,
          side: mat.side,
          alphaTest: mat.alphaTest,
          vertexColors: mat.vertexColors,
          roughness: mat.roughness,
          color: mat.color ? `#${mat.color.getHexString()}` : null,
        }
      : null;
  }, id);
}

function cubeOps(data: string, cube: string, x: number, geometry: Record<string, unknown>): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: data,
      nodeType: 'BoxData',
      params: {
        size: [1, 1, 1],
        material: {
          name: 'own',
          base: { color: OWN_COLOR },
          specular: { roughness: ROUGH_BEFORE },
          geometry,
        },
      },
    },
    { type: 'addNode', nodeId: cube, nodeType: 'Object', params: { position: [x, 0, 0] } },
    { type: 'connect', from: { node: data, socket: 'out' }, to: { node: cube, socket: 'data' } },
  ] as Op[];
}

async function seed(page: import('@playwright/test').Page, ops: Op[], cubes: string[]) {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(a.ops as Op[]),
          ...a.cubes.map(
            (c) =>
              ({
                type: 'connect',
                from: { node: c, socket: 'out' },
                to: { node: scene, socket: 'children' },
              }) as Op,
          ),
        ],
        'e2e',
        '#532 fixture',
      );
    },
    { ops: ops as unknown, cubes },
  );
  await page.waitForTimeout(600);
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
    const w = window as unknown as UiWindow;
    return Boolean(
      w.__basher_three && w.__basher_dag && w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('#532 — double-sided and alpha cutout reach a native primitive; vertex colours do not', async ({
  page,
}) => {
  await seed(page, cubeOps('p532_data', 'p532_cube', 3, { opacity: 1 }), ['p532_cube']);

  // PRECONDITION: all three sit at three's own defaults, so every assertion after the
  // edit is about the edit. This also proves the mesh was found at all.
  const before = await renderMode(page, 'p532_cube');
  expect(before).not.toBeNull();
  expect(before!.side).toBe(FRONT_SIDE);
  expect(before!.alphaTest).toBe(0);
  expect(before!.vertexColors).toBe(false);
  expect(before!.roughness).toBeCloseTo(ROUGH_BEFORE, 5);

  await page.evaluate(
    (a) => {
      (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'setParam',
            nodeId: a.data,
            paramPath: 'material.geometry.doubleSided',
            value: true,
          },
          {
            type: 'setParam',
            nodeId: a.data,
            paramPath: 'material.geometry.alphaCutoff',
            value: a.cutoff,
          },
          {
            type: 'setParam',
            nodeId: a.data,
            paramPath: 'material.geometry.vertexColors',
            value: true,
          },
          // The control, dispatched the same way in the same atomic edit: a field the
          // native road has always applied.
          {
            type: 'setParam',
            nodeId: a.data,
            paramPath: 'material.specular.roughness',
            value: a.rough,
          },
        ] as Op[],
        'e2e',
        '#532 flags',
      );
    },
    { data: 'p532_data', cutoff: CUTOFF, rough: ROUGH_AFTER },
  );

  await expect.poll(async () => (await renderMode(page, 'p532_cube'))?.side).toBe(DOUBLE_SIDE);
  const after = await renderMode(page, 'p532_cube');
  expect(after!.alphaTest).toBeCloseTo(CUTOFF, 5);
  // CONTROL — the road itself is working, so the two above are statements about those
  // two fields rather than about a dead pipeline.
  expect(after!.roughness).toBeCloseTo(ROUGH_AFTER, 5);

  // 🔴 AND THE THIRD FLAG STAYS OFF, DELIBERATELY. `vertexColors` asks the shader to
  // read a COLOR_0 attribute a BoxGeometry does not have; honouring it here was tried
  // and OBSERVED — the box renders pure black. The dispatch above set it to true, so
  // this is the live witness that the native road ignores it and the object still
  // draws its own colour.
  expect(after!.vertexColors).toBe(false);
  expect(after!.color).toBe(OWN_COLOR);
});

test('#532 — two primitives differing ONLY in a render flag do not share one material', async ({
  page,
}) => {
  await seed(
    page,
    [
      ...cubeOps('p532b_data1', 'p532b_cube1', 3, { opacity: 1 }),
      ...cubeOps('p532b_data2', 'p532b_cube2', 6, { opacity: 1, doubleSided: true }),
    ],
    ['p532b_cube1', 'p532b_cube2'],
  );

  const one = await renderMode(page, 'p532b_cube1');
  const two = await renderMode(page, 'p532b_cube2');
  expect(one).not.toBeNull();
  expect(two).not.toBeNull();

  // The identity key is a content walk, so these two were ALREADY separate instances
  // before this fix — separate, and identical, which is the lost dedup #532 paid for
  // and got nothing back. What was missing is the reason: they must actually differ.
  expect(one!.side).toBe(FRONT_SIDE);
  expect(two!.side).toBe(DOUBLE_SIDE);
  expect(one!.uuid).not.toBe(two!.uuid);
  // …and everything they DO share is still shared-shaped: same authored roughness, so a
  // difference above is the flag rather than the fixture drifting.
  expect(one!.roughness).toBeCloseTo(two!.roughness, 5);
});
