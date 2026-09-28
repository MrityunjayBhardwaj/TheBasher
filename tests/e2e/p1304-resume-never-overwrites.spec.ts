// #1304 — a project that is THERE but cannot be read is never replaced on resume.
//
// Boot resumes the last project. It used to answer ANY failure to load it with "missing": for the
// default project it built a fresh scene and saved it over the file. A locked, slow or corrupt
// file is not a missing one, and that save destroyed the director's work.
//
// Here the saved project's file handle refuses one read on the reload, with an error that is not
// "not found". The project must be left exactly as saved, the failure must be shown, and the
// app must not open a blank scene in its place.
import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

test('a saved project that fails to read on resume is shown as an error and left untouched', async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Armed by the test through sessionStorage, which survives the reload; used once.
    if (sessionStorage.getItem('fail-default-read') !== '1') return;
    sessionStorage.removeItem('fail-default-read');
    const proto = FileSystemDirectoryHandle.prototype;
    const getFileHandle = proto.getFileHandle;
    let armed = true;
    proto.getFileHandle = function (
      this: FileSystemDirectoryHandle,
      name: string,
      options?: FileSystemGetFileOptions,
    ) {
      if (armed && this.name === 'default' && name === 'project.json' && !options?.create) {
        armed = false;
        return Promise.reject(new DOMException('the file is locked', 'NoModificationAllowedError'));
      }
      return getFileHandle.call(this, name, options);
    };
  });

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
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+s');
  // A save on a fresh profile waits behind boot's background example writes (#1303), which can
  // pass 5 s on a loaded machine; this spec is about what the NEXT boot does, not save speed.
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0, { timeout: 15_000 });

  await page.evaluate(() => sessionStorage.setItem('fail-default-read', '1'));
  await page.reload();

  // Boot has settled when either screen is up. What it did to the file is read FIRST: that is the
  // harm this guards against, so it is the assertion an unguarded boot must fail.
  await expect(page.getByTestId('home-view').or(page.getByTestId('layout'))).toBeVisible();
  const savedX = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await (
      await (await root.getDirectoryHandle('basher')).getDirectoryHandle('projects')
    ).getDirectoryHandle('default');
    const text = await (await (await dir.getFileHandle('project.json')).getFile()).text();
    const project = JSON.parse(text) as {
      state: { nodes: Record<string, { params: { position?: number[] } }> };
    };
    return project.state.nodes.n_camera.params.position?.[0];
  });
  expect(savedX, 'the saved file is untouched').toBe(7.5);

  // Said out loud, and no editor over a blank scene: the app went Home.
  await expect(page.getByTestId('toast-error')).toContainText('Couldn\'t open "default"');
  await expect(page.getByTestId('toast-error')).toContainText('left untouched');
  await expect(page.getByTestId('home-view')).toBeVisible();
  await expect(page.getByTestId('layout')).toHaveCount(0);
});
