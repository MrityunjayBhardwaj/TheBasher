// #1305 — the unsaved-changes dot shows as soon as there are unsaved changes, whether or not the
// list of every project has been read yet.
//
// The dot lives in the open project's tab. The tab strip used to draw its tabs only from the list of
// every project in storage, so while that read was still queued (CI's slow storage, behind boot's
// example writes) there were no tabs, no dot, and "no dot" passed for "saved". CI's acceptance #4
// trace (#1295): the check passed, the next snapshot showed the dot still on, and the reload cut
// the save off.
//
// Here the listing is HELD, not merely slow: boot's own read of the projects directory goes
// through (it decides what to resume), and every later one never finishes. So whether the tab
// shows is decided by where the tab strip gets it from, not by how fast this machine is.
import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const proto = FileSystemDirectoryHandle.prototype as unknown as {
      entries(this: FileSystemDirectoryHandle): AsyncIterableIterator<[string, unknown]>;
    };
    const entries = proto.entries;
    let listings = 0;
    proto.entries = function (this: FileSystemDirectoryHandle) {
      if (this.name === 'projects' && ++listings > 1) {
        const never = new Promise<IteratorResult<[string, unknown]>>(() => {});
        return {
          next: () => never,
          [Symbol.asyncIterator]() {
            return this;
          },
        } as AsyncIterableIterator<[string, unknown]>;
      }
      return entries.call(this);
    };
  });
});

test('the dirty dot appears on an edit while the project list is still unread', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_selection?: unknown }).__basher_selection),
  );
  await page.evaluate(() => {
    type Win = { __basher_selection?: { getState: () => { select: (id: string) => void } } };
    (window as unknown as Win).__basher_selection!.getState().select('n_camera');
  });
  await openInspectorSection(page, 'transform');
  const x = page.getByTestId('inspector-vec-n_camera-position-x');
  await x.fill('7.5');
  await x.press('Tab');
  await expect(page.getByTestId('project-tab-default')).toBeVisible();
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(1);
});
