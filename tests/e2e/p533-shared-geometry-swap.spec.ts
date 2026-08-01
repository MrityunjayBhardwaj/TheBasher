// #533 — two meshes sharing one registry geometry must not trade geometries when one
// of them is resized.
//
// ── THE BUG THIS PINS ───────────────────────────────────────────────────────────────
//
// `geometryRegistry` is content-keyed, so two boxes authored at the same size share one
// `BufferGeometry` — by design. Both used to attach it with
// `<primitive object={geom} attach="geometry" />`, and `<primitive>` takes OWNERSHIP of
// the object it is handed: it stamps its own reconciler bookkeeping onto the object.
// Hand ONE object to two `<primitive>` elements and the second attach overwrites the
// first's, so a later swap lands on the wrong owner.
//
// Measured on `main` before the fix: resizing box 1 left box 1 UNCHANGED and resized
// box 2, which nobody had touched. Two default cubes are enough to reach it.
//
// ── WHY BOTH HALVES ─────────────────────────────────────────────────────────────────
//
// "the edited box resized" alone passes against a build where BOTH boxes resized, which
// is a different bug and a worse one. "the other box did not" alone passes against a
// build where NOTHING resized. The defect swaps them, so only the conjunction sees it.
//
// The geometry is read as an actual vertex extent rather than as a uuid: a uuid says the
// instance changed, an extent says the mesh is drawing the size the director asked for.
// The premise that the two really shared one instance beforehand IS asserted by uuid,
// because without sharing the whole test is about nothing.
//
// REF: src/app/geometryRegistry.ts; src/viewport/SceneFromDAG.tsx; issue #533.

import { expect, test } from './_fixtures';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface UiWindow {
  __basher_three: { getState: () => { scene: unknown } };
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_mesh_material?: (id: string) => unknown;
}

const D1 = 'p533_d1';
const C1 = 'p533_c1';
const D2 = 'p533_d2';
const C2 = 'p533_c2';

const START = 2; // both boxes, so the registry hands them ONE geometry
const RESIZED = 6; // only box 1
const HALF_START = START / 2;
const HALF_RESIZED = RESIZED / 2;

/** uuid + the mesh's real half-extent along X, read off the position attribute. */
async function geomOf(page: import('@playwright/test').Page, id: string) {
  return page.evaluate((nodeId) => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene as {
      getObjectByName: (n: string) => { traverse: (f: (o: unknown) => void) => void } | undefined;
    } | null;
    const grp = scene?.getObjectByName(nodeId);
    if (!grp) return { error: `no group for ${nodeId}` };
    let target: unknown = null;
    grp.traverse((o) => {
      const m = o as { isMesh?: boolean };
      if (!target && m.isMesh) target = o;
    });
    const g = (
      target as {
        geometry?: { uuid: string; attributes: { position: { array: ArrayLike<number> } } };
      } | null
    )?.geometry;
    if (!g) return { error: `no geometry under ${nodeId}` };
    let halfX = 0;
    const arr = g.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) halfX = Math.max(halfX, Math.abs(arr[i]));
    return { uuid: g.uuid, halfX };
  }, id);
}

test('#533 — resizing one of two boxes that share a geometry resizes THAT box, and only it', async ({
  page,
}) => {
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

  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      const cube = (data: string, obj: string, x: number): Op[] => [
        {
          type: 'addNode',
          nodeId: data,
          nodeType: 'BoxData',
          // Identical size AND identical material, so the two nodes agree on every
          // content key there is — the strongest form of the sharing precondition.
          params: {
            size: [a.start, a.start, a.start],
            material: { name: 'twin', base: { color: '#8844ff' } },
          },
        },
        { type: 'addNode', nodeId: obj, nodeType: 'Object', params: { position: [x, 0, 0] } },
        { type: 'connect', from: { node: data, socket: 'out' }, to: { node: obj, socket: 'data' } },
        {
          type: 'connect',
          from: { node: obj, socket: 'out' },
          to: { node: scene, socket: 'children' },
        },
      ];
      dag.dispatchAtomic(
        [...cube(a.d1, a.c1, -5), ...cube(a.d2, a.c2, 2)],
        'e2e',
        '#533 shared geometry',
      );
    },
    { d1: D1, c1: C1, d2: D2, c2: C2, start: START },
  );
  await page.waitForTimeout(700);

  const before1 = (await geomOf(page, C1)) as { uuid?: string; halfX?: number };
  const before2 = (await geomOf(page, C2)) as { uuid?: string; halfX?: number };

  // THE PREMISE — they really do share one instance. Without this the test says nothing
  // about sharing, and would keep passing if the registry ever stopped deduping.
  expect(before1.halfX).toBeCloseTo(HALF_START, 5);
  expect(before2.uuid, 'the pair must start SHARED').toBe(before1.uuid);

  await page.evaluate(
    (a) => {
      (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'setParam',
            nodeId: a.d1,
            paramPath: 'size',
            value: [a.next, a.start, a.start],
          },
        ],
        'user',
        '#533 resize one sharer',
      );
    },
    { d1: D1, next: RESIZED, start: START },
  );
  await page.waitForTimeout(900);

  const after1 = (await geomOf(page, C1)) as { halfX?: number };
  const after2 = (await geomOf(page, C2)) as { halfX?: number };

  // 🔑 BOTH HALVES. The defect swapped these two readings: box 1 stayed at 1 and box 2
  // went to 3. Either assertion alone is satisfied by that swap read from one side.
  expect(after1.halfX, 'the edited box did not resize').toBeCloseTo(HALF_RESIZED, 5);
  expect(after2.halfX, 'the untouched box resized').toBeCloseTo(HALF_START, 5);
});
