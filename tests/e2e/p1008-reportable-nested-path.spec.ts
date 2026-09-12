// #1008 — the same surfacing as #423, one level down. A setParam whose path is
// wrong in its FIRST segment was already surfaced as an amber row; the same
// mistake one segment deeper returned success, changed nothing the schema
// recognises, and showed the director a clean accept.
//
// `overridden` IS a param of Object. `overridden.bogus` is not — so the root
// survives the re-parse, which is exactly why the root-key check said nothing.
//
// The control is the discriminating one: it writes the REAL nested path
// (`overridden.position`) through the same three ops, so a row appearing there
// would mean the badge fires on nesting rather than on the mismatch.
//
// REF: #1008, #423; V38 (no silent no-op); src/core/dag/ops.ts (the strip check).

import { expect, test, type Page } from './_fixtures';

interface DiffWin {
  __basher_dag: { getState(): { state: unknown } };
  __basher_diff: {
    getState(): {
      propose: (state: unknown, ops: unknown[], description: string) => unknown;
      reset: () => void;
    };
  };
}

async function propose(page: Page, badLeaf: boolean): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as Partial<DiffWin>).__basher_diff));
  await page.evaluate((bad) => {
    const w = window as unknown as DiffWin;
    w.__basher_diff.getState().reset();
    const objectId = 'p1008_obj';
    const ops = [
      { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: {} },
      {
        type: 'setParam',
        nodeId: objectId,
        // Both paths share the same real root; only the leaf differs.
        paramPath: bad ? 'overridden.bogus' : 'overridden.position',
        value: true,
      },
    ];
    w.__basher_diff.getState().propose(w.__basher_dag.getState().state, ops, 'pin the transform');
  }, badLeaf);
  await expect(page.getByTestId('diffbar')).toBeVisible();
}

test('#1008 — a bad leaf under a real root surfaces a REPORTABLE row', async ({ page }) => {
  await page.goto('/');
  await propose(page, true);
  const row = page.getByTestId('diffbar-reportable');
  await expect(row).toBeVisible();
  await expect(row).toContainText('changed nothing');
  // The row names the path ONCE. It used to read "Ignored overridden.bogus on
  // p1008_obj — 'overridden.bogus' is not a parameter of Object" — a duplication
  // no unit assertion could see, because a contains-check is as happy with two
  // mentions as with one.
  await expect(row).toContainText('overridden.bogus');
  const text = (await row.textContent()) ?? '';
  expect(text.split('overridden.bogus').length - 1).toBe(1);
});

test('#1008 control — the real nested path shows NO reportable row', async ({ page }) => {
  await page.goto('/');
  await propose(page, false);
  await expect(page.getByTestId('diffbar')).toBeVisible();
  await expect(page.getByTestId('diffbar-reportable')).toHaveCount(0);
});
