// #638 (ns-1b step 8) — THE DONE-WHEN. A mesh whose faces carry more than one material
// index draws with more than one material, in the running app, and the registry still hands
// one `BufferGeometry` to every mesh whose data is genuinely the same.
//
// ── WHY THIS FILE IS THE ONLY INSTRUMENT FOR THE LAST MILE ────────────────────────────
//
// Measured at step 7, on this tree: with the resolver still called and its answer discarded
// at the `<mesh>`, the unit tier is 338 files / 4059 tests GREEN, byte for byte. Reverting
// the call itself reds exactly one test, and that one is a source census over call sites
// rather than an assertion about anything drawn. This repo has no React component test tier
// at all, so a mounted mesh's props are not observable below Playwright. Everything the
// phase derives is covered; the step where the derivation becomes a picture is covered here
// or nowhere.
//
// ── WHY THE SCENE IS AUTHORED THROUGH THE OPS ROAD ────────────────────────────────────
//
// Nothing in the default project wires a partial-range assignment, so the two-material mesh
// does not exist until this spec makes one. It is authored the way the graph editor authors
// it — `addNode` / `connect` / `setParam` through `dispatchAtomic`, every op parsed by the
// node's own schema — never by injecting a value into the renderer. An observation of
// something the app cannot produce is the covered-but-unhonoured shape this epic has
// already paid for three times (#367).
//
// ── WHAT IS DELIBERATELY NOT USED ─────────────────────────────────────────────────────
//
// `renderer.info.render.calls`. `PerfProbe.tsx:15-19` documents it as under-reporting behind
// the composer, which `SceneFromDAG.tsx` mounts unconditionally, so it would answer a
// question about the composer while wearing the name of a question about draw groups.
// `info.memory.geometries` (clause 4) counts allocated GL resources rather than per-frame
// draws and is not affected.
//
// REF: src/app/resolveMeshMaterial.ts (the one decision); src/app/geometryRegistry.ts
//      (`build` — the only writer of the layout); src/nodes/SetMaterialOp.ts (the authoring
//      surface); issues #638, #634, #530, #533.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

/** The blue the wired material carries — chosen to be unmistakable against the seed green. */
const BLUE = '#0000ff';

interface Op {
  type: string;
  [k: string]: unknown;
}

interface MeshFacts {
  readonly name: string;
  readonly isArray: boolean;
  readonly materialCount: number;
  readonly groupCount: number;
  readonly groups: { start: number; count: number; materialIndex?: number }[];
  readonly geometryUuid: string;
}

/** The five numbers §1 clause 3 requires — never a boolean, and never a bare violation count. */
interface CoverageReport {
  readonly examined: number;
  readonly indexed: number;
  readonly nonIndexed: number;
  readonly violations: readonly string[];
  readonly instrumentErrors: readonly string[];
}

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, unknown>; outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_three: {
    getState: () => {
      scene: unknown;
      camera: unknown;
      gl: { info: { memory: { geometries: number } }; domElement: HTMLCanvasElement } | null;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void; primaryNodeId: string | null };
  };
  __basher_geometry_registry: { size: () => number };
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
  __basher_mesh_material?: (
    nodeId: string,
  ) => { materialCount: number; type: string | null; color: string | null } | null;
}

/**
 * The ops the graph editor emits for "assign this material to faces [from, to] of that box".
 *
 * `connect` onto a single-cardinality input REPLACES the prior binding, so splicing the
 * operator between the data node and its Object needs no `disconnect` — which is also how
 * the editor does it.
 */
function authorOps(
  dataId: string,
  objectId: string,
  opId: string,
  matId: string,
  faceFrom: number,
  faceTo: number,
): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: matId,
      nodeType: 'Material',
      params: { material: { name: `${matId}-blue`, base: { color: BLUE } } },
    },
    { type: 'addNode', nodeId: opId, nodeType: 'SetMaterialOp', params: { faceFrom, faceTo } },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: opId, socket: 'target' },
    },
    {
      type: 'connect',
      from: { node: matId, socket: 'out' },
      to: { node: opId, socket: 'material' },
    },
    {
      type: 'connect',
      from: { node: opId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    },
  ];
}

/** A whole second box — data, object, its own operator — parked clear of the seed cube. */
function secondBoxOps(sceneId: string, x: number): Op[] {
  return [
    { type: 'addNode', nodeId: 'n_box2_data', nodeType: 'BoxData', params: { size: [1, 1, 1] } },
    {
      type: 'addNode',
      nodeId: 'n_box2',
      nodeType: 'Object',
      params: { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    ...authorOps('n_box2_data', 'n_box2', 'n_setmat2', 'n_mat2', 0, 1),
    {
      type: 'connect',
      from: { node: 'n_box2', socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    },
  ];
}

/** The same again at a DIFFERENT size — a box whose key cannot already be resident. */
function distinctBoxOps(sceneId: string, x: number): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: 'n_box3_data',
      nodeType: 'BoxData',
      params: { size: [1.3, 1.3, 1.3] },
    },
    {
      type: 'addNode',
      nodeId: 'n_box3',
      nodeType: 'Object',
      params: { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    ...authorOps('n_box3_data', 'n_box3', 'n_setmat3', 'n_mat3', 0, 1),
    {
      type: 'connect',
      from: { node: 'n_box3', socket: 'out' },
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

/** The mounted mesh under the pick band named `nodeId`, read off the real scene graph. */
async function meshFacts(page: Page, nodeId: string): Promise<MeshFacts | null> {
  return page.evaluate((id) => {
    interface Obj {
      name?: string;
      type?: string;
      children?: Obj[];
      material?: unknown;
      geometry?: {
        uuid: string;
        groups?: { start: number; count: number; materialIndex?: number }[];
      };
    }
    const scene = (window as unknown as W).__basher_three.getState().scene as Obj | null;
    if (!scene) return null;
    let band: Obj | null = null;
    const findBand = (o: Obj): void => {
      if (o.name === id) band = o;
      if (band === null) (o.children ?? []).forEach(findBand);
    };
    findBand(scene);
    if (band === null) return null;
    let mesh: Obj | null = null;
    const findMesh = (o: Obj): void => {
      if (mesh === null && o.type === 'Mesh' && o.geometry) mesh = o;
      if (mesh === null) (o.children ?? []).forEach(findMesh);
    };
    findMesh(band);
    if (mesh === null) return null;
    const m = mesh as Obj;
    const mat = m.material;
    return {
      name: id,
      isArray: Array.isArray(mat),
      materialCount: Array.isArray(mat) ? mat.length : 1,
      groupCount: m.geometry?.groups?.length ?? 0,
      groups: (m.geometry?.groups ?? []).map((g) => ({
        start: g.start,
        count: g.count,
        materialIndex: g.materialIndex,
      })),
      geometryUuid: m.geometry?.uuid ?? '',
    };
  }, nodeId);
}

async function waitForTwoMaterialMesh(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      interface Obj {
        name?: string;
        type?: string;
        children?: Obj[];
        material?: unknown;
      }
      const scene = (window as unknown as W).__basher_three.getState().scene as Obj | null;
      if (!scene) return false;
      let found = false;
      const walk = (o: Obj, inBand: boolean): void => {
        const here = inBand || o.name === id;
        if (here && o.type === 'Mesh' && Array.isArray(o.material) && o.material.length === 2) {
          found = true;
        }
        (o.children ?? []).forEach((c) => walk(c, here));
      };
      walk(scene, false);
      return found;
    },
    nodeId,
    { timeout: 15_000 },
  );
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
      w.__basher_geometry_registry &&
      w.__basher_three.getState().scene &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

// ── CLAUSE 1 ──────────────────────────────────────────────────────────────────────────
test('a box assigned two materials DRAWS with both, and can still be picked', async ({ page }) => {
  await dispatch(page, authorOps('n_box_data', 'n_box', 'n_setmat', 'n_mat_blue', 0, 1), 'assign');
  await waitForTwoMaterialMesh(page, 'n_box');

  // The scene walk: the mesh that is actually mounted, not the value that fed it.
  const facts = await meshFacts(page, 'n_box');
  expect(facts).not.toBeNull();
  expect(facts!.isArray).toBe(true);
  expect(facts!.materialCount).toBe(2);
  // Faces 0–1 are one run and the remaining ten are another: two groups, never six.
  expect(facts!.groupCount).toBe(2);
  // THE GRANULARITY, ON THE LIVE INSTANCE. Faces 0–1 are index elements [0,6) and the
  // remaining ten are [6,36) — the triangle boundary. A cube-side implementation would put
  // the split at 12 and still cover all 36, which is the error the aligned 6/6 fixture
  // cannot see and the reason this asserts the boundary rather than the coverage.
  expect(facts!.groups).toEqual([
    { start: 0, count: 6, materialIndex: 1 },
    { start: 6, count: 30, materialIndex: 0 },
  ]);

  // THE STANDING PROBE, on the mesh that broke it. `__basher_mesh_material` is what the
  // whole browser tier reads material through, and before it was widened it answered a
  // multi-material mesh with a full set of plausible NULLS — a cast, an array that is
  // truthy, and every field off it null. That reads as "no material yet", which is exactly
  // what an ordinary async gap reads as. `materialCount` is the field that tells them apart.
  const probe = await page.evaluate(() =>
    (window as unknown as W).__basher_mesh_material!('n_box'),
  );
  expect(probe, 'the standing probe must not answer a two-material mesh with nulls').not.toBeNull();
  expect(probe!.materialCount).toBe(2);
  expect(probe!.type).not.toBeNull();
  expect(probe!.color).not.toBeNull();

  // PIXELS — the real render, decoded and sampled. Falsifiable by construction: with the
  // resolved array discarded at the mesh the whole cube reads one colour, and the blue
  // count goes to zero while every derivation stays green.
  const sample = await page.evaluate(async () => {
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
    let wired = 0;
    let source = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      // THE WIRED MATERIAL is blue-dominant with a margin, so the stage background — which
      // is a very slightly blue near-black — cannot be counted as it.
      if (b > r + 30 && b > g + 30) wired++;
      // THE SOURCE MATERIAL is the seed cube's standard grey (#cccccc — measured, not
      // assumed; an earlier draft of this spec looked for green and found zero of it while
      // the render was entirely correct). Neutral with a brightness floor the background
      // cannot reach.
      else if (r >= 48 && Math.abs(r - g) <= 12 && Math.abs(g - b) <= 12 && Math.abs(r - b) <= 12)
        source++;
    }
    return { wired, source, total: px.length / 4 };
  });
  expect(sample).not.toBeNull();
  // Both materials are on screen at once, on ONE mesh. The counts go into the message
  // rather than only into the threshold, so a change that shrinks a face to a sliver reads
  // as a number rather than as a pass.
  const seen = `wired(blue): ${sample!.wired}, source(grey): ${sample!.source}`;
  expect(sample!.wired, seen).toBeGreaterThan(5_000);
  expect(sample!.source, seen).toBeGreaterThan(5_000);

  // PICK — the third of the three losses an empty layout costs, and the only one of them
  // that reaches a director as a UI bug rather than a render bug ("I cannot select this").
  await page.evaluate(() => (window as unknown as W).__basher_selection.getState().select(null));
  const click = await page.evaluate(() => {
    interface V3 {
      x: number;
      y: number;
      z: number;
      project: (c: unknown) => V3;
    }
    const w = window as unknown as W;
    const three = w.__basher_three.getState();
    const gl = three.gl;
    if (!gl) return null;
    interface Obj {
      name?: string;
      type?: string;
      children?: Obj[];
      getWorldPosition?: (v: unknown) => V3;
    }
    const scene = three.scene as Obj | null;
    let mesh: Obj | null = null;
    const walk = (o: Obj, inBand: boolean): void => {
      const here = inBand || o.name === 'n_box';
      if (mesh === null && here && o.type === 'Mesh') mesh = o;
      (o.children ?? []).forEach((c) => walk(c, here));
    };
    if (scene) walk(scene, false);
    if (mesh === null) return null;
    // Project the mesh's own world position through the EDITOR camera — the camera the
    // canvas is actually drawn with — rather than guessing viewport coordinates.
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
  expect(click).not.toBeNull();
  await page.mouse.click(click!.x, click!.y);
  await page.waitForFunction(
    () => (window as unknown as W).__basher_selection.getState().primaryNodeId === 'n_box',
    undefined,
    { timeout: 5_000 },
  );
});

// ── CLAUSE 2 ──────────────────────────────────────────────────────────────────────────
test('two boxes with the SAME assignment share one BufferGeometry, and editing one leaves the other alone', async ({
  page,
}) => {
  const sceneId = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.outputs.scene!.node,
  );
  await dispatch(page, authorOps('n_box_data', 'n_box', 'n_setmat', 'n_mat_blue', 0, 1), 'assign');
  await dispatch(page, secondBoxOps(sceneId, 2.5), 'second box');
  await waitForTwoMaterialMesh(page, 'n_box');
  await waitForTwoMaterialMesh(page, 'n_box2');

  const a = await meshFacts(page, 'n_box');
  const b = await meshFacts(page, 'n_box2');
  // IDENTITY FIRST. A clone-per-object implementation draws identically and passes every
  // other clause in this file; this is the assertion it cannot pass.
  expect(a!.geometryUuid).toBe(b!.geometryUuid);

  // THE PERTURBATION IS THE ASSERTION. Edit ONE object's assignment; the other must not
  // move — not its instance, not its material count.
  await dispatch(
    page,
    [{ type: 'setParam', nodeId: 'n_setmat2', paramPath: 'faceTo', value: 5 }],
    'widen',
  );
  await page.waitForFunction(
    (before) => {
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
        const here = inBand || o.name === 'n_box2';
        if (uuid === null && here && o.type === 'Mesh' && o.geometry) uuid = o.geometry.uuid;
        (o.children ?? []).forEach((c) => walk(c, here));
      };
      walk(scene, false);
      return uuid !== null && uuid !== before;
    },
    b!.geometryUuid,
    { timeout: 10_000 },
  );

  const aAfter = await meshFacts(page, 'n_box');
  const bAfter = await meshFacts(page, 'n_box2');
  expect(aAfter!.geometryUuid).toBe(a!.geometryUuid); // untouched by its neighbour's edit
  expect(aAfter!.materialCount).toBe(2);
  expect(aAfter!.groupCount).toBe(2);
  expect(bAfter!.geometryUuid).not.toBe(a!.geometryUuid); // and they are now two instances
  expect(bAfter!.materialCount).toBe(2);
});

// ── CLAUSE 3 ──────────────────────────────────────────────────────────────────────────
test('NOTHING VANISHED — every mounted mesh is fully covered by the materials it resolves to', async ({
  page,
}) => {
  await dispatch(page, authorOps('n_box_data', 'n_box', 'n_setmat', 'n_mat_blue', 0, 1), 'assign');
  await waitForTwoMaterialMesh(page, 'n_box');

  const report: CoverageReport = await page.evaluate(() => {
    interface Obj {
      name?: string;
      type?: string;
      children?: Obj[];
      material?: unknown;
      geometry?: {
        index?: { count: number } | null;
        groups?: { count: number; materialIndex?: number }[];
      };
    }
    const scene = (window as unknown as W).__basher_three.getState().scene as Obj | null;
    const violations: string[] = [];
    const instrumentErrors: string[] = [];
    let examined = 0;
    let indexed = 0;
    let nonIndexed = 0;
    const visit = (o: Obj, label: string): void => {
      if (o.type === 'Mesh' && o.geometry) {
        examined++;
        try {
          const index = o.geometry.index ?? null;
          // ARM A FIRST, and the order is the substance: evaluating `index.count` before
          // testing for null throws on an ordinary non-indexed mesh, and this scene mounts
          // one. A non-indexed mesh must simply never be handed an array.
          if (index === null) {
            nonIndexed++;
            if (Array.isArray(o.material)) {
              violations.push(`${label}: NON-INDEXED mesh handed a material array`);
            }
          } else if (!Array.isArray(o.material)) {
            indexed++; // arm B — a single material covers the whole index by definition
          } else {
            indexed++;
            const slots = o.material.length;
            let covered = 0;
            for (const g of o.geometry.groups ?? []) {
              // A group whose slot resolves to no material is UNCOVERED — three.js
              // declares `materialIndex` optional, and `material[undefined]` is skipped
              // by the same path as an out-of-range slot.
              if (g.materialIndex !== undefined && g.materialIndex < slots) covered += g.count;
            }
            if (covered !== index.count) {
              violations.push(
                `${label}: covers ${covered} of ${index.count} across ${slots} slots`,
              );
            }
          }
        } catch (e) {
          // A RAISE IS AN INSTRUMENT FAILURE, never a red: "the coverage property is
          // violated" and "the coverage function is broken" have opposite fixes.
          instrumentErrors.push(`${label}: ${String(e)}`);
        }
      }
      (o.children ?? []).forEach((c, i) => visit(c, o.name ? `${o.name}/${i}` : `${label}/${i}`));
    };
    if (scene) visit(scene, 'scene');
    return { examined, indexed, nonIndexed, violations, instrumentErrors };
  });

  // Five numbers, not a boolean. `indexed === 0` would be a VACUOUS pass, so the
  // denominator is asserted before the property.
  expect(report.instrumentErrors, JSON.stringify(report)).toEqual([]);
  expect(report.examined, JSON.stringify(report)).toBeGreaterThan(0);
  expect(report.indexed, JSON.stringify(report)).toBeGreaterThan(0);
  expect(report.violations, JSON.stringify(report)).toEqual([]);
});

// ── CLAUSE 4 ──────────────────────────────────────────────────────────────────────────
//
// 🔴 WRITTEN AS A SHARED-vs-DISTINCT PAIR, NOT AS AN ADD/REMOVE CYCLE, AND THE REASON IS
// MEASURED. The plan asked for the two instruments to move together across an add and a
// remove. Observed on this tree: after a remove NEITHER number moves, and that is the
// sweep's design rather than a leak — both of its triggers are driven by the registry's
// SIZE (`geometrySweep.ts`: an unverified-growth budget and a quiet period latched at
// `lastSweptSize`), while deleting an object changes the SCENE and leaves the size
// untouched. So a deletion frees nothing until the population next grows. That is a real
// property worth its own issue, but as a done-when clause it would assert a cadence this
// phase does not own — and "both stayed flat" cannot tell a working pair from a broken one.
//
// The pair below discriminates instead of merely moving: adding a box that SHARES an
// existing key must cost NOTHING in either instrument, while adding one with a distinct
// size must cost exactly ONE in BOTH. A clone slipped in behind the registry — the failure
// this clause exists for — makes the shared add cost a GL geometry while the registry stays
// flat, which is precisely the reading these two numbers together can see and clause 2's
// uuid identity cannot.
test('the lifetime pair: a SHARED add costs nothing in either instrument, a DISTINCT add costs one in both', async ({
  page,
}) => {
  const sceneId = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.outputs.scene!.node,
  );
  const read = () =>
    page.evaluate(() => {
      const w = window as unknown as W;
      return {
        registry: w.__basher_geometry_registry.size(),
        gl: w.__basher_three.getState().gl?.info.memory.geometries ?? -1,
      };
    });

  await dispatch(page, authorOps('n_box_data', 'n_box', 'n_setmat', 'n_mat_blue', 0, 1), 'assign');
  await waitForTwoMaterialMesh(page, 'n_box');
  // Settle first: the baseline has to be read after the sweep has collected the plain box
  // the assignment replaced, or the deltas below measure the collection, not the adds.
  await page.waitForTimeout(2_000);
  const before = await read();

  await dispatch(page, secondBoxOps(sceneId, 2.5), 'shared add');
  await waitForTwoMaterialMesh(page, 'n_box2');
  await page.waitForTimeout(2_000);
  const shared = await read();
  expect(shared.registry, JSON.stringify({ before, shared })).toBe(before.registry);
  expect(shared.gl, JSON.stringify({ before, shared })).toBe(before.gl);

  // The control: same operator, same range, DIFFERENT size — so the only difference between
  // this add and the one above is whether the key already exists.
  await dispatch(page, distinctBoxOps(sceneId, -2.5), 'distinct add');
  await waitForTwoMaterialMesh(page, 'n_box3');
  await page.waitForTimeout(2_000);
  const distinct = await read();
  expect(distinct.registry, JSON.stringify({ shared, distinct })).toBe(shared.registry + 1);
  expect(distinct.gl, JSON.stringify({ shared, distinct })).toBe(shared.gl + 1);
});
