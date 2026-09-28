// Drag one outliner row onto another, aimed at a ZONE of the target row (#1152).
//
// HTML5 DnD is driven by dispatching dragstart → dragover → drop with ONE shared DataTransfer, so
// the dragstart's setData survives to the drop handler (#227). Since #1152 a drop's meaning depends
// on WHERE on the row it lands — the middle parents into the row, the top/bottom edge reorders
// before/after it (`src/app/treeDropIntent.ts`) — so the pointer position is part of the gesture
// and is sent with both events. A synthetic event with no position lands at clientY 0, above every
// row, which reads as the top edge: that is why this helper exists rather than five copies of the
// old one.

import type { JSHandle, Page } from '@playwright/test';

export type TreeDropZone = 'before' | 'into' | 'after';

/** Where in the row's height each zone is aimed — well inside it, clear of the boundaries. */
const ZONE_FRACTION: Record<TreeDropZone, number> = { before: 0.1, into: 0.5, after: 0.9 };

export async function dragRowOnto(
  page: Page,
  srcId: string,
  dstId: string,
  zone: TreeDropZone = 'into',
): Promise<void> {
  const dt: JSHandle = await page.evaluateHandle(() => new DataTransfer());
  const src = page.locator(`[data-testid="scene-tree-row-${srcId}"]`);
  const dst = page.locator(`[data-testid="scene-tree-row-${dstId}"]`);
  const box = await dst.boundingBox();
  if (!box) throw new Error(`outliner row ${dstId} is not on screen`);
  const at = {
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height * ZONE_FRACTION[zone],
  };
  await src.dispatchEvent('dragstart', { dataTransfer: dt });
  await dst.dispatchEvent('dragover', { dataTransfer: dt, ...at });
  await dst.dispatchEvent('drop', { dataTransfer: dt, ...at });
}
