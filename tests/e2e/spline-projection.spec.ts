// Spline Wave D leftover — the bottom-right ortho|persp projection toggle.
//
// The editor view can render with a perspective OR orthographic camera (Spline's
// "Orthographic | Perspective" pill by the nav gizmo; Blender's Numpad 5). This
// is an EDITOR-VIEW projection on viewportStore — EditorViewCamera swaps the ONE
// always-default editor camera, never mutating a DAG camera ([[H67]]).
//
// Lokayata: each test reads the REAL R3F view camera via __basher_view_camera and
// asserts `.isOrthographic`. Each is falsifiable — reverting the feature (camera
// ignores the store) leaves it perspective and the assertion fails (noted inline).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_view_camera?: () => {
    position: [number, number, number];
    fov: number | null;
    zoom: number;
    isOrthographic: boolean;
    lookThrough: boolean;
    projection: 'perspective' | 'orthographic';
  } | null;
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_view_camera),
  );
  // Let the first frame paint so the camera ref + matrices are live.
  await page.waitForTimeout(300);
}

function readCam(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as unknown as BasherWindow).__basher_view_camera!());
}

test.describe('Spline ortho|persp projection toggle', () => {
  test('boots perspective; pill flips the editor camera to orthographic and back', async ({
    page,
  }) => {
    await waitReady(page);

    // Default boot is perspective.
    const boot = await readCam(page);
    expect(boot!.isOrthographic).toBe(false);
    expect(boot!.projection).toBe('perspective');

    // Click the Ortho segment → the live editor camera becomes orthographic.
    // Revert (EditorViewCamera ignores cameraProjection) → stays a
    // PerspectiveCamera → isOrthographic never flips → this fails.
    await page.getByTestId('projection-toggle-orthographic').click();
    await page.waitForTimeout(250);
    const ortho = await readCam(page);
    expect(ortho!.isOrthographic).toBe(true);
    expect(ortho!.projection).toBe('orthographic');
    // The Ortho segment is now the active radio.
    await expect(page.getByTestId('projection-toggle-orthographic')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Click Persp → back to a perspective camera.
    await page.getByTestId('projection-toggle-perspective').click();
    await page.waitForTimeout(250);
    const back = await readCam(page);
    expect(back!.isOrthographic).toBe(false);
    expect(back!.fov).not.toBeNull();
  });

  test('M toggles projection perspective ↔ orthographic', async ({ page }) => {
    await waitReady(page);
    expect((await readCam(page))!.isOrthographic).toBe(false);

    // Press M → orthographic. Revert the KeyboardShortcuts M case → no flip → fails.
    await page.keyboard.press('m');
    await page.waitForTimeout(250);
    expect((await readCam(page))!.isOrthographic).toBe(true);

    // Press M again → back to perspective.
    await page.keyboard.press('m');
    await page.waitForTimeout(250);
    expect((await readCam(page))!.isOrthographic).toBe(false);
  });

  test('switching projection preserves the orbit position (Blender Numpad 5)', async ({ page }) => {
    await waitReady(page);

    // Orbit away from the boot pose so the position is non-trivial, and the
    // gesture-end persists it (saveEditorView on mouseup).
    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 200, cy + 50, { steps: 16 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const before = await readCam(page);
    expect(before!.isOrthographic).toBe(false);

    // Toggle to ortho — the swapped-in camera adopts the SAME position, not the
    // default boot pose. Revert the (project, projection) re-frame latch → the
    // fresh ortho camera sits at the origin → position diverges → this fails.
    await page.keyboard.press('m');
    await page.waitForTimeout(250);
    const after = await readCam(page);
    expect(after!.isOrthographic).toBe(true);
    expect(after!.position[0]).toBeCloseTo(before!.position[0], 1);
    expect(after!.position[1]).toBeCloseTo(before!.position[1], 1);
    expect(after!.position[2]).toBeCloseTo(before!.position[2], 1);
    // An ortho camera must have a sensible non-default zoom (it was framed).
    expect(after!.zoom).toBeGreaterThan(1);
  });
});
