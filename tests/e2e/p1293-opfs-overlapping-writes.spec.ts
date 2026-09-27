// #1293 — two saves of one file at the same moment both succeed, and the file holds one of them
// whole.
//
// Before the fix, OpfsStorage let a second write to a path land between the first write's
// `close()` and its read-back, and the read-back threw (`NotReadableError` / `NotFoundError`):
// 17 of 40 overlapping writes failed in Chromium. It reached a director as the idle autosave
// colliding with the save that opening a `.basher` file makes first. This drives the app's own
// storage through its dev seam, so it tests the class the product uses, not a copy of its steps.

import { expect, test } from './_fixtures';

test('overlapping writes to one path all succeed and leave one of them whole', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>).__basher_writeOpfsBytes),
  );

  const out = await page.evaluate(async () => {
    const w = window as unknown as {
      __basher_writeOpfsBytes: (path: string, bytes: Uint8Array) => Promise<void>;
    };
    const path = 'race-1293/project.json';
    const payload = (fill: number) => new Uint8Array(3_000_000).fill(fill);
    const errors: string[] = [];
    let ok = 0;
    for (let round = 0; round < 10; round++) {
      const settled = await Promise.allSettled([
        w.__basher_writeOpfsBytes(path, payload(1)),
        w.__basher_writeOpfsBytes(path, payload(2)),
        w.__basher_writeOpfsBytes(path, payload(3)),
      ]);
      for (const s of settled) {
        if (s.status === 'fulfilled') ok++;
        else errors.push((s.reason as Error)?.name ?? String(s.reason));
      }
    }
    // Last write wins, whole: the queue runs them in call order.
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('basher')).getDirectoryHandle('race-1293');
    const bytes = new Uint8Array(
      await (await (await dir.getFileHandle('project.json')).getFile()).arrayBuffer(),
    );
    return { ok, errors, length: bytes.length, first: bytes[0], last: bytes[bytes.length - 1] };
  });

  console.log(`[1293] ${JSON.stringify(out)}`);
  expect(out.errors, 'no overlapping write failed').toEqual([]);
  expect(out.ok).toBe(30);
  expect(out).toMatchObject({ length: 3_000_000, first: 3, last: 3 });
});
