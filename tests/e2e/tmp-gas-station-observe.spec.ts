// TEMP observation — import the real gas_station glTF (KHR_materials_pbrSpecular-
// Glossiness, 74 materials, 40 textures) and OBSERVE what actually renders.
// NOT a committed test — a Lokayata probe for the spec-gloss gap. Delete after.
import { test, expect } from './_fixtures';
import * as fs from 'fs';
import * as path from 'path';

const MODEL_DIR = '/Users/mrityunjaybhardwaj/Documents/CG/models/gas_station';

function collectFiles(root: string, rel = ''): { relativePath: string; b64: string }[] {
  const out: { relativePath: string; b64: string }[] = [];
  for (const name of fs.readdirSync(path.join(root, rel))) {
    if (name === '.DS_Store') continue;
    const r = rel ? `${rel}/${name}` : name;
    const full = path.join(root, r);
    if (fs.statSync(full).isDirectory()) out.push(...collectFiles(root, r));
    else out.push({ relativePath: r, b64: fs.readFileSync(full).toString('base64') });
  }
  return out;
}

test('OBSERVE gas_station import (spec-gloss)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().includes('gltf') || m.text().includes('glTF'))
      errors.push(`[${m.type()}] ${m.text()}`);
  });

  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean((window as any).__basher_ingestGltfFolder));

  const files = collectFiles(MODEL_DIR);
  console.log(`\n[GAS] sending ${files.length} files`);

  const result = await page.evaluate(async (files) => {
    const dec = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ingest = files.map((f) => ({ relativePath: f.relativePath, bytes: dec(f.b64) }));
    try {
      const entry = await (window as any).__basher_ingestGltfFolder(ingest, 'gas_station');
      return { ok: true, entry };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, files);
  console.log(`[GAS] ingest result: ${JSON.stringify(result)}`);

  // give the loader + render time
  await page.waitForTimeout(6000);

  const meshes = await page.evaluate(() => {
    const fn = (window as any).__basher_gltf_meshes;
    return fn ? fn() : null;
  });
  if (meshes) {
    console.log(`\n[GAS] live clone meshes: ${meshes.length}`);
    const withMap = meshes.filter((m: any) => m.hasMap).length;
    const colors = [...new Set(meshes.map((m: any) => m.color))];
    console.log(`[GAS] meshes WITH a base map: ${withMap}/${meshes.length}`);
    console.log(`[GAS] distinct material colors: ${JSON.stringify(colors.slice(0, 12))}`);
    console.log(`[GAS] first 6 meshes:`);
    for (const m of meshes.slice(0, 6))
      console.log(
        `   ${m.name} color=${m.color} map=${m.hasMap}/${m.mapImageOk} metal=${m.metalness} rough=${m.roughness}`,
      );
  } else {
    console.log('[GAS] no __basher_gltf_meshes (asset did not mount?)');
  }

  // captured IR: find the GltfAsset node + a sample child material
  const ir = await page.evaluate(() => {
    const nodes = (window as any).__basher_dag.getState().state.nodes as Record<string, any>;
    const asset = Object.values(nodes).find((n: any) => n.type === 'GltfChild' && n.params?.materials);
    const a: any = asset;
    return a
      ? { childType: a.type, matCount: (a.params.materials ?? []).length, sample: a.params.materials?.[0] }
      : null;
  });
  console.log(`\n[GAS] captured IR sample: ${JSON.stringify(ir)?.slice(0, 600)}`);

  // Probe the COMBINED-texture material (lambert43SG, material 34) — increment 2.
  const combined = await page.evaluate(() => {
    const nodes = (window as any).__basher_dag.getState().state.nodes as Record<string, any>;
    for (const n of Object.values(nodes) as any[]) {
      for (const m of n.params?.materials ?? []) {
        if (m?.name === 'lambert43SG')
          return { name: m.name, roughness: m.maps?.roughness, metalness: m.maps?.metalness };
      }
    }
    return null;
  });
  console.log(`[GAS] combined material IR: ${JSON.stringify(combined)}`);

  // Confirm the baked MR map RENDERS — find the live clone mesh whose material
  // carries a metalnessMap/roughnessMap (the combined-texture material).
  const withMrMap = await page.evaluate(() => {
    const fn = (window as any).__basher_gltf_meshes;
    const meshes = fn ? fn() : [];
    return meshes.filter((m: any) => m.hasMetalnessMap || m.hasRoughnessMap).length;
  });
  console.log(`[GAS] live clone meshes WITH an MR map: ${withMrMap}`);

  console.log(`\n[GAS] console errors/gltf logs (${errors.length}):`);
  for (const e of errors.slice(0, 15)) console.log('   ' + e);

  await page.screenshot({ path: '/tmp/gas-station-import.png', fullPage: false });
  console.log('\n[GAS] screenshot → /tmp/gas-station-import.png');
});
