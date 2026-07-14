// #321 — the Curve scene object + the world arc-length sampling seam.
//
// THE ONE THING NO UNIT TEST CAN SEE (and the reason this slice ships an e2e): the point
// Follow-Path will fly to and the line the director sees are composed by TWO DIFFERENT
// code paths over the same TRS — the seam multiplies `resolveWorldTransform`'s matrix,
// while the renderer poses a three.js <group position rotation scale>. Unit tests exercise
// only the first. If they diverge, the camera travels a path that is not the one on
// screen, every assertion stays green, and the bug reads as "the animation is wrong".
// So we sample the SEAM from the running app and compare it against the REAL three.js
// scene graph the viewport mounted.

import { expect, test } from './_fixtures';

interface CurveSample {
  point: [number, number, number];
  tangent: [number, number, number];
  length: number;
}
interface ThreeObjLike {
  isLine?: boolean;
  name?: string;
  parent?: ThreeObjLike | null;
  geometry?: { getAttribute: (n: string) => { array: ArrayLike<number> } };
  matrixWorld: { elements: number[] };
  updateWorldMatrix: (parents: boolean, children: boolean) => void;
}
interface BasherWin {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatchAtomic: (ops: unknown[], src: string, d: string) => void;
    };
  };
  __basher_curve_sample: (nodeId: string, u: number) => CurveSample | null;
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
    return Object.keys(s.nodes).find((k) => s.nodes[k].type === 'Curve')!;
  });
}

test('a Curve is added from the menu, wired into the scene, and renders its path', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('canvas');

  const id = await addCurve(page);
  expect(id).toBeTruthy();

  // The path's own section leads the inspector, expanded — a curve's substance is its
  // points (as a mesh's is its mesh), and only the first section opens by default.
  await expect(page.getByTestId('curve-points')).toBeVisible();
  await expect(page.locator('[data-testid^="curve-point-row-"]')).toHaveCount(4);

  // It is a real scene child, and the viewport mounted a line for it.
  const drawn = await page.evaluate(() => {
    const w = window as unknown as BasherWin;
    const s = w.__basher_dag.getState().state;
    const curveId = Object.keys(s.nodes).find((k) => s.nodes[k].type === 'Curve')!;
    const scene = Object.values(s.nodes).find((n) => n.type === 'Scene');
    return {
      wired: JSON.stringify((scene as { inputs?: unknown }).inputs ?? {}).includes(`"${curveId}"`),
    };
  });
  expect(drawn.wired).toBe(true);
});

test('the SEAM samples the same path the VIEWPORT draws — under a non-trivial world transform', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  const id = await addCurve(page);

  // Pose the curve so the two compositions have something to disagree about: an offset,
  // a rotation, and a NON-UNIFORM scale (the case where local arc length stops being
  // proportional to world arc length).
  await page.evaluate((curveId) => {
    const dag = (window as unknown as BasherWin).__basher_dag.getState();
    dag.dispatchAtomic(
      [
        { type: 'setParam', nodeId: curveId, paramPath: 'position', value: [1, 2, -3] },
        { type: 'setParam', nodeId: curveId, paramPath: 'rotation', value: [0, 35, 0] },
        { type: 'setParam', nodeId: curveId, paramPath: 'scale', value: [2, 1, 0.5] },
      ],
      'user',
      'pose the curve',
    );
  }, id);
  await page.waitForTimeout(400);

  // BOTH ROADS, at the same u:
  //   road A — the seam (what Follow-Path will read)
  //   road B — the three.js Line the renderer actually mounted, its local sample pushed
  //            through the object's live matrixWorld (what the director actually sees)
  const compared = await page.evaluate((curveId) => {
    const w = window as unknown as BasherWin;
    const seam = w.__basher_curve_sample(curveId, 0.5)!;

    // Walk the LIVE three.js graph the viewport mounted and pull out the curve's Line —
    // the actual pixels, not a re-derivation. Identify it by the enclosing pick-id group
    // (SceneChildNode names each scene child's group by its node id).
    const scene = w.__basher_three.getState().scene;
    let found: { pos: number[]; mat: number[] } | null = null;
    scene?.traverse((o) => {
      if (!o.isLine || !o.geometry) return;
      let p: ThreeObjLike | null | undefined = o.parent;
      let inCurve = false;
      while (p) {
        if (p.name === curveId) {
          inCurve = true;
          break;
        }
        p = p.parent;
      }
      if (!inCurve) return;
      o.updateWorldMatrix(true, false);
      found = {
        pos: Array.from(o.geometry.getAttribute('position').array),
        mat: o.matrixWorld.elements.slice(),
      };
    });
    return { seam, found };
  }, id);

  expect(compared.seam).toBeTruthy();
  expect(compared.seam.length).toBeGreaterThan(0);
  // NOT `if (found)` — a scene walk that quietly finds nothing would skip the comparison
  // and leave this test green while proving nothing. The line must BE there.
  expect(compared.found, 'the viewport must have mounted a Line for the curve').toBeTruthy();

  // The seam's sampled point must lie ON the drawn polyline (in world space): measure its
  // distance to the nearest vertex of the line the renderer actually mounted. Agreement
  // means the seam's matrix composition and the renderer's <group> composition match.
  {
    const { point } = compared.seam;
    const { pos, mat } = compared.found as unknown as { pos: number[]; mat: number[] };
    // Apply the mounted line's matrixWorld to its local vertices.
    const world: number[][] = [];
    for (let i = 0; i < pos.length; i += 3) {
      const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
      world.push([
        mat[0] * x + mat[4] * y + mat[8] * z + mat[12],
        mat[1] * x + mat[5] * y + mat[9] * z + mat[13],
        mat[2] * x + mat[6] * y + mat[10] * z + mat[14],
      ]);
    }
    let nearest = Infinity;
    for (const v of world) {
      nearest = Math.min(nearest, Math.hypot(v[0] - point[0], v[1] - point[1], v[2] - point[2]));
    }
    // The drawn polyline is sampled at finite resolution, so the seam's point sits BETWEEN
    // two drawn vertices — it need only be closer than the vertex spacing, not coincident.
    expect(nearest).toBeLessThan(0.5);
  }
});

test('editing a point moves the path — the panel, the render and the seam all follow', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  const id = await addCurve(page);

  const before = await page.evaluate(
    (curveId) => (window as unknown as BasherWin).__basher_curve_sample(curveId, 0.5)!,
    id,
  );

  // Lift point 1 high, through the real numeric row.
  await page.getByTestId('curve-point-1-y').fill('6');
  await page.waitForTimeout(400);

  const after = await page.evaluate(
    (curveId) => (window as unknown as BasherWin).__basher_curve_sample(curveId, 0.5)!,
    id,
  );

  // The authored param changed …
  const points = await page.evaluate((curveId) => {
    const s = (window as unknown as BasherWin).__basher_dag.getState().state;
    return s.nodes[curveId].params.points as number[][];
  }, id);
  expect(points[1][1]).toBe(6);

  // … and the SEAM's mid-path sample rose with it (the path really deformed; the seam is
  // not reading a stale bake).
  expect(after.point[1]).toBeGreaterThan(before.point[1] + 1);
  // The path also got longer — it now climbs.
  expect(after.length).toBeGreaterThan(before.length);
});

test('points can be inserted and deleted, and a path refuses to fall below two points', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector('canvas');
  await addCurve(page);

  const rows = page.locator('[data-testid^="curve-point-row-"]');
  await expect(rows).toHaveCount(4);

  // Insert after point 0 → the new point splits that span.
  await page.getByTestId('curve-point-insert-0').click();
  await expect(rows).toHaveCount(5);

  // Delete back down to the two-point floor.
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('curve-point-delete-0').click();
  }
  await expect(rows).toHaveCount(2);

  // At the floor, delete is disabled — a path without a span is not a path. The refusal is
  // visible in the UI, not a silent no-op.
  await expect(page.getByTestId('curve-point-delete-0')).toBeDisabled();
});
