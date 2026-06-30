// #244 — Cmd/Ctrl+Z must work even while a form field is focused. Previously the
// undo/redo handlers sat BELOW the `isTypingTarget` early-return guard, so any
// focused input/select/textarea made Ctrl+Z a dead no-op (unlike Cmd+S, hoisted
// above the guard). The fix hoists undo/redo above the guard, carving out ONLY
// textarea + contenteditable (where the browser's char-level text-undo should win).
//
// Drives the LIVE app (Lokayata): inject a real <input>/<textarea>, focus it, fire
// the shortcut through the window listener, and read the DAG via __basher_dag.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

interface DagWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params?: Record<string, unknown> }> };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
}

const boxX = (page: Page) =>
  page.evaluate(() => {
    const n = (window as unknown as DagWindow).__basher_dag.getState().state.nodes['n_box'];
    const pos = (n?.params as { position?: number[] } | undefined)?.position;
    return pos ? pos[0] : null;
  });

async function dispatchBoxX(page: Page, x: number) {
  await page.evaluate((x) => {
    (window as unknown as DagWindow).__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [x, 0, 0] }],
        'e2e',
        'move box',
      );
  }, x);
}

/** Inject a focusable element of the given tag, focus it, and return nothing —
 *  the element stays focused so the next keypress targets it. */
async function injectAndFocus(page: Page, tag: 'input' | 'textarea') {
  await page.evaluate((tag) => {
    document.getElementById('e2e-focus-probe')?.remove();
    const el = document.createElement(tag);
    el.id = 'e2e-focus-probe';
    document.body.appendChild(el);
    (el as HTMLElement).focus();
  }, tag);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as DagWindow).__basher_dag), {
    timeout: 15000,
  });
});

test('Ctrl/Cmd+Z undoes a DAG change while a single-line INPUT is focused', async ({ page }) => {
  const orig = await boxX(page);
  expect(orig).not.toBeNull();
  await dispatchBoxX(page, (orig as number) + 5);
  expect(await boxX(page)).toBeCloseTo((orig as number) + 5, 3);

  await injectAndFocus(page, 'input');
  await page.keyboard.press('ControlOrMeta+z');
  // The fix: undo fires despite the focused input → box reverts to its original X.
  await expect.poll(() => boxX(page)).toBeCloseTo(orig as number, 3);
});

test('Ctrl/Cmd+Z does NOT undo the DAG while a TEXTAREA is focused (native text-undo wins)', async ({
  page,
}) => {
  const orig = await boxX(page);
  expect(orig).not.toBeNull();
  const moved = (orig as number) + 5;
  await dispatchBoxX(page, moved);
  expect(await boxX(page)).toBeCloseTo(moved, 3);

  await injectAndFocus(page, 'textarea');
  await page.keyboard.press('ControlOrMeta+z');
  // Carve-out: our handler bails so the browser does text-undo on the textarea;
  // the DAG change is untouched. Give the handler a tick, then assert unchanged.
  await page.waitForTimeout(150);
  expect(await boxX(page)).toBeCloseTo(moved, 3);
});
