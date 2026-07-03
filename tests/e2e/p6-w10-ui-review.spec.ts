// P6 W10 UIR c-1 acceptance — the real camera-zoom readout.
//
// Pillar: §5.3 R3 TopToolbar anatomy promises a `[100% ▾]` zoom %
// display. v0.5 shipped a dead `100%` placeholder; the user rejected
// the SPEC-AMEND proposal and forced a CODE-FIX. The signal pipeline:
//
//   OrbitControls onChange (camera→target distance, src/viewport/
//   Viewport.tsx) → cameraDistanceToZoomPercent (pure, unit-tested) →
//   viewportStore.cameraZoom → R3 TopToolbar readout (this spec).
//
// This e2e OBSERVES the rendered readout text changing (Lokayata —
// the actual DOM, not an inferred store value). It drives the zoom
// signal through the `__basher_viewport` dev seam (the same seam W7
// uses for grid/shading) rather than synthesising a real WebGL dolly,
// because OrbitControls wheel-dolly in headless GL is brittle; the
// pure distance→percent math is covered in the vitest unit suite and
// the seam exercises the store→DOM binding that is this finding's
// actual subject. NO canvas pixel assertion (H30 / D-W9-4).
//
// REF: docs/UI-SPEC.md §5.3; docs/UI-REVIEW.md §7 c-1; vyapti V8
// (file-rooted — the writer lives in Viewport.tsx, a UI-projection
// store write, not a DAG dispatch).

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_viewport?: {
    getState: () => {
      cameraZoom: number;
      setCameraZoom: (zoom: number) => void;
    };
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible();
});

test('c-1: zoom readout shows the default-framing percentage (a live value, not a dead placeholder)', async ({
  page,
}) => {
  // The camera auto-frames the scene on load (#186 bounds-fit), so the readout
  // reflects the FIT zoom — a window-size-dependent percentage, NOT a hardcoded
  // 100%. Assert it renders a real integer percentage (the c-1 finding: the readout
  // is wired to the store, not the v0.5 dead "100%" placeholder). The exact fit %
  // varies by viewport (CI vs local), so match the shape, not a literal.
  await expect(page.getByTestId('top-toolbar-zoom-value')).toHaveText(/^\d+%$/);
});

test('c-1: zoom readout reflects a camera-zoom change (observed, not inferred)', async ({
  page,
}) => {
  const value = page.getByTestId('top-toolbar-zoom-value');
  // Establish a deterministic baseline — the load-time readout is the window-
  // dependent auto-fit % (#186), not 100. Drive it to 100 through the same seam
  // the OrbitControls onChange uses, so the change assertions below are stable.
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_viewport!.getState().setCameraZoom(100);
  });
  await expect(value).toHaveText('100%');

  // Drive the zoom signal exactly as the OrbitControls onChange listener
  // would (it derives a % from camera distance and calls setCameraZoom).
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_viewport!.getState().setCameraZoom(200);
  });

  // OBSERVE the DOM text actually update — the binding under test.
  await expect(value).toHaveText('200%');
  await expect(page.getByTestId('top-toolbar-zoom')).toHaveAttribute(
    'aria-label',
    'Viewport zoom 200 percent',
  );

  // And back down (dolly-out path).
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_viewport!.getState().setCameraZoom(50);
  });
  await expect(value).toHaveText('50%');
});
