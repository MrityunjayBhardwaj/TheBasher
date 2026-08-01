// #530 — objects whose material resolves to the same thing draw the SAME
// `THREE.Material` instance, and an override splits them apart again.
//
// ── WHY THIS TIER, AND ONLY THIS TIER ───────────────────────────────────────────────
//
// The registry's own rules are unit-tested next to it. What no tier below a browser can
// see is whether the RENDERER actually goes through it: nothing under the viewport
// builds a scene, so "two meshes on screen share one material" has exactly one witness.
// The claim is about instance identity, so it is read off the live scene as a uuid — an
// appearance read cannot tell sharing from copying, since a privately copied material
// draws identically.
//
// ── BOTH HALVES, AND WHY THE SECOND ONE IS NOT DECORATION ───────────────────────────
//
// Half 1 alone is passed by an implementation that keys the cache on the Material NODE's
// id — which would then hand the same instance to a mesh carrying an override, and paint
// the override onto every other object linked to that material. Half 2 is what rules
// that out: adding an operator to ONE of the pair must split it, while the other two keep
// the shared instance.
//
// ── VACUITY GUARDS ──────────────────────────────────────────────────────────────────
//
//   · The two data nodes author DIFFERENT colours of their own, so "both draw the
//     Material's colour" is a fact about the link rather than about a coincidence.
//   · The operator AUTHORS its bit (`overridden`). Post-#529 an op carrying a bare param
//     authors nothing and composes to the base — a fixture like that would assert the
//     absence of the very covering it exists to test.
//   · The operator's roughness differs from the Material's, and the split object's
//     roughness is read, so "it got its own instance" is tied to the op having done
//     something rather than to any instance churn.
//   · The unlinked control shares too, from a different route (identical inline
//     material), so a pass cannot come from "linked objects are special-cased".
//
// REF: src/app/materialRegistry.ts; docs/PERFORMANCE.md Lever 5; issue #530.

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

const MAT = 'p530_mat';
const D1 = 'p530_d1';
const C1 = 'p530_c1';
const D2 = 'p530_d2';
const C2 = 'p530_c2';
const D3 = 'p530_d3';
const C3 = 'p530_c3';
const OP = 'p530_op';
// The two unlinked twins — identical inline material, never introduced to each other.
const T1D = 'p530_t1d';
const T1C = 'p530_t1c';
const T2D = 'p530_t2d';
const T2C = 'p530_t2c';

const MAT_COLOR = '#2244ff'; // the linked Material's colour
const MAT_ROUGH = 0.72; // differs from OP_ROUGH, or "the third differs" is free
const OP_ROUGH = 0.11;
const TWIN_COLOR = '#aa33cc';
const EDITED_COLOR = '#00ff44'; // distinct from every colour the fixture authors
// Each data node authors its OWN colour underneath, so a green run is one where the
// link really superseded the param rather than one where they happened to match.
const OWN = ['#ff0000', '#00ff00', '#111111'];

/** The renderer-side identity read: the node's first mesh, its material's uuid. */
async function matOf(page: import('@playwright/test').Page, id: string) {
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
    const mat = (
      target as {
        material?: { uuid: string; roughness?: number; color?: { getHexString(): string } };
      } | null
    )?.material;
    if (!mat) return { error: `no material under ${nodeId}` };
    return {
      uuid: mat.uuid,
      roughness: mat.roughness ?? null,
      color: mat.color ? `#${mat.color.getHexString()}` : null,
    };
  }, id);
}

async function boot(page: import('@playwright/test').Page) {
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
}

async function seed(page: import('@playwright/test').Page) {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      const cube = (data: string, obj: string, x: number, material: unknown): Op[] => [
        {
          type: 'addNode',
          nodeId: data,
          nodeType: 'BoxData',
          params: { size: [1, 1, 1], material },
        },
        { type: 'addNode', nodeId: obj, nodeType: 'Object', params: { position: [x, 0, 0] } },
        { type: 'connect', from: { node: data, socket: 'out' }, to: { node: obj, socket: 'data' } },
        {
          type: 'connect',
          from: { node: obj, socket: 'out' },
          to: { node: scene, socket: 'children' },
        },
      ];
      const link = (data: string): Op => ({
        type: 'connect',
        from: { node: a.mat, socket: 'out' },
        to: { node: data, socket: 'material' },
      });
      const twin = { name: 'twin', base: { color: a.twinColor }, specular: { roughness: 0.4 } };
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: a.mat,
            nodeType: 'Material',
            params: {
              material: {
                name: 'shared',
                base: { color: a.matColor },
                specular: { roughness: a.matRough },
              },
            },
          },
          ...cube(a.d1, a.c1, -6, { name: 'own1', base: { color: a.own[0] } }),
          ...cube(a.d2, a.c2, -3, { name: 'own2', base: { color: a.own[1] } }),
          ...cube(a.d3, a.c3, 0, { name: 'own3', base: { color: a.own[2] } }),
          ...cube(a.t1d, a.t1c, 3, twin),
          ...cube(a.t2d, a.t2c, 6, twin),
          link(a.d1),
          link(a.d2),
          link(a.d3),
        ],
        'e2e',
        '#530 sharing fixture',
      );
    },
    {
      mat: MAT,
      d1: D1,
      c1: C1,
      d2: D2,
      c2: C2,
      d3: D3,
      c3: C3,
      t1d: T1D,
      t1c: T1C,
      t2d: T2D,
      t2c: T2C,
      matColor: MAT_COLOR,
      matRough: MAT_ROUGH,
      twinColor: TWIN_COLOR,
      own: OWN,
    },
  );
  await page.waitForTimeout(700);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await seed(page);
});

test('#530 half 1 — objects linked to ONE Material node draw ONE material instance', async ({
  page,
}) => {
  const one = (await matOf(page, C1)) as { uuid?: string; color?: string; roughness?: number };
  const two = (await matOf(page, C2)) as { uuid?: string; color?: string };
  const three = (await matOf(page, C3)) as { uuid?: string; color?: string };

  // POSITIVE CONTROL — the link really took: each authored its own colour, all three
  // draw the Material's. Without this a shared instance could be three objects sharing
  // the wrong material, which looks identical from a uuid alone.
  expect(one.color).toBe(MAT_COLOR);
  expect(two.color).toBe(MAT_COLOR);
  expect(three.color).toBe(MAT_COLOR);
  expect(one.roughness).toBeCloseTo(MAT_ROUGH, 5);

  expect(two.uuid).toBe(one.uuid);
  expect(three.uuid).toBe(one.uuid);
});

test('#530 — two objects that merely RESOLVE alike share too, with no link between them', async ({
  page,
}) => {
  // The other route into the cache, and the guard against a fix that special-cases the
  // link: these two never met, they just compile to the same material.
  const a = (await matOf(page, T1C)) as { uuid?: string; color?: string };
  const b = (await matOf(page, T2C)) as { uuid?: string; color?: string };
  expect(a.color).toBe(TWIN_COLOR);
  expect(b.uuid).toBe(a.uuid);

  // …and they are NOT sharing with the linked group, which looks different.
  const linked = (await matOf(page, C1)) as { uuid?: string };
  expect(a.uuid).not.toBe(linked.uuid);
});

test('#530 — editing the shared Material moves BOTH, onto a new shared instance', async ({
  page,
}) => {
  // The regression this pins is not "the colour is wrong" — it is that a shared object
  // handed to two `<primitive>` elements loses track of which mesh owns it, so an edit
  // repaints ONE of the sharers and freezes the other on the old instance. Measured
  // exactly that way before the fix. Colour alone is how the older specs caught it;
  // identity is what says WHY, and it is the half that stays true if someone reaches for
  // `<primitive>` again.
  const before1 = (await matOf(page, C1)) as { uuid?: string };
  const before2 = (await matOf(page, C2)) as { uuid?: string };
  expect(before2.uuid, 'the pair must start shared').toBe(before1.uuid);

  await page.evaluate(
    (a) => {
      (window as unknown as UiWindow).__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: a.mat, paramPath: 'material.base.color', value: a.next }],
          'user',
          '#530 edit the shared material',
        );
    },
    { mat: MAT, next: EDITED_COLOR },
  );
  await page.waitForTimeout(700);

  const after1 = (await matOf(page, C1)) as { uuid?: string; color?: string };
  const after2 = (await matOf(page, C2)) as { uuid?: string; color?: string };

  // BOTH moved — the frozen-sharer bug repainted exactly one of these.
  expect(after1.color).toBe(EDITED_COLOR);
  expect(after2.color).toBe(EDITED_COLOR);
  // …and they are STILL one instance, a NEW one. Sharing that survives one edit but not
  // the next is the shape a per-edit rebuild would leave behind.
  //
  // Falsified by restoring `<primitive object={material} attach="material" />`: the LAST
  // line is the one that reds — every sharer stayed on the pre-edit instance. The line
  // above it PASSES under that bug, because the sharers froze together rather than
  // separately; it is carried by the never-share falsification instead, not by this one.
  expect(after2.uuid).toBe(after1.uuid);
  expect(after1.uuid).not.toBe(before1.uuid);
});

test('#530 half 2 — an override operator SPLITS one object off the shared instance', async ({
  page,
}) => {
  const before = (await matOf(page, C3)) as { uuid?: string };
  const shared = (await matOf(page, C1)) as { uuid?: string };
  expect(before.uuid, 'the fixture must start SHARED for a split to mean anything').toBe(
    shared.uuid,
  );

  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      w.__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: a.op,
            nodeType: 'MaterialOverrideOp',
            // The authored bit is not optional: post-#529 an operator writes a channel
            // only where the director authored it, so a bare `{ roughness }` would
            // compose to the base and this test would assert nothing.
            params: { roughness: a.rough, overridden: { roughness: true } },
          },
          {
            type: 'connect',
            from: { node: a.d3, socket: 'out' },
            to: { node: a.op, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: a.op, socket: 'out' },
            to: { node: a.c3, socket: 'data' },
          },
        ],
        'e2e',
        '#530 override splits',
      );
    },
    { op: OP, d3: D3, c3: C3, rough: OP_ROUGH },
  );
  await page.waitForTimeout(700);

  const after = (await matOf(page, C3)) as {
    uuid?: string;
    roughness?: number;
    color?: string;
  };
  const stillShared1 = (await matOf(page, C1)) as { uuid?: string; roughness?: number };
  const stillShared2 = (await matOf(page, C2)) as { uuid?: string };

  // The operator genuinely ran — otherwise "it got its own instance" is a statement
  // about churn, not about the override.
  expect(after.roughness).toBeCloseTo(OP_ROUGH, 5);
  // It is still the LINKED material underneath, only with the op's channel on top.
  expect(after.color).toBe(MAT_COLOR);

  // The split itself.
  expect(after.uuid).not.toBe(shared.uuid);

  // 🔑 And the other two are untouched — this is what a registry keyed on the Material
  // node id gets wrong: it would hand C3's overridden material to all three, painting
  // 0.11 roughness onto objects nobody overrode.
  expect(stillShared1.uuid).toBe(shared.uuid);
  expect(stillShared2.uuid).toBe(shared.uuid);
  expect(stillShared1.roughness).toBeCloseTo(MAT_ROUGH, 5);
});
