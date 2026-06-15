// #178 (S6 / Part A) — a glTF with EDITED materials survives the `.basher`
// export → open round-trip, self-contained.
//
// THE PORTABILITY CLAIM (mirrors menu-scene-file.spec.ts's falsifier, V41/H77):
// the edit-layer carries three kinds of material datum that must ALL survive a
// cross-machine open —
//   - a SCALAR edit (base.color)         → lives in node params; DAG round-trip.
//   - a REPLACED map (a BakedTextureRef) → its bytes must EMBED in the bundle and
//                                          rehydrate to OPFS on open (the real
//                                          portability test, not a proxy).
//   - a CLEARED map (the empty-hash sentinel) → round-trips as plain data; it
//                                          references no OPFS file, so it must NOT
//                                          be embedded yet must still come back.
//
// The falsifier: after export we DELETE the replaced map's OPFS bytes, then open.
// A working bundle rehydrates the bytes (exists → true) and the clone repaints
// with the map (hasMap → true). A bundle that dropped the asset leaves exists
// false and the render mapless — red.
//
// Drives the DEV seams (no OS chooser): __basher_ingestGltfFolder /
// __basher_export_scene_bundle / __basher_import_scene_bundle / __basher_opfs.
// The bundle is JSON-round-tripped between export and import to mimic the real
// file write/read exactly.

import { test, expect } from './_fixtures';

interface Bundle {
  assets?: Record<string, string>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_export_scene_bundle: () => Promise<{ bundle: Bundle; missingAssets: string[] }>;
  __basher_import_scene_bundle: (bundle: Bundle) => Promise<string>;
  __basher_opfs: {
    read: (p: string) => Promise<Uint8Array>;
    exists: (p: string) => Promise<boolean>;
    delete: (p: string) => Promise<void>;
  };
  __basher_gltf_meshes?: () => { name: string; color: string | null; hasMap: boolean }[];
}

type Page = import('@playwright/test').Page;

// A minimal valid 1×1 PNG (red); attachMapFromFile decodes it in the browser.
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngBuffer = () => Buffer.from(RED_PNG_B64, 'base64');

interface ChildMat {
  id: string;
  baseColor: unknown;
  albedo: unknown;
  roughness: unknown;
}

async function ingestCube(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as W;
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'matround');
  });
}

/** The cube GltfChild's material datum (slot 0), re-found by childName so it
 *  survives the open (node ids are stable across bundleToProject). */
function cubeMat(page: Page): Promise<ChildMat | null> {
  return page.evaluate(() => {
    const w = window as unknown as W;
    const c = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && n.params.childName === 'cube',
    );
    if (!c) return null;
    const m = (c.params.materials as Record<string, Record<string, unknown>>[] | undefined)?.[0];
    const maps = (m?.maps ?? {}) as Record<string, unknown>;
    return {
      id: c.id,
      baseColor: (m?.base as Record<string, unknown> | undefined)?.color ?? null,
      albedo: maps.albedo ?? null,
      roughness: maps.roughness ?? null,
    };
  });
}

const cubeHasMap = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as W;
    const m = (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : []).find(
      (s) => s.name === 'cube',
    );
    return m ? m.hasMap : null;
  });

test.describe('#178 S6 — edited glTF materials round-trip through a .basher bundle', () => {
  test('scalar edit, replaced map (bytes), and cleared sentinel all survive export→open', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!(window as unknown as W).__basher_export_scene_bundle);
    await ingestCube(page);
    await expect.poll(async () => (await cubeMat(page))?.id ?? null).not.toBeNull();
    const child = (await cubeMat(page))!;

    // Open the editable material section.
    await page.evaluate((id) => {
      (window as unknown as W).__basher_selection.getState().select(id);
    }, child.id);
    await page.getByTestId('inspector-section-toggle-material').click();

    // (1) SCALAR — set base.color to a known hex.
    const hex = page.getByTestId(`inspector-gltfmat-colorhex-${child.id}-0-base-color`);
    await hex.fill('#1188ff');
    await hex.press('Enter');
    await expect.poll(async () => (await cubeMat(page))?.baseColor).toBe('#1188ff');

    // (2) REPLACE — pick a file for the albedo slot → bake → a real ref.
    await page
      .getByTestId(`inspector-gltfmap-file-${child.id}-0-albedo`)
      .setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: pngBuffer() });
    await expect
      .poll(async () => {
        const a = (await cubeMat(page))?.albedo as { hash?: string } | null | undefined;
        return a && typeof a.hash === 'string' && a.hash.length > 0 ? a.hash : null;
      })
      .not.toBeNull();
    await expect.poll(() => cubeHasMap(page)).toBe(true);

    // (3) CLEAR — write the empty-hash sentinel to the roughness slot.
    await page.getByTestId(`inspector-gltfmap-clear-${child.id}-0-roughness`).click();
    await expect
      .poll(async () => (await cubeMat(page))?.roughness as { hash?: string } | null)
      .toEqual(expect.objectContaining({ hash: '' }));

    const before = (await cubeMat(page))!;
    const albedoHash = (before.albedo as { hash: string }).hash;

    // Export → the bundle must EMBED the replaced map's bytes (base64, non-empty)
    // and must NOT embed the cleared sentinel (no file for an empty hash).
    const texKey = await page.evaluate(async () => {
      const w = window as unknown as W;
      const { bundle } = await w.__basher_export_scene_bundle();
      const keys = Object.keys(bundle.assets ?? {});
      const key = keys.find((k) => k.startsWith('baked-texture/'));
      return key && (bundle.assets as Record<string, string>)[key].length > 0 ? key : null;
    });
    expect(texKey).toBeTruthy();
    expect(texKey).toContain(albedoHash);

    // JSON round-trip the bundle (mimics the file write/read).
    const bundle = await page.evaluate(async () => {
      const w = window as unknown as W;
      const { bundle } = await w.__basher_export_scene_bundle();
      return JSON.parse(JSON.stringify(bundle)) as Bundle;
    });

    // DELETE the replaced map's OPFS bytes — confirm it's really gone.
    await page.evaluate((p) => (window as unknown as W).__basher_opfs.delete(p), texKey!);
    expect(
      await page.evaluate((p) => (window as unknown as W).__basher_opfs.exists(p), texKey!),
    ).toBe(false);

    // OPEN the bundle → a fresh project, hydrated from the embedded bytes.
    await page.evaluate((b) => (window as unknown as W).__basher_import_scene_bundle(b), bundle);

    // The replaced map's bytes are rehydrated back to OPFS (the portability claim).
    await expect
      .poll(
        async () => page.evaluate((p) => (window as unknown as W).__basher_opfs.exists(p), texKey!),
        { timeout: 10_000 },
      )
      .toBe(true);

    // All three material datums survive the open.
    await expect
      .poll(async () => (await cubeMat(page))?.baseColor, { timeout: 10_000 })
      .toBe('#1188ff');
    await expect
      .poll(async () => {
        const a = (await cubeMat(page))?.albedo as { hash?: string } | null | undefined;
        return a?.hash ?? null;
      })
      .toBe(albedoHash);
    await expect
      .poll(async () => (await cubeMat(page))?.roughness as { hash?: string } | null)
      .toEqual(expect.objectContaining({ hash: '' }));

    // And the rendered clone repaints with the rehydrated replacement map (the
    // overlay re-loads it from the rehydrated OPFS bytes). Wait for the async
    // overlay (loads can't run inline) — an 800ms wait showed stale-green in S5.
    await expect.poll(() => cubeHasMap(page), { timeout: 10_000 }).toBe(true);
  });
});
