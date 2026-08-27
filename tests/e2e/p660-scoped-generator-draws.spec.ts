// #660 (ns-2 step 18) — THE BROWSER OBSERVATION. A scoped GENERATOR reaches the screen.
//
// ── WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY LEAVES ALONE ───────────────────────
//
// Everything else ns-2 proves is arithmetic in the unit tier, on purpose: the resolver's
// answer, the descriptor's scope field, the registry key's suffix, and the face counts the
// exit pins as literals (steps 15/16). None of that is evidence that a scoped generator
// draws. The registry builds its geometry lazily, off the evaluator's road, on the render
// walk — so "the descriptor says 72" and "the renderer mounted 72" are two claims, and only
// the second one a director can see.
//
// The SCOPED WRITER half — `Box → SetMaterialOp(scoped) → Object`, two colours on one mesh,
// picked, plus its sharing pair — is already observed by `p638-two-material-mesh.spec.ts`,
// which was migrated onto `scope` at step 14 and passes through it. Re-authoring it here at
// a different range would re-run a green in the slowest tier this repo has. What has never
// been in a browser is the scoped GENERATOR: steps 12.5 / 13a / 13b built the scoped
// `array` and `mirror` descriptors, their keys and their counts entirely in vitest.
//
// The plan's fourth clause asked for `registrySize()` and `renderer.info.memory.geometries`
// to move together. That instrument was RETIRED against measurement at #657 and p638's
// clause 4 documents why (lazy upload under-reports, the startup tail lands on whatever
// happens next, one select/deselect cycle costs 17 that never come back). Re-introducing it
// here would re-introduce a number that moves for reasons this file does not control. The
// property it was reaching for — one cooked value, many holders — is asserted below as
// `BufferGeometry` identity, which is the property itself.
//
// `renderer.info.render.calls` is not used either: `PerfProbe.tsx:15-19` documents it as
// under-reporting behind the composer `SceneFromDAG.tsx` mounts unconditionally.
//
// ── THE SCENE IS AUTHORED THROUGH THE OPS ROAD ─────────────────────────────────────────
//
// `addNode` / `connect` / `setParam` through `dispatchAtomic`, every op parsed by the node's
// own schema — never by injecting a value into the renderer. Nothing in any shipped scene
// wires a scoped operator, so the subject does not exist until this spec authors it, and an
// observation of something the app cannot produce is the shape #367 paid for three times.
//
// REF: src/nodes/ArrayModifier.ts (`chain.scope.kind = 'source'`, and the rule: a scoped
//      generator preserves its whole input and generates from the subset);
//      src/app/modifierGeometry.ts (`arrayGeometryRef` — the key's scope suffix);
//      src/app/geometryRegistry.ts (the build); tests/e2e/p638-two-material-mesh.spec.ts
//      (the scoped WRITER half); issues #660, #607, #638, #657.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

/** Unmistakable against the seed scene, which carries no blue at all. */
const BLUE = '#0000ff';

// ── THE ARITHMETIC, RESTATED AS THE RENDERER SEES IT ──────────────────────────────────
//
// A box is SIX FACES since #770 — six quads — materialising to 12 triangles = 36 index
// elements. `1-3` is three of those faces, half, and the query moved there from `1-6` in the
// same phase: over six faces `1-6` names five of them, so the scoped and unscoped renders
// would have nearly converged and the pixel clause below would have stopped discriminating.
//
// ⚠️ THE OLD REASON FOR PREFERRING `1-6` OVER `0-5` IS GONE, AND ITS REPLACEMENT IS NOT A
// BOUNDARY. It read: *"`0-5` is ALSO exactly cube sides 0/1/2, so it agrees with a cube-side
// implementation and a triangle one at once; `1-6` has the same cardinality and separates
// them."* #770 named the polygon as the face, so a box's faces ARE its cube sides and no box
// query can separate those two readings any more. What survives is cardinality: the scope must
// name a PROPER, non-empty subset, which is all this constant is now chosen for.
//
// A scoped array of `count` preserves its whole input and generates from the subset:
// 6 + 3 + 3 = 12 faces = 24 triangles = 72 index elements. Unscoped: 3 x 6 = 18 = 108. Both
// index figures are UNCHANGED across the flip, which is the same coincidence the unit tier
// records: three quads and six triangles occupy the same eighteen entries.
const SCOPE_HALF = '1-3';
const SCOPED_INDEX = 72;
const UNSCOPED_INDEX = 108;

/**
 * 🔴 THE PIXEL CLAUSE IS A RELATION PLUS A FLOOR, AND IT NEEDS BOTH.
 *
 * "the widened array draws more" alone is satisfied by a scoped array that draws NOTHING,
 * which is the worse defect. "the scoped array draws something" alone is satisfied by a
 * build that ignores the scope entirely — which is exactly the arm this file exists to red.
 * Measured on this tree at the project's 1920x1080 render: 30,947 blue against 78,387, a
 * ratio of 2.53. The threshold is 1.5, and the two counts go into the message so a change
 * that shrinks the difference reads as numbers rather than as a pass.
 */
const DRAWS_AT_ALL = 5_000;
const WIDENING_RATIO = 1.5;

interface Op {
  type: string;
  [k: string]: unknown;
}

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_three: {
    getState: () => {
      scene: unknown;
      camera: unknown;
      gl: { domElement: HTMLCanvasElement } | null;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void; primaryNodeId: string | null };
  };
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
}

/** The ops the graph editor emits for "array this box, generating from these faces". */
function scopedArrayOps(
  sceneId: string,
  dataId: string,
  opId: string,
  objId: string,
  pos: [number, number, number],
  scope: string,
): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: dataId,
      nodeType: 'BoxData',
      // The material rides on the DATA node and the generator inherits it, so every copy
      // is the same blue and the pixel count is a count of this subject alone.
      params: { size: [1, 1, 1], material: { name: `${dataId}-blue`, base: { color: BLUE } } },
    },
    {
      type: 'addNode',
      nodeId: opId,
      nodeType: 'ArrayModifier',
      params: { count: 3, offset: [1.5, 0, 0], scope },
    },
    {
      type: 'addNode',
      nodeId: objId,
      nodeType: 'Object',
      params: { position: pos, rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: opId, socket: 'target' },
    },
    { type: 'connect', from: { node: opId, socket: 'out' }, to: { node: objId, socket: 'data' } },
    {
      type: 'connect',
      from: { node: objId, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    },
  ];
}

async function dispatch(page: Page, ops: Op[], label: string): Promise<void> {
  await page.evaluate(
    ({ ops: o, label: l }) => {
      (window as unknown as W).__basher_dag.getState().dispatchAtomic(o, l, l);
    },
    { ops, label },
  );
}

interface MeshFacts {
  readonly uuid: string;
  readonly indexCount: number | null;
}

/**
 * The mesh actually mounted under the pick band named `nodeId`, off the real scene graph.
 *
 * A miss returns `null` rather than a default, so a walk that finds nothing reads as an
 * instrument failure and never as two meshes agreeing about a geometry neither of them has.
 */
async function meshFacts(page: Page, nodeId: string): Promise<MeshFacts | null> {
  return page.evaluate((id) => {
    interface Obj {
      name?: string;
      type?: string;
      children?: Obj[];
      geometry?: { uuid: string; index?: { count: number } | null };
    }
    const scene = (window as unknown as W).__basher_three.getState().scene as Obj | null;
    if (!scene) return null;
    let mesh: Obj | null = null;
    const walk = (o: Obj, inBand: boolean): void => {
      const here = inBand || o.name === id;
      if (mesh === null && here && o.type === 'Mesh' && o.geometry) mesh = o;
      (o.children ?? []).forEach((c) => walk(c, here));
    };
    walk(scene, false);
    if (mesh === null) return null;
    const g = (mesh as Obj).geometry!;
    return { uuid: g.uuid, indexCount: g.index ? g.index.count : null };
  }, nodeId);
}

/** Waits for a mesh to EXIST under the band — never for the value about to be asserted. */
async function waitForMesh(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      interface Obj {
        name?: string;
        type?: string;
        children?: Obj[];
        geometry?: unknown;
      }
      const scene = (window as unknown as W).__basher_three.getState().scene as Obj | null;
      if (!scene) return false;
      let found = false;
      const walk = (o: Obj, inBand: boolean): void => {
        const here = inBand || o.name === id;
        if (here && o.type === 'Mesh' && o.geometry) found = true;
        (o.children ?? []).forEach((c) => walk(c, here));
      };
      walk(scene, false);
      return found;
    },
    nodeId,
    { timeout: 15_000 },
  );
}

/**
 * 🔴 THE WAIT AFTER A SCOPE EDIT IS AN EVENT, NOT A DURATION — [[H335]], and p638 paid for
 * this rule twice. A rebuilt handle mints a new `BufferGeometry`, so waiting for the uuid to
 * leave its previous value waits on the commit itself at any frame rate, and it does not
 * presuppose the count the assertion is about to read.
 *
 * 🔴 AND THE TIMEOUT IS NAMED, because this wait is where a whole class of defect lands
 * rather than where a slow runner does. Measured: dropping the scope suffix from the array
 * key reds both tests in this file HERE and nowhere else — the registry hands the cached
 * build straight back, so the mesh is never rebuilt and the uuid never moves. A bare
 * "waitForFunction timeout" reads as an infrastructure flake; it is a product reading.
 */
async function waitForRebuild(page: Page, nodeId: string, previousUuid: string): Promise<void> {
  try {
    await page.waitForFunction(
      ({ id, before }) => {
        interface Obj {
          name?: string;
          type?: string;
          children?: Obj[];
          geometry?: { uuid: string };
        }
        const scene = (window as unknown as W).__basher_three.getState().scene as Obj | null;
        if (!scene) return false;
        let uuid: string | null = null;
        const walk = (o: Obj, inBand: boolean): void => {
          const here = inBand || o.name === id;
          if (uuid === null && here && o.type === 'Mesh' && o.geometry) uuid = o.geometry.uuid;
          (o.children ?? []).forEach((c) => walk(c, here));
        };
        walk(scene, false);
        return uuid !== null && uuid !== before;
      },
      { id: nodeId, before: previousUuid },
      { timeout: 15_000 },
    );
  } catch {
    throw new Error(
      `${nodeId} never rebuilt after its scope changed — its BufferGeometry is still ${previousUuid}. ` +
        'A registry key that does not carry the scope hands the cached build back for a different query.',
    );
  }
}

/** Blue-dominant pixels in the project render — the subject's own colour, decoded. */
async function bluePixels(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const out = await (window as unknown as W).__basher_render_png!();
    if (!out) return null;
    const img = new Image();
    await new Promise((r) => {
      img.onload = r;
      img.src = out.dataUrl;
    });
    const cv = document.createElement('canvas');
    cv.width = out.width;
    cv.height = out.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, out.width, out.height).data;
    let blue = 0;
    // The margin keeps the stage background — a very slightly blue near-black — out.
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 2] > px[i] + 30 && px[i + 2] > px[i + 1] + 30) blue++;
    }
    return blue;
  });
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
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_three &&
      w.__basher_selection &&
      w.__basher_three.getState().scene &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

// ── CLAUSE 1 — IT DRAWS THE SUBSET, IT IS STILL PICKABLE, AND WIDENING THE SCOPE SHOWS ──
test('a scoped array draws the subset it generates from, stays pickable, and grows when the scope widens', async ({
  page,
}) => {
  const sceneId = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.outputs.scene!.node,
  );
  await dispatch(
    page,
    scopedArrayOps(sceneId, 'n660_data', 'n660_op', 'n660_obj', [-1.5, 2.2, 0], SCOPE_HALF),
    'scoped array',
  );
  await waitForMesh(page, 'n660_obj');

  // THE SCENE WALK — the geometry the registry BUILT and the renderer MOUNTED, which is a
  // different road from the descriptor the unit tier reads. `72` is the exit's own number
  // (step 15), corroborating the pixels below rather than restating the arithmetic.
  const scoped = await meshFacts(page, 'n660_obj');
  expect(scoped, 'no mesh mounted under the scoped array').not.toBeNull();
  expect(scoped!.indexCount).toBe(SCOPED_INDEX);

  const scopedBlue = await bluePixels(page);
  expect(scopedBlue).not.toBeNull();

  // PICK, on the SCOPED state — the third loss a wrong subset costs, and the only one that
  // reaches a director as "I cannot select this" rather than as a render bug.
  await page.evaluate(() => (window as unknown as W).__basher_selection.getState().select(null));
  const click = await page.evaluate(() => {
    interface V3 {
      x: number;
      y: number;
      z: number;
      project: (c: unknown) => V3;
    }
    interface Obj {
      name?: string;
      type?: string;
      children?: Obj[];
      getWorldPosition?: (v: unknown) => V3;
    }
    const w = window as unknown as W;
    const three = w.__basher_three.getState();
    const gl = three.gl;
    if (!gl) return null;
    const scene = three.scene as Obj | null;
    let mesh: Obj | null = null;
    const walk = (o: Obj, inBand: boolean): void => {
      const here = inBand || o.name === 'n660_obj';
      if (mesh === null && here && o.type === 'Mesh') mesh = o;
      (o.children ?? []).forEach((c) => walk(c, here));
    };
    if (scene) walk(scene, false);
    if (mesh === null) return null;
    // Projected through the EDITOR camera the canvas is actually drawn with, rather than
    // guessing viewport coordinates.
    const target = (mesh as Obj).getWorldPosition!(
      Object.create(Object.getPrototypeOf((three.camera as { position: V3 }).position)),
    );
    const ndc = target.project(three.camera);
    const rect = gl.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((ndc.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - ndc.y) / 2) * rect.height,
    };
  });
  expect(click, 'could not project the scoped array onto the canvas').not.toBeNull();
  await page.mouse.click(click!.x, click!.y);
  await page.waitForFunction(
    () => (window as unknown as W).__basher_selection.getState().primaryNodeId === 'n660_obj',
    undefined,
    { timeout: 5_000 },
  );

  // THE PERTURBATION IS THE ASSERTION — clear the scope through the same field a director
  // edits. Blank is the authoring state for "no scope", so the generator now replicates the
  // whole box.
  await dispatch(
    page,
    [{ type: 'setParam', nodeId: 'n660_op', paramPath: 'scope', value: '' }],
    'widen to unscoped',
  );
  await waitForRebuild(page, 'n660_obj', scoped!.uuid);

  const unscoped = await meshFacts(page, 'n660_obj');
  expect(unscoped, 'no mesh mounted after widening').not.toBeNull();
  expect(unscoped!.indexCount).toBe(UNSCOPED_INDEX);

  const unscopedBlue = await bluePixels(page);
  expect(unscopedBlue).not.toBeNull();

  // BOTH HALVES. The floor rules out a scoped array that drew nothing; the ratio rules out
  // a build that ignored the scope. Neither is satisfiable by satisfying the other.
  const seen = `scoped: ${scopedBlue}, unscoped: ${unscopedBlue}`;
  expect(scopedBlue!, seen).toBeGreaterThan(DRAWS_AT_ALL);
  expect(unscopedBlue!, seen).toBeGreaterThan(scopedBlue! * WIDENING_RATIO);
});

// ── CLAUSE 2 — SHARING, AND THE COST STEP 12.5 DECLARED ────────────────────────────────
//
// Two identical scoped arrays share ONE `BufferGeometry`, and two whose scopes differ do
// NOT. The second half is the cost 12.5 stated in prose and nothing had observed: a scope
// is part of the registry key, so scoping the same box two ways doubles its builds. Written
// as a pair because each half alone is passed by a build the other half catches — always
// sharing (the key ignores the scope, so descriptor 2 is handed build 1) and never sharing
// (a clone per object, which draws identically).
test('two scoped arrays share one BufferGeometry, and stop sharing when their scopes diverge', async ({
  page,
}) => {
  const sceneId = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.outputs.scene!.node,
  );
  await dispatch(
    page,
    [
      ...scopedArrayOps(sceneId, 'n660_a_data', 'n660_a_op', 'n660_a', [-1.5, 2.2, 0], SCOPE_HALF),
      ...scopedArrayOps(sceneId, 'n660_b_data', 'n660_b_op', 'n660_b', [-1.5, -2.2, 0], SCOPE_HALF),
    ],
    'two identical scoped arrays',
  );
  await waitForMesh(page, 'n660_a');
  await waitForMesh(page, 'n660_b');

  const a = await meshFacts(page, 'n660_a');
  const b = await meshFacts(page, 'n660_b');
  expect(a, 'no mesh under n660_a').not.toBeNull();
  expect(b, 'no mesh under n660_b').not.toBeNull();
  // The premise, asserted: both really are the scoped build. Without it the identity below
  // would keep passing if the scope stopped reaching the registry altogether.
  expect(a!.indexCount).toBe(SCOPED_INDEX);
  expect(b!.indexCount).toBe(SCOPED_INDEX);
  expect(b!.uuid, 'two identical scoped arrays must share one instance').toBe(a!.uuid);

  // Diverge ONE of them. Same box, same count, same offset — only the scope differs.
  await dispatch(
    page,
    // `'2-4'`, not `'2-7'` — three faces, the SAME cardinality as `SCOPE_HALF`, which is what
    // makes the row below a claim about the scope's identity rather than its size. Over six
    // faces `'2-7'` names four, and the index counts would have differed for the wrong reason.
    [{ type: 'setParam', nodeId: 'n660_b_op', paramPath: 'scope', value: '2-4' }],
    'diverge b',
  );
  await waitForRebuild(page, 'n660_b', b!.uuid);

  const aAfter = await meshFacts(page, 'n660_a');
  const bAfter = await meshFacts(page, 'n660_b');
  expect(aAfter!.uuid, "the untouched array's instance moved").toBe(a!.uuid);
  expect(bAfter!.uuid, 'two different scopes must not share one instance').not.toBe(a!.uuid);
  // Same cardinality on both sides, so the split is the scope's IDENTITY rather than its
  // size — the reading that separates a key carrying the query from one carrying a count.
  expect(bAfter!.indexCount).toBe(SCOPED_INDEX);
});
