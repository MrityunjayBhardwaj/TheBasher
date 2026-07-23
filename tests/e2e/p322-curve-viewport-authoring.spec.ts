// #322 — the path is fully authorable in the VIEWPORT: point handles, the element gizmo,
// extrude, delete, close the loop.
//
// WHAT ONLY AN E2E CAN SEE HERE. Three boundaries, none of them visible to a unit test:
//
//   1. HANDLE ↔ RENDERER. A handle is drawn at `M · p` (M from resolveWorldTransform); the
//      line is drawn by a three.js <group position rotation scale>. Two compositions of one
//      TRS — exactly the pair #321's seam test pinned, now with a third party. If they
//      diverge, the director grabs a handle that is not on the path, and every unit
//      assertion stays green.
//   2. THE DRAG ROUND-TRIP. The gizmo moves the proxy in WORLD space; the param is LOCAL.
//      The conversion (M⁻¹) only exists in the running app, and it is only exercised under
//      a real world matrix — which is why the drag here happens on a curve that is offset,
//      rotated and NON-UNIFORMLY scaled. Get the inverse wrong and the point lands
//      somewhere else entirely, with the unit tests none the wiser.
//   3. THE GIZMO SWAP. Two TransformControls must never coexist. That is a fact about the
//      mounted scene, not about a store.
//
// Pointer-driven TransformControls dragging is famously fragile in headless Chromium (the
// same stance p26-acceptance and the #68 gizmo tests take), so the drag is driven through
// the dev seam — which moves the REAL proxy and calls the REAL onObjectChange, i.e. the
// world→local conversion under test. The seam is a driver, not a shortcut: it does not
// dispatch, it drives the code that dispatches.

import { expect, test } from './_fixtures';

type Vec3 = [number, number, number];

interface ThreeObjLike {
  isLine?: boolean;
  name?: string;
  parent?: ThreeObjLike | null;
  type?: string;
  geometry?: { getAttribute: (n: string) => { array: ArrayLike<number> } };
  matrixWorld: { elements: number[] };
  updateWorldMatrix: (parents: boolean, children: boolean) => void;
}
interface BasherWin {
  __basher_dag: {
    getState(): {
      state: {
        nodes: Record<
          string,
          {
            type: string;
            params: Record<string, unknown>;
            inputs?: Record<string, { node?: string }>;
          }
        >;
      };
      dispatchAtomic: (ops: unknown[], src: string, d: string) => void;
    };
  };
  __basher_curve_sample: (nodeId: string, u: number) => { point: Vec3; length: number } | null;
  __basher_curve_handles: () => {
    curveId: string | null;
    selectedIndex: number | null;
    world: Vec3[];
  };
  __basher_curve_select_point: (nodeId: string, index: number) => void;
  __basher_curve_clear_point: () => void;
  __basher_curve_point_grab: (target: Vec3) => void;
  __basher_three: {
    getState: () => { scene: { traverse: (cb: (o: ThreeObjLike) => void) => void } | null };
  };
}

async function addCurve(page: import('@playwright/test').Page): Promise<string> {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+A');
  await expect(page.getByTestId('add-menu')).toBeVisible();
  await page.getByTestId('add-menu-empty').hover();
  await expect(page.getByTestId('add-menu-empty-panel')).toBeVisible();
  await page.getByTestId('add-menu-item-Curve').click();
  await expect(page.getByTestId('add-menu')).toHaveCount(0);
  return page.evaluate(() => {
    const s = (window as unknown as BasherWin).__basher_dag.getState().state;
    return Object.keys(s.nodes).find((k) => {
      // #385 — a curve is an Object (the pose) posing a CurveData (the points); the fused
      // 'Curve' node type is retired.
      const n = s.nodes[k];
      const d = n.inputs?.data?.node;
      return n.type === 'Object' && !!d && s.nodes[d]?.type === 'CurveData';
    })!;
  });
}

/** Offset + rotate + NON-UNIFORMLY scale the curve: the world matrix that makes the
 *  world→local round-trip a real question rather than an identity. */
async function poseCurve(page: import('@playwright/test').Page, id: string) {
  await page.evaluate((curveId) => {
    (window as unknown as BasherWin).__basher_dag.getState().dispatchAtomic(
      [
        { type: 'setParam', nodeId: curveId, paramPath: 'position', value: [1, 2, -3] },
        { type: 'setParam', nodeId: curveId, paramPath: 'rotation', value: [0, 35, 0] },
        { type: 'setParam', nodeId: curveId, paramPath: 'scale', value: [2, 1, 0.5] },
      ],
      'user',
      'pose the curve',
    );
  }, id);
  await page.waitForTimeout(300);
}

const readPoints = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((curveId) => {
    // #385 — points/closed live on the CurveData reached through the Object's `data` socket.
    // points are {id,co}[]; return the bare co's so the coordinate assertions stay meaningful.
    const s = (window as unknown as BasherWin).__basher_dag.getState().state;
    const dataId = s.nodes[curveId].inputs?.data?.node ?? curveId;
    const p = s.nodes[dataId].params as unknown as {
      points: { id: string; co: Vec3 }[];
      closed: boolean;
    };
    return { points: p.points.map((e) => e.co), closed: p.closed };
  }, id);

test('the handles sit ON the path the viewport draws — under a non-trivial world transform', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  const id = await addCurve(page);
  await poseCurve(page, id);

  const observed = await page.evaluate((curveId) => {
    const w = window as unknown as BasherWin;
    const handles = w.__basher_curve_handles();

    // The control-point dots the RENDERER mounted, in world space — read out of the live
    // three.js graph, not re-derived. (CurveLine draws a small sphere at each point inside
    // the curve's posed <group>.)
    const scene = w.__basher_three.getState().scene;
    const drawn: number[][] = [];
    scene?.traverse((o) => {
      let p: ThreeObjLike | null | undefined = o.parent;
      let inCurve = false;
      while (p) {
        if (p.name === curveId) {
          inCurve = true;
          break;
        }
        p = p.parent;
      }
      if (!inCurve || o.type !== 'Mesh') return;
      o.updateWorldMatrix(true, false);
      const m = o.matrixWorld.elements;
      drawn.push([m[12], m[13], m[14]]);
    });
    return { handles, drawn };
  }, id);

  expect(observed.handles.curveId).toBe(id);
  expect(observed.handles.world).toHaveLength(4);
  // A silent empty walk would leave this test green while proving nothing.
  expect(observed.drawn.length, 'the viewport must have mounted the point dots').toBeGreaterThan(0);

  // Every handle must coincide with a dot the renderer actually drew. If the handle math
  // and the renderer's <group> composition disagreed, the handles would float off the path.
  for (const h of observed.handles.world) {
    let nearest = Infinity;
    for (const d of observed.drawn) {
      nearest = Math.min(nearest, Math.hypot(d[0] - h[0], d[1] - h[1], d[2] - h[2]));
    }
    expect(nearest, `handle ${JSON.stringify(h)} is not on any drawn control point`).toBeLessThan(
      0.01,
    );
  }
});

test('picking a point swaps the OBJECT gizmo for the ELEMENT gizmo (never both)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  const id = await addCurve(page);

  // Count the mounted TransformControls in the live scene. The object gizmo is up (the
  // curve is selected on add).
  const gizmoCount = () =>
    page.evaluate(() => {
      const w = window as unknown as BasherWin;
      let n = 0;
      w.__basher_three.getState().scene?.traverse((o) => {
        if ((o.type ?? '').includes('TransformControls')) n++;
      });
      return n;
    });
  const before = await gizmoCount();
  expect(before).toBeGreaterThan(0);

  await page.evaluate((curveId) => {
    (window as unknown as BasherWin).__basher_curve_select_point(curveId, 1);
  }, id);
  await page.waitForTimeout(200);

  // Still exactly one gizmo — the POINT's. Two would fight over the pointer and the
  // director would have no way to know which one a drag moves.
  expect(await gizmoCount()).toBe(before);
  const sel = await page.evaluate(() => (window as unknown as BasherWin).__basher_curve_handles());
  expect(sel.selectedIndex).toBe(1);

  // Esc backs out ONE level: the point drops, the curve stays selected, the object gizmo
  // returns.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() =>
    (window as unknown as BasherWin).__basher_curve_handles(),
  );
  expect(after.selectedIndex).toBeNull();
  expect(after.curveId).toBe(id); // the curve is still selected — Esc dropped the POINT
  expect(await gizmoCount()).toBe(before);
});

test('dragging a point in WORLD space authors the right LOCAL point — and the seam follows', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  const id = await addCurve(page);
  await poseCurve(page, id);

  const before = await readPoints(page, id);
  const seamBefore = await page.evaluate(
    (curveId) => (window as unknown as BasherWin).__basher_curve_sample(curveId, 0.5),
    id,
  );

  // Pick point 1 — then, in a LATER frame (a pick and a drag are two gestures; the element
  // gizmo has to mount on the point before it can be dragged), drag it to a WORLD target 3
  // units above where its handle sits.
  await page.evaluate((curveId) => {
    (window as unknown as BasherWin).__basher_curve_select_point(curveId, 1);
  }, id);
  await page.waitForTimeout(250);

  const target = await page.evaluate(() => {
    const w = window as unknown as BasherWin;
    const h = w.__basher_curve_handles().world[1];
    const t: [number, number, number] = [h[0], h[1] + 3, h[2]];
    w.__basher_curve_point_grab(t);
    return t;
  });
  await page.waitForTimeout(300);

  const after = await readPoints(page, id);
  // The AUTHORED point is LOCAL and must NOT equal the world target — the whole point of
  // the round-trip. (Under this pose, writing the world value straight into the param would
  // fling the point metres away; that is the bug this asserts against.)
  expect(after.points[1]).not.toEqual(target);
  expect(after.points[0]).toEqual(before.points[0]); // only the dragged point moved
  expect(after.points[2]).toEqual(before.points[2]);

  // OBSERVATION, not inference: re-read where the handle now IS. Pushing the authored local
  // point back through the world matrix must land on the target the director dragged to.
  const landed = await page.evaluate(
    () => (window as unknown as BasherWin).__basher_curve_handles().world[1],
    id,
  );
  expect(
    Math.hypot(landed[0] - target[0], landed[1] - target[1], landed[2] - target[2]),
  ).toBeLessThan(0.02);

  // The SAMPLED path moved too — the thing Follow-Path will fly along, not just the picture.
  const seamAfter = await page.evaluate(
    (curveId) => (window as unknown as BasherWin).__basher_curve_sample(curveId, 0.5),
    id,
  );
  expect(seamAfter!.length).not.toBeCloseTo(seamBefore!.length, 3);

  // ONE drag = ONE undo entry.
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(200);
  const undone = await readPoints(page, id);
  expect(undone.points).toEqual(before.points);
});

test('E extrudes (and selects the new point), Delete removes it, C closes the loop', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  const id = await addCurve(page);
  await page.evaluate((curveId) => {
    (window as unknown as BasherWin).__basher_curve_select_point(curveId, 3); // the last point
  }, id);

  // E — extrude. With NO point selected E is still the rotate tool; the context override
  // only lives while a point is picked.
  await page.keyboard.press('e');
  await page.waitForTimeout(200);
  let pts = await readPoints(page, id);
  expect(pts.points).toHaveLength(5);
  let handles = await page.evaluate(() =>
    (window as unknown as BasherWin).__basher_curve_handles(),
  );
  expect(handles.selectedIndex).toBe(4); // the NEW point is selected — grab it and go
  expect(handles.world).toHaveLength(5);

  // Delete — removes the selected point and clears the selection.
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  pts = await readPoints(page, id);
  expect(pts.points).toHaveLength(4);
  handles = await page.evaluate(() => (window as unknown as BasherWin).__basher_curve_handles());
  expect(handles.selectedIndex).toBeNull();
  // The CURVE survived — Delete deleted a point, not the object the point belongs to.
  expect(handles.curveId).toBe(id);

  // C — close the loop (the same flag the inspector's checkbox writes).
  await page.evaluate((curveId) => {
    (window as unknown as BasherWin).__basher_curve_select_point(curveId, 0);
  }, id);
  await page.keyboard.press('c');
  await page.waitForTimeout(200);
  expect((await readPoints(page, id)).closed).toBe(true);
});

test('the two-point floor is REFUSED and announced — Delete never eats the curve', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  const id = await addCurve(page);
  // Down to the floor: 4 points → 2. #385 — the raw setParam must target the CurveData that
  // OWNS `points` (aimed at the Object it would be a silently-stripped wrong-half write).
  await page.evaluate((curveId) => {
    const w = window as unknown as BasherWin;
    const s = w.__basher_dag.getState().state;
    const dataId = s.nodes[curveId].inputs?.data?.node ?? curveId;
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: dataId,
          paramPath: 'points',
          value: [
            { id: 'cp0', co: [0, 0, 0] },
            { id: 'cp1', co: [2, 0, 0] },
          ],
        },
      ],
      'user',
      'shrink to the floor',
    );
    w.__basher_curve_select_point(curveId, 0);
  }, id);
  await page.waitForTimeout(200);

  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);

  const pts = await readPoints(page, id);
  expect(pts.points).toHaveLength(2); // refused — the path still has its span
  // And the CURVE NODE is still there: falling through to node-delete would destroy the
  // object because the director asked to remove one of its points.
  const stillThere = await page.evaluate((curveId) => {
    // #385 — the curve is the Object posing a CurveData; both must survive the refused delete.
    const s = (window as unknown as BasherWin).__basher_dag.getState().state;
    const n = s.nodes[curveId];
    const d = n?.inputs?.data?.node;
    return n?.type === 'Object' && !!d && s.nodes[d]?.type === 'CurveData';
  }, id);
  expect(stillThere).toBe(true);
  // The refusal ANNOUNCES itself — a key with no disabled state must never no-op silently.
  await expect(page.getByText(/at least 2 points/i)).toBeVisible();
});
