// #536 S2 — the SCENE-BAND `MaterialOverride` must split a shared material instance,
// exactly as the data-lane `MaterialOverrideOp` does.
//
// ── WHY THIS EXISTS, AND WHY IT IS WRITTEN BEFORE THE REFACTOR ──────────────────────
//
// #530's four tests are the registry's behavioural gate, and its split half wires a
// `MaterialOverrideOp` into the DATA LANE (`data.out → op.target`, `op.out → obj.data`).
// That override is part of the fold, so it is already inside the key the evaluator mints
// (`materialKey`, #536 S1).
//
// The scene-band `MaterialOverride` is a DIFFERENT road: it decorates a `SceneObject`,
// and `MaterialOverrideR` pushes it down the render tree as an inherited `override` prop
// which is composed at RENDER time (`usePrimitiveMaterial`). It is therefore NOT in the
// evaluated value and NOT in `materialKey`. Measured before writing this: of the nine
// specs that build one, none reads a material instance identity — the road had no
// sharing gate at all.
//
// That matters because S2 keys the registry on the evaluator's key. Keyed on
// `materialKey` ALONE, two objects with the same base material under different override
// wrappers would collide onto ONE instance and repaint an object nobody overrode —
// #530's regression class, with every gate it declared still green. This test is the one
// that goes red for that, and it is committed BEFORE the key changes so that it is a
// regression test rather than a description of the new behaviour.
//
// ── BOTH HALVES, BECAUSE THE DEFECT SWAPS THE READINGS ──────────────────────────────
//
// A registry that ignores the override hands the overridden instance to all three, so
// "the wrapped one differs" and "the other two are untouched" fail in opposite
// directions. Either assertion alone is satisfied by some wrong implementation:
//   · "the wrapped one differs" alone passes if the override splits EVERYTHING apart
//     (a registry that never shares at all).
//   · "the other two share" alone passes if the override is ignored entirely.
//
// ── THE READER IS NAME-INDEPENDENT ON PURPOSE ───────────────────────────────────────
//
// A wrapped object renders through the decorator's child road, and a nested child's
// object3D loses its `name` (#501) — so `scene.getObjectByName(nodeId)` is not available
// for the very object under test. Meshes are located by their world X instead, which the
// fixture makes unique per cube. Reading the material off the live scene (not an
// appearance assertion) is required either way: a privately copied material draws
// identically to a shared one, so only instance identity separates them.
//
// REF: src/app/materialRegistry.ts; src/viewport/SceneFromDAG.tsx (`usePrimitiveMaterial`,
//      `MaterialOverrideR`); src/nodes/materialKey.ts; tests/e2e/p530-material-instance-sharing.spec.ts
//      (the data-lane half); issues #530, #536.

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
}

const D1 = 'p536ob_d1';
const C1 = 'p536ob_c1';
const D2 = 'p536ob_d2';
const C2 = 'p536ob_c2';
const D3 = 'p536ob_d3';
const C3 = 'p536ob_c3';
const OVR = 'p536ob_ovr';

/** All three cubes author the SAME material, so sharing is the fixture's baseline. */
const BASE_COLOR = '#2244ff';
const BASE_ROUGH = 0.72;
/** Distinct from BASE_COLOR, or "the override ran" is not observable. */
const OVR_COLOR = '#ff8800';

/**
 * The X each cube sits at — the fixture's only handle on which mesh is which.
 *
 * Deliberately far from the origin: the starter scene contributes SEVEN meshes of its
 * own, at world X 0, 3 and 5 (measured), so nearer positions collide with them and the
 * reader picks the wrong mesh. `at()` asserts exactly one match per X, which is what
 * turns a future collision into a red rather than a silently wrong reading.
 */
const X_PLAIN_A = -20;
const X_PLAIN_B = -23;
const X_WRAPPED = -26;

interface MeshRead {
  x: number;
  uuid: string;
  color: string;
}

/**
 * Every mesh in the scene with its world X and its material identity. Name-independent
 * (see the header) and read off the LIVE scene, since instance identity is the claim.
 */
async function meshes(page: import('@playwright/test').Page): Promise<MeshRead[]> {
  return page.evaluate(() => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene as {
      traverse: (f: (o: unknown) => void) => void;
      updateMatrixWorld: (force: boolean) => void;
    } | null;
    // Not optional: `matrixWorld` is stale until the renderer next commits, and reading
    // it unforced returned X=0 for EVERY mesh — a uniform result, i.e. the instrument.
    scene?.updateMatrixWorld(true);
    const out: MeshRead[] = [];
    scene?.traverse((o) => {
      const m = o as {
        isMesh?: boolean;
        matrixWorld?: { elements: number[] };
        material?: { uuid: string; color?: { getHexString(): string } };
      };
      if (!m.isMesh || !m.material || !m.matrixWorld) return;
      out.push({
        x: Math.round(m.matrixWorld.elements[12] * 1000) / 1000,
        uuid: m.material.uuid,
        color: m.material.color ? `#${m.material.color.getHexString()}` : '',
      });
    });
    return out;
  });
}

function at(all: MeshRead[], x: number): MeshRead {
  const hit = all.filter((m) => Math.abs(m.x - x) < 0.001);
  expect(hit, `exactly one mesh at x=${x} (got ${hit.length})`).toHaveLength(1);
  return hit[0];
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
    // `__basher_three` exists before its `scene` is populated — waiting only on the
    // handle raced and read a null scene.
    return Boolean(
      w.__basher_three &&
      w.__basher_three.getState().scene &&
      w.__basher_dag &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
}

async function seed(page: import('@playwright/test').Page) {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      // Identical material on all three — the shared instance is the baseline the
      // override has to break, so the cubes must be indistinguishable underneath.
      const material = {
        name: 'shared',
        base: { color: a.baseColor },
        specular: { roughness: a.baseRough },
      };
      const cube = (data: string, obj: string, x: number): Op[] => [
        {
          type: 'addNode',
          nodeId: data,
          nodeType: 'BoxData',
          params: { size: [1, 1, 1], material },
        },
        { type: 'addNode', nodeId: obj, nodeType: 'Object', params: { position: [x, 0, 0] } },
        { type: 'connect', from: { node: data, socket: 'out' }, to: { node: obj, socket: 'data' } },
      ];
      const toScene = (from: string): Op => ({
        type: 'connect',
        from: { node: from, socket: 'out' },
        to: { node: scene, socket: 'children' },
      });
      dag.dispatchAtomic(
        [
          ...cube(a.d1, a.c1, a.xa),
          ...cube(a.d2, a.c2, a.xb),
          ...cube(a.d3, a.c3, a.xw),
          toScene(a.c1),
          toScene(a.c2),
          // The third cube goes to the scene THROUGH the decorator, so the override
          // arrives as the inherited render-time prop rather than through the fold.
          {
            type: 'addNode',
            nodeId: a.ovr,
            nodeType: 'MaterialOverride',
            // The authored bit is not optional: a field absent from `overridden`
            // inherits the source channel, so a bare `color` would compose to the base
            // and this fixture would assert the absence of what it exists to test.
            params: { color: a.ovrColor, overridden: { color: true } },
          },
          {
            type: 'connect',
            from: { node: a.c3, socket: 'out' },
            to: { node: a.ovr, socket: 'target' },
          },
          toScene(a.ovr),
        ],
        'e2e',
        '#536 override-band split fixture',
      );
    },
    {
      d1: D1,
      c1: C1,
      d2: D2,
      c2: C2,
      d3: D3,
      c3: C3,
      ovr: OVR,
      xa: X_PLAIN_A,
      xb: X_PLAIN_B,
      xw: X_WRAPPED,
      baseColor: BASE_COLOR,
      baseRough: BASE_ROUGH,
      ovrColor: OVR_COLOR,
    },
  );
  await page.waitForTimeout(700);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await seed(page);
});

test('#536 — a scene-band MaterialOverride SPLITS its object off the shared instance', async ({
  page,
}) => {
  const all = await meshes(page);
  const plainA = at(all, X_PLAIN_A);
  const plainB = at(all, X_PLAIN_B);
  const wrapped = at(all, X_WRAPPED);

  // Vacuity guard: the two undecorated cubes must genuinely share, or "the third one
  // differs" is a statement about a registry that never shares anything.
  expect(plainB.uuid, 'the fixture must start SHARED for a split to mean anything').toBe(
    plainA.uuid,
  );

  // The override genuinely ran — otherwise "it got its own instance" is about churn.
  expect(wrapped.color).toBe(OVR_COLOR);

  // The split itself.
  expect(wrapped.uuid).not.toBe(plainA.uuid);
});

test('#536 — and the objects nobody overrode keep the shared instance AND the base colour', async ({
  page,
}) => {
  const all = await meshes(page);
  const plainA = at(all, X_PLAIN_A);
  const plainB = at(all, X_PLAIN_B);
  const wrapped = at(all, X_WRAPPED);

  // The direction a key that ignored the override would fail in: the overridden colour
  // painted onto objects that were never decorated.
  expect(plainA.color).toBe(BASE_COLOR);
  expect(plainB.color).toBe(BASE_COLOR);
  expect(plainA.uuid).toBe(plainB.uuid);

  // Read in the same run, so this pair is measured in a world where the override is
  // demonstrably live rather than one where it silently failed to apply.
  expect(wrapped.color).toBe(OVR_COLOR);
});
