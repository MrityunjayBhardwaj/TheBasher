// #423 — a setParam aimed at the wrong half of a split object is ACCEPTED but
// changes nothing (the target's non-strict schema strips the unknown key). It
// used to be a silent success — the agent reported done, the DiffBar showed an
// accepted op, and nothing changed. It is now surfaced as a REPORTABLE no-op in
// the DiffBar (the same amber row the mutator warnings use), so the director
// sees the op-vs-subject mismatch BEFORE accepting.
//
// This drives the diff STORE directly (the same seam every agent e2e uses) to
// stage the exact proposal a wrong-half write produces, then OBSERVES the row.
// The control proves it is the mismatch — not merely "an op was proposed" — that
// lights it up: the same material write on the OWNING half shows no row.
//
// REF: #423; V38 (every fallible/degradable action surfaces its outcome — no
// silent no-op); src/app/badges.ts (the centralised badge registry the row reads).

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

// A split cube (Object owns the transform; BoxData owns size + material), plus a
// trailing setParam whose paramPath targets one half. When `wrongHalf` is true it
// writes `material` onto the Object (which does not own it) → stripped → the op is
// REPORTABLE. When false it writes to the owning BoxData → a clean accept.
async function propose(page: Page, wrongHalf: boolean): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as Partial<DiffWin>).__basher_diff));
  await page.evaluate((wrong) => {
    const w = window as unknown as DiffWin;
    w.__basher_diff.getState().reset();
    // Rebuild ops inside the browser (structured-clone-safe literals).
    const objectId = 'p423_obj';
    const dataId = 'p423_data';
    const ops = [
      { type: 'addNode', nodeId: dataId, nodeType: 'BoxData', params: { size: [1, 1, 1] } },
      { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: {} },
      {
        type: 'connect',
        from: { node: dataId, socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
      {
        type: 'setParam',
        nodeId: wrong ? objectId : dataId,
        paramPath: 'material.base.color',
        value: '#ff0000',
      },
    ];
    w.__basher_diff.getState().propose(w.__basher_dag.getState().state, ops, 'recolor');
  }, wrongHalf);
  await expect(page.getByTestId('diffbar')).toBeVisible();
}

test('#423 — a wrong-half write surfaces a REPORTABLE row in the DiffBar', async ({ page }) => {
  await page.goto('/');
  await propose(page, true);
  const row = page.getByTestId('diffbar-reportable');
  await expect(row).toBeVisible();
  await expect(row).toContainText('changed nothing');
  await expect(row).toContainText('material');
});

test('#423 control — the same write on the owning half shows NO reportable row', async ({
  page,
}) => {
  await page.goto('/');
  await propose(page, false);
  await expect(page.getByTestId('diffbar')).toBeVisible();
  await expect(page.getByTestId('diffbar-reportable')).toHaveCount(0);
});
