// openInspectorSection — idempotently expand an inspector section, whatever its default.
//
// #365 Phase 5a (Slice 2): retiring the fused `BoxMesh` value kind made the seed cube a
// split `Object` (pose) → `BoxData` (geometry + material). The Object declares
// inspectorSections `['transform','constraint','driver']`; `isDefaultCollapsed(sections,id) =
// sections[0] !== id` (src/app/inspectorSections.ts) makes the FIRST section default-EXPANDED.
// So `transform` now starts OPEN on an Object, where on the old fused `BoxMesh`
// (`['mesh','transform','material']`) it started collapsed. Every spec that blind-clicked
// `inspector-section-toggle-transform` to OPEN transform now COLLAPSES it, hiding
// `inspector-vec-*` / `inspector-diamond-*` and timing out (see .anvi H176).
//
// The fix is a METHOD, not a per-spec patch: only click the toggle when the section body is
// not already shown, then assert it is shown. Idempotent whatever the section's default —
// this mirrors `acceptance.spec.ts`'s `ensureCameraTransformExpanded`, which already needed
// exactly this guard for the camera-reload case.
//
// SECOND INSTANCE, #389 — and it is the same shape one section over, which is why this
// helper is the answer rather than a fix per spec. Splitting the imported glTF child moved
// its material onto the DATA half, so the rows now arrive through the Object's linked-data
// block, which renders EXPANDED. Ten specs that blind-clicked
// `inspector-section-toggle-material` to open it were closing it instead, then timing out
// on controls that were on screen a moment earlier. The tell is identical both times: a
// locator that "is not found" for an element the page demonstrably renders.
//
// The generalisation worth carrying: a split changes which node OWNS a section, and
// therefore that section's default expanded state, without touching the section or the
// spec. Any blind toggle click is a latent failure waiting for the next split.

import { expect, type Page } from '@playwright/test';

/**
 * Expand an inspector section if it is collapsed, then assert its body is visible.
 * Safe to call whether the section starts collapsed or expanded.
 *
 * @param page       The Playwright page.
 * @param sectionId  The section id, e.g. `'transform'`, `'material'`, `'mesh'`.
 */
export async function openInspectorSection(page: Page, sectionId: string): Promise<void> {
  const toggle = page.getByTestId(`inspector-section-toggle-${sectionId}`);
  await expect(toggle).toBeVisible();
  const body = page.getByTestId(`inspector-section-body-${sectionId}`);
  // The body element renders only when the section is expanded (NPanel SectionCard),
  // so its visibility is a reliable collapsed/expanded signal.
  if (!(await body.isVisible().catch(() => false))) {
    await toggle.click();
  }
  await expect(body).toBeVisible();
}
