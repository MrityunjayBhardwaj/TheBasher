// p1755 (#1755) — zooming does not ray-test the scene. R3F intersects every pickable mesh for each
// DOM event it listens to, and nothing in the 3D tree handles a wheel or a pointer-up, so on a big
// scene each wheel notch spent ~45 ms on ray tests whose result nobody read. Count the mesh ray
// tests per DOM event (every own `raycast` on a mesh prototype in the scene is wrapped), wheel at
// the viewport centre, then click the cube: wheel and pointer-up test nothing, and the click still
// selects what it lands on.
//
// Falsifiable: put `onWheel` / `onPointerUp` back in `viewportEvents` → the wheel and pointer-up
// counts are non-zero and the first two assertions fail.
import { expect, test } from './_fixtures';

interface W {
  __basher_selection: { getState: () => { primaryNodeId: string | null; clear: () => void } };
  __basher_three: { getState: () => { scene: { traverse: (f: (o: unknown) => void) => void } } };
  __rc: Record<string, number>;
}

test('a wheel notch and a pointer-up ray-test nothing; a click still selects', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_selection && w.__basher_three);
  });
  await page.waitForTimeout(400);
  const meshes = await page.evaluate(() => {
    const w = window as unknown as W;
    const rc: Record<string, number> = (w.__rc = {});
    let current = 'none';
    const canvas = document.querySelector('canvas')!;
    for (const t of ['pointerdown', 'pointerup', 'click', 'wheel', 'pointermove'])
      canvas.addEventListener(t, () => void (current = t), { capture: true });
    const wrapped = new Set<object>();
    let count = 0;
    w.__basher_three.getState().scene.traverse((o) => {
      const obj = o as { isMesh?: boolean };
      if (!obj.isMesh) return;
      count++;
      for (
        let p = Object.getPrototypeOf(obj);
        p && p !== Object.prototype;
        p = Object.getPrototypeOf(p)
      ) {
        if (!Object.prototype.hasOwnProperty.call(p, 'raycast') || wrapped.has(p)) continue;
        wrapped.add(p);
        const proto = p as { raycast: (...a: unknown[]) => void };
        const orig = proto.raycast;
        proto.raycast = function (this: unknown, ...a: unknown[]) {
          rc[current] = (rc[current] ?? 0) + 1;
          return orig.apply(this, a);
        };
      }
    });
    return count;
  });
  expect(meshes).toBeGreaterThan(0);

  const canvas = page.getByTestId('viewport-canvas');
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(() => (window as unknown as W).__basher_selection.getState().clear());
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);
  }
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(100);
  }
  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(200);
  const rc = await page.evaluate(() => (window as unknown as W).__rc);
  console.log(`p1755 meshes ${meshes} ray tests by event ${JSON.stringify(rc)}`);

  expect(rc.wheel ?? 0, 'a wheel notch ray-tests nothing').toBe(0);
  expect(rc.pointerup ?? 0, 'a pointer-up ray-tests nothing').toBe(0);
  // CONTROL: the counter sees the events R3F does handle, and the click still picks the cube.
  expect(rc.pointerdown ?? 0).toBeGreaterThan(0);
  expect(rc.click ?? 0).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => (window as unknown as W).__basher_selection.getState().primaryNodeId),
  ).toBe('n_box');
});
