// #535 — RENDER LOCALITY: what a node draws is a function of its own subgraph, so an edit
// that lands in one subgraph cannot change what a disjoint one draws.
//
// ── WHY THIS EXISTS, AND WHY IT IS BEHAVIOURAL ──────────────────────────────────────────
//
// #533 and #530 were not rendering bugs, they were locality violations: resizing one box
// resized a DIFFERENT box, and an override painted itself onto objects nobody had
// decorated. Both reached the screen through one mechanism — two disjoint subgraphs
// holding one registry-shared instance, which is the normal and INTENDED state, since
// content-keyed dedup is the whole point of both registries.
//
// Both are fixed. Neither fix makes the class unreachable. Locality holds today because
// five separate places each independently remembered to clone before mutating — the
// "one rule, N spellings" shape, where the sixth site is the one that forgets.
//
// The structural gates next to the registries (`src/app/registryDoors.gate.test.ts`) can
// see who IMPORTS a registry and who WRITES through a known call, and they say so in their
// own header. Neither key can see the thing that actually produces this bug: a consumer
// that is merely HOLDING a shared instance. It reached it off the scene graph, it imports
// nothing, and it writes through whatever call it likes. There is no static key for that,
// so the backstop has to assert the CONSEQUENCE in a browser: perturb one subgraph, and
// look at everything else the renderer drew.
//
// ── WHY BOTH HALVES, EVERY TIME ─────────────────────────────────────────────────────────
//
// "nothing else changed" alone is passed by a build where the edit does nothing at all —
// which is #537's freeze, a bug this file would then certify as healthy. "the edited one
// changed" alone is passed by a build where everything changed. #533's defect SWAPPED the
// two readings, so only the conjunction sees it. Every case below asserts both.
//
// ── WHY THE PREMISE IS ASSERTED ─────────────────────────────────────────────────────────
//
// The three cubes are authored IDENTICALLY, so the registries hand them ONE geometry and
// ONE material — measured, and asserted before every perturbation. Without that, locality
// is trivially true: a build that stopped sharing anything would pass every case here
// while saying nothing about the class. The premise is what makes the rest load-bearing.
//
// ── WHAT IS COMPARED ────────────────────────────────────────────────────────────────────
//
// Every mesh in the LIVE scene — not only the three this file authors. The starter scene
// contributes seven more, and they are disjoint subgraphs too, so they are bystanders with
// the added virtue that this file did not build them. Per mesh: geometry identity, vertex
// count and real half-extent; material identity, colour and roughness; visibility; and the
// full world matrix. The world matrix is not decoration — the transform rides the GROUP
// while the mesh keeps identity scale, so a bystander that got moved or scaled is INVISIBLE
// to a geometry read. That hole was found by probing this fixture before it was written.
//
// The bystanders are compared as a sorted multiset rather than positionally, so neither
// traversal order nor object identity churn can red this file; only a change to something
// the renderer actually draws can.
//
// ── WHAT THIS DOES NOT COVER — STATED HERE, NOT DISCOVERED LATER ────────────────────────
//
//   · The audit in #535 names five places that preserve locality by cloning. Four are
//     exercised below (the registry's array transform, Apply-Transform's bake, the
//     material registry's no-mutation rule, and attachment — which every case rides on).
//     The FIFTH, the decoded-texture clone taken before a UV transform is applied, is not:
//     it needs an image asset fixture. It is the next thing to add here, and until then it
//     is guarded only by the comment at its own site.
//   · Non-mesh scene chrome (lines, points, helpers) is not read. A violation that only
//     moved a grid line would pass.
//   · The SELECTION GIZMO is excluded, by ancestor type rather than by name. It is not
//     scene content: three.js mounts a `TransformControlsGizmo` subtree under the scene
//     when something is selected, and case 5 selects its target as a side effect of
//     Applying — which appeared here first as a red, ~50 meshes arriving in the bystander
//     set. Excluding it means a violation that only moved the gizmo would pass, which is
//     the right scope: the gizmo is a function of the SELECTION, not of the graph.
//   · Locality at the evaluator / op / undo layer is a larger claim and is NOT asserted —
//     this file is about the renderer's shared GPU resources, which is where both bugs were.
//   · Everything here is read off the scene graph in JS, never off pixels. A violation
//     that leaves every object, instance and matrix correct while drawing wrong — a
//     disposed-but-still-referenced material is the live example, see case 6 — is
//     invisible to this file by construction.
//
// REF: src/app/geometryRegistry.ts + src/app/materialRegistry.ts (the two shared surfaces);
//      src/app/animate/dispatchApplyTransform.ts:365 (`src.clone()` — case 5's subject);
//      src/app/registryDoors.gate.test.ts (the structural half, and the limit this answers);
//      docs/RENDER-RESOURCE-IDENTITY-DESIGN.md; .anvi/non-negotiables.md §5;
//      tests/e2e/p533-shared-geometry-swap.spec.ts + p530-material-instance-sharing.spec.ts
//      (the two instances this generalises); issues #530, #533, #535, #536.

import { expect, test } from './_fixtures';
import { modifierChainOps } from './_modifierStack';

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

/** One mesh's rendered state — everything a director could see it draw. */
interface MeshRow {
  /** Geometry instance identity. Sharing is the premise, so it is read as a uuid. */
  g: string;
  verts: number;
  /** Real half-extent per axis, off the position attribute — the SIZE actually drawn. */
  hx: number;
  hy: number;
  hz: number;
  /** Material instance identity — an appearance read cannot tell sharing from copying. */
  mat: string;
  col: string;
  rough: number;
  vis: boolean;
  /** Full world matrix: the pose rides the group, so geometry alone cannot see a move. */
  mw: string;
}

interface SceneRead {
  /** Meshes under each named object group, in traversal order. */
  byOwner: Record<string, MeshRow[]>;
  /** Every other mesh in the scene — the starter scene's own, and anything else. */
  rest: MeshRow[];
}

const A = { data: 'p535_da', obj: 'p535_oa' };
const B = { data: 'p535_db', obj: 'p535_ob' };
const C = { data: 'p535_dc', obj: 'p535_oc' };
const OWNERS = [A.obj, B.obj, C.obj];

/**
 * Far from the origin on purpose: the starter scene's own meshes sit at world X 0, 3 and 5,
 * and these need to be unmistakably elsewhere.
 */
const X = { a: -20, b: -24, c: -28 };

const SIZE = 1;
const HALF = SIZE / 2;
const BASE_COLOR = '#2244ff';
const BASE_ROUGH = 0.6;

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
    // `__basher_three` exists before its `scene` is populated — waiting on the handle
    // alone races and reads a null scene.
    return Boolean(
      w.__basher_three &&
      w.__basher_three.getState().scene &&
      w.__basher_dag &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
}

/** Three cubes authored identically, each its own Data → Object → Scene subgraph. */
async function seed(page: import('@playwright/test').Page) {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      // Identical size AND identical material: the two registries agree on every content
      // key there is, which is the strongest form of the sharing premise.
      const material = {
        name: 'shared',
        base: { color: a.color },
        specular: { roughness: a.rough },
      };
      const cube = (data: string, obj: string, x: number): Op[] => [
        {
          type: 'addNode',
          nodeId: data,
          nodeType: 'BoxData',
          params: { size: [a.size, a.size, a.size], material },
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
        [
          ...cube(a.a.data, a.a.obj, a.x.a),
          ...cube(a.b.data, a.b.obj, a.x.b),
          ...cube(a.c.data, a.c.obj, a.x.c),
        ],
        'e2e',
        '#535 locality fixture',
      );
    },
    { a: A, b: B, c: C, x: X, size: SIZE, color: BASE_COLOR, rough: BASE_ROUGH },
  );
  await page.waitForTimeout(900);
}

/** Every mesh the renderer is drawing, split into the named subgraphs and everything else. */
async function read(page: import('@playwright/test').Page): Promise<SceneRead> {
  return page.evaluate(async (owners) => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene as {
      getObjectByName: (n: string) => unknown;
      traverse: (f: (o: unknown) => void) => void;
      updateMatrixWorld: (f: boolean) => void;
    } | null;
    // Not optional: `matrixWorld` is stale until the renderer next commits, and reading it
    // unforced returns the same value for every mesh — i.e. the instrument, not the scene.
    scene?.updateMatrixWorld(true);

    interface MeshLike {
      isMesh?: boolean;
      visible?: boolean;
      matrixWorld?: { elements: number[] };
      geometry?: { uuid: string; attributes: { position?: { array: ArrayLike<number> } } };
      material?: { uuid: string; color?: { getHexString(): string }; roughness?: number };
    }
    const row = (o: unknown) => {
      const m = o as MeshLike;
      const arr = m.geometry!.attributes.position?.array ?? [];
      let hx = 0;
      let hy = 0;
      let hz = 0;
      for (let i = 0; i + 2 < arr.length; i += 3) {
        hx = Math.max(hx, Math.abs(arr[i]));
        hy = Math.max(hy, Math.abs(arr[i + 1]));
        hz = Math.max(hz, Math.abs(arr[i + 2]));
      }
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      return {
        g: m.geometry!.uuid,
        verts: arr.length / 3,
        hx: r3(hx),
        hy: r3(hy),
        hz: r3(hz),
        mat: m.material!.uuid,
        col: m.material!.color ? `#${m.material!.color.getHexString()}` : '',
        rough: m.material!.roughness ?? -1,
        vis: m.visible !== false,
        mw: (m.matrixWorld?.elements ?? []).map(r3).join(','),
      };
    };
    /**
     * Editor chrome — the PRODUCTION predicate, imported through the dev server rather
     * than spelled again here (#546). It used to be the third copy of a rule whose other
     * two already described each other as mirrors, and it arrived the way third copies
     * do: this file needed the answer, could not import it because the function was
     * module-private, and wrote it out — matching the gizmo clause and NOT the flag on
     * the first pass, so real chrome was compared as scene content.
     *
     * What stays local is the ANCESTRY: the predicate answers "is this object chrome",
     * and a leaf mesh under a chrome group is not chrome by that answer. This file reads
     * leaves, so it walks up, exactly as sceneBounds prunes on the way down.
     */
    const { isEditorChrome } = await import('/src/app/editorChrome.ts');
    const isChrome = (o: unknown) => {
      let p: unknown = o;
      for (let i = 0; i < 16 && p; i++) {
        const q = p as { parent?: unknown };
        if (isEditorChrome(q as Parameters<typeof isEditorChrome>[0])) return true;
        p = q.parent;
      }
      return false;
    };
    const drawable = (o: unknown) => {
      const m = o as MeshLike;
      return Boolean(m.isMesh && m.geometry && m.material) && !isChrome(o);
    };

    const byOwner: Record<string, ReturnType<typeof row>[]> = {};
    const owned = new Set<unknown>();
    for (const n of owners) {
      const grp = scene?.getObjectByName(n) as
        | { traverse: (f: (o: unknown) => void) => void }
        | undefined;
      const rows: ReturnType<typeof row>[] = [];
      grp?.traverse((o) => {
        owned.add(o);
        if (drawable(o)) rows.push(row(o));
      });
      byOwner[n] = rows;
    }
    const rest: ReturnType<typeof row>[] = [];
    scene?.traverse((o) => {
      if (!owned.has(o) && drawable(o)) rest.push(row(o));
    });
    return { byOwner, rest };
  }, OWNERS);
}

/**
 * Everything the renderer drew EXCEPT the subgraph under `perturbed`, as a sorted multiset.
 *
 * Sorted rather than positional so that traversal order and object identity churn cannot
 * red this file — only a change to something actually drawn can.
 */
function bystanders(s: SceneRead, perturbed: string): string[] {
  const rows = [...s.rest];
  for (const [owner, list] of Object.entries(s.byOwner)) {
    if (owner !== perturbed) rows.push(...list);
  }
  return rows.map((r) => JSON.stringify(r)).sort();
}

/** One mesh per subgraph, all three sharing one geometry and one material. */
function expectSharedPremise(s: SceneRead) {
  const [a, b, c] = OWNERS.map((o) => s.byOwner[o]);
  expect(a, `subgraph ${A.obj} must draw exactly one mesh`).toHaveLength(1);
  expect(b, `subgraph ${B.obj} must draw exactly one mesh`).toHaveLength(1);
  expect(c, `subgraph ${C.obj} must draw exactly one mesh`).toHaveLength(1);
  // Without this the whole file is about a registry that never shares, and locality is
  // trivially true.
  expect(b[0].g, 'the three cubes must START on one shared geometry').toBe(a[0].g);
  expect(c[0].g, 'the three cubes must START on one shared geometry').toBe(a[0].g);
  expect(b[0].mat, 'the three cubes must START on one shared material').toBe(a[0].mat);
  expect(c[0].mat, 'the three cubes must START on one shared material').toBe(a[0].mat);
  expect(a[0].hx).toBeCloseTo(HALF, 5);
  expect(a[0].col).toBe(BASE_COLOR);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await seed(page);
});

test('#535 — resizing one object resizes THAT object, and moves nothing else in the scene', async ({
  page,
}) => {
  const before = await read(page);
  expectSharedPremise(before);
  const others = bystanders(before, A.obj);

  await page.evaluate(
    (a) => {
      (window as unknown as UiWindow).__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: a.data, paramPath: 'size', value: [4, 1, 1] }],
          'user',
          '#535 resize one sharer',
        );
    },
    { data: A.data },
  );
  await page.waitForTimeout(900);

  const after = await read(page);
  // Half 1 — the edit reached the screen. Without it, half 2 certifies a frozen build.
  expect(after.byOwner[A.obj][0].hx, 'the edited object did not resize').toBeCloseTo(2, 5);
  // Half 2 — and it stayed home. This is the direction #533 failed in.
  expect(bystanders(after, A.obj), 'an object nobody edited changed').toEqual(others);
});

test('#535 — recolouring one object recolours THAT object, and repaints nothing else', async ({
  page,
}) => {
  const NEXT = '#ff8800';
  const before = await read(page);
  expectSharedPremise(before);
  const others = bystanders(before, B.obj);
  const geomBefore = before.byOwner[B.obj][0].g;

  await page.evaluate(
    (a) => {
      (window as unknown as UiWindow).__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: a.data, paramPath: 'material.base.color', value: a.next }],
          'user',
          '#535 recolour one sharer',
        );
    },
    { data: B.data, next: NEXT },
  );
  await page.waitForTimeout(900);

  const after = await read(page);
  expect(after.byOwner[B.obj][0].col, 'the edited object did not recolour').toBe(NEXT);
  // A recolour must not churn geometry: it splits the material instance and nothing else.
  expect(after.byOwner[B.obj][0].g, 'a recolour churned the geometry').toBe(geomBefore);
  expect(bystanders(after, B.obj), 'an object nobody recoloured changed').toEqual(others);
});

test('#535 — splicing an operator into one data lane rebuilds THAT geometry, and no other', async ({
  page,
}) => {
  const before = await read(page);
  expectSharedPremise(before);
  const others = bystanders(before, C.obj);
  const vertsBefore = before.byOwner[C.obj][0].verts;

  // The registry's array road CLONES the source before transforming it. Without that
  // clone it would transform the very instance the other two cubes are drawing.
  await page.evaluate(
    (a) => {
      (window as unknown as UiWindow).__basher_dag
        .getState()
        .dispatchAtomic(a.ops as Op[], 'user', '#535 splice an operator');
    },
    {
      ops: modifierChainOps({
        objectId: C.obj,
        dataId: C.data,
        modifiers: [
          {
            id: 'p535_arr',
            nodeType: 'ArrayModifier',
            params: { count: 3, offset: [2, 0, 0], muted: false },
          },
        ],
      }),
    },
  );
  await page.waitForTimeout(1200);

  const after = await read(page);
  expect(after.byOwner[C.obj][0].verts, 'the operator did not reach the screen').toBe(
    vertsBefore * 3,
  );
  expect(bystanders(after, C.obj), 'an object with no operator on it changed').toEqual(others);
});

test('#535 — linking a Material node repaints THAT object, and leaves its co-sharers alone', async ({
  page,
}) => {
  const LINKED = '#22ff44';
  const before = await read(page);
  expectSharedPremise(before);
  const others = bystanders(before, A.obj);

  await page.evaluate(
    (a) => {
      (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: a.mat,
            nodeType: 'Material',
            params: { material: { name: 'linked', base: { color: a.color } } },
          },
          {
            type: 'connect',
            from: { node: a.mat, socket: 'out' },
            to: { node: a.data, socket: 'material' },
          },
        ],
        'user',
        '#535 link a material',
      );
    },
    { mat: 'p535_mat', data: A.data, color: LINKED },
  );
  await page.waitForTimeout(1200);

  const after = await read(page);
  expect(after.byOwner[A.obj][0].col, 'the linked material did not reach the screen').toBe(LINKED);
  expect(bystanders(after, A.obj), 'an object with no link on it changed').toEqual(others);
});

test('#535 — baking a pose into one object bakes THAT geometry, and not the one it shares', async ({
  page,
}) => {
  const before = await read(page);
  expectSharedPremise(before);
  const others = bystanders(before, B.obj);

  // Pose, then Apply — both edits land in B's subgraph, so both must stay there. Apply
  // clones the source before `applyMatrix4`; without the clone it bakes the pose into the
  // instance the other two cubes are drawing, which is exactly H45.
  await page.evaluate(
    (a) => {
      (window as unknown as UiWindow).__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: a.obj, paramPath: 'scale', value: [3, 1, 1] }],
          'user',
          '#535 pose one sharer',
        );
    },
    { obj: B.obj },
  );
  await page.waitForTimeout(700);

  const applied = await page.evaluate(async (obj) => {
    const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
    return (await mod.dispatchApplyTransform(obj, 'all')) as { ok: boolean; reason?: string };
  }, B.obj);
  // Vacuity guard: a refused Apply would leave the scene untouched and pass half 2 alone.
  expect(applied.ok, `Apply Transform was refused: ${applied.reason ?? ''}`).toBe(true);
  await page.waitForTimeout(1200);

  const after = await read(page);
  // The pose is baked into the verts, so the drawn half-extent along X grows with it.
  expect(after.byOwner[B.obj][0].hx, 'the bake did not reach the screen').toBeGreaterThan(
    before.byOwner[B.obj][0].hx,
  );
  expect(bystanders(after, B.obj), 'an object nobody posed changed').toEqual(others);
});

test('#535 — deleting one sharer leaves the objects it was sharing with drawing exactly as before', async ({
  page,
}) => {
  const before = await read(page);
  expectSharedPremise(before);
  // C is the one being removed, so the bystanders here are A, B and the starter scene.
  const others = bystanders(before, C.obj);

  // The only perturbation here that REMOVES a holder rather than editing one, which is
  // why it is worth its own case: it is the single path that reaches the material
  // registry's refcount and its deferred eviction. Per-consumer bookkeeping is the one
  // piece of shared state a consumer genuinely owns, so it is where the next violation
  // is likeliest to land.
  //
  // ⚠️ NON-DISCRIMINATING FOR THE REFCOUNT ITSELF, and this is measured, not assumed.
  // Deleting BOTH guards in `materialRegistry.release` — so that any release evicts and
  // a surviving holder is ignored — leaves all six cases GREEN. The reason is a property
  // of this reader, not of the registry: eviction disposes the material and drops the
  // cache entry, but the two surviving meshes keep their existing references, and
  // `dispose()` changes neither uuid nor colour. They never re-`get`, because their own
  // spec did not change. A JS-level read cannot see a disposed-but-still-referenced
  // material; only a pixel read could.
  //
  // What this case DOES discriminate: that the delete happens at all (it caught the
  // op being refused outright — `removeNode` on a still-consumed node), and any future
  // implementation where removing one holder re-points or rebuilds what its co-sharers
  // draw. Both are the shapes this file exists for. The refcount's own correctness is
  // unit-tested beside the registry; do not read this case as covering it.
  await page.evaluate(
    (a) => {
      const dag = (window as unknown as UiWindow).__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      // The edges come out first: `removeNode` on a still-consumed node is REFUSED
      // (`p535_oc is still consumed by n_scene`), which surfaced here as a thrown
      // evaluate rather than a quiet no-op — the deletion has to really happen for
      // half 2 to mean anything.
      dag.dispatchAtomic(
        [
          {
            type: 'disconnect',
            from: { node: a.obj, socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
          {
            type: 'disconnect',
            from: { node: a.data, socket: 'out' },
            to: { node: a.obj, socket: 'data' },
          },
          { type: 'removeNode', nodeId: a.obj },
          { type: 'removeNode', nodeId: a.data },
        ],
        'user',
        '#535 delete one sharer',
      );
    },
    { obj: C.obj, data: C.data },
  );
  // Longer than the others on purpose: eviction is queued a microtask after the refcount
  // hits zero, and a co-sharer blanking would appear after the delete, not with it.
  await page.waitForTimeout(1500);

  const after = await read(page);
  // Half 1 — the delete actually happened. Without it, half 2 passes on a no-op.
  expect(after.byOwner[C.obj], 'the deleted object is still being drawn').toHaveLength(0);
  // Half 2 — and the two it was sharing with are untouched, instances included.
  expect(bystanders(after, C.obj), 'deleting one sharer changed another object').toEqual(others);
});

test('#535 — hiding one object hides only it, and unhiding restores exactly what it drew', async ({
  page,
}) => {
  const before = await read(page);
  expectSharedPremise(before);
  const others = bystanders(before, A.obj);
  const mineBefore = before.byOwner[A.obj];

  // This case exists because the op-union census demanded it, not because anyone thought
  // of it: `setHidden` writes the very visibility this file's snapshot already reads, and
  // five hand-picked perturbations plus a self-review had all missed it. Measured: hiding
  // does not set `visible = false`, it takes the mesh OUT of the scene — so a hide that
  // leaked across subgraphs would blank a co-sharer outright.
  const hide = async (hidden: boolean) => {
    await page.evaluate(
      (a) => {
        (window as unknown as UiWindow).__basher_dag
          .getState()
          .dispatchAtomic(
            [{ type: 'setHidden', nodeId: a.obj, hidden: a.hidden }],
            'user',
            '#535 toggle one object',
          );
      },
      { obj: A.obj, hidden },
    );
    await page.waitForTimeout(900);
  };

  await hide(true);
  const hidden = await read(page);
  // Half 1 — the hide reached the screen.
  expect(hidden.byOwner[A.obj], 'the hidden object is still being drawn').toHaveLength(0);
  // Half 2 — and it took nothing with it. The co-sharers draw the same INSTANCES, which is
  // the direction that matters: they hold the geometry and material the hidden one held.
  expect(bystanders(hidden, A.obj), 'hiding one object changed another').toEqual(others);

  await hide(false);
  const shown = await read(page);
  // Coming back must restore what it drew, instances included — a round trip that handed
  // it a private copy would be a silent un-sharing, invisible to any appearance read.
  expect(shown.byOwner[A.obj], 'unhiding did not restore what the object drew').toEqual(mineBefore);
  expect(bystanders(shown, A.obj), 'unhiding one object changed another').toEqual(others);
});
