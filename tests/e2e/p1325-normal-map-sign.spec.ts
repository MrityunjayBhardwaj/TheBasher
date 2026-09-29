// #1325 — a normal map bends the surface toward image-up on every road that draws it, as three's own
// loader and the glTF spec do.
//
// The fixture is a +Z quad whose normal map is one solid texel tilting 45° toward image-up, which on
// this quad's UVs is world +Y. Each drawn mesh is rendered ALONE by the app's own renderer, with one
// directional light from the front, raised above the quad and then lowered below it, and the centre
// pixel is read. Leaning toward +Y reads brighter from above. The reference is three's GLTFLoader
// parsing the same bytes in the same page. The control is the same mesh with its normal map removed,
// which must read the same from both sides; without it a lean could be the light, not the map.
//
// Before the fix the native quad read 0 from above and 402 from below, the loader's quad 402 and 0,
// and the flat control 285 and 285 on both. Neither draw builder set `normalScale`, and three derives
// the tangent frame of a tangent-less mesh from UV derivatives, which on an unflipped (glTF) texture
// points image-down.
//
// Two builders draw a normal map, and each gets a case: the registry's (a native import) and the
// baked mesh's (a clone-road import after Apply, which is also what every saved `BakedData` carrying
// a glTF normal map draws through).
//
// REF: src/app/material/uvPlacement.ts (`normalScaleFor`); src/app/materialRegistry.ts (`build`);
//      src/viewport/SceneFromDAG.tsx (`CapturedBakedMeshR`); three `GLTFLoader.js:3402,3468`; issue #1325.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import type * as ThreeNs from 'three';
import type { GLTF, GLTFLoader as GLTFLoaderClass } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ingestOnCloneRoad } from './_cloneRoadImport';

const FIXTURE = 'normal-map-quad.gltf';

interface Lean {
  readonly withMap: { readonly above: number; readonly below: number };
  readonly control: { readonly above: number; readonly below: number };
}

/** A mesh as the page draws it: its material may carry a normal map. */
type DrawnMesh = ThreeNs.Mesh<ThreeNs.BufferGeometry, ThreeNs.MeshStandardMaterial>;

interface ThreeWindow {
  __basher_three: {
    getState: () => { scene: ThreeNs.Scene | null; gl: ThreeNs.WebGLRenderer | null };
  };
  __basher_importGltfNative: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; inputs: Record<string, unknown> }>;
      };
    };
  };
}

interface Reading {
  readonly drawn: Lean | null;
  readonly drawnCount: number;
  readonly reference: Lean;
}

async function boot(page: Page, errors: string[]): Promise<void> {
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as Record<string, unknown>;
      return typeof w.__basher_importGltfNative === 'function' && w.__basher_three != null;
    },
    null,
    { timeout: 30_000 },
  );
}

/** Wait until the scene draws exactly one visible normal-mapped mesh, then read it and the reference. */
async function read(page: Page): Promise<Reading> {
  await page.waitForFunction(
    () => {
      // The scene ref is null until the canvas has mounted.
      const scene = (window as unknown as ThreeWindow).__basher_three.getState().scene;
      if (!scene) return false;
      let n = 0;
      scene.traverseVisible((o) => {
        const mesh = o as DrawnMesh;
        if (mesh.isMesh && mesh.material?.normalMap?.image) n += 1;
      });
      return n === 1;
    },
    null,
    { timeout: 20_000 },
  );
  return page.evaluate(async (file) => {
    const w = window as unknown as ThreeWindow;
    // The module instance the app itself runs, so the reference loader builds the same classes.
    const threeUrl = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /\.vite\/deps\/three\.js/.test(n));
    const THREE = (await import(/* @vite-ignore */ threeUrl!)) as typeof ThreeNs;
    // A URL the dev server serves, not a module this file resolves — hence a variable.
    const loaderUrl = '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
    const { GLTFLoader } = (await import(/* @vite-ignore */ loaderUrl)) as {
      GLTFLoader: typeof GLTFLoaderClass;
    };
    const { gl, scene } = w.__basher_three.getState();
    const drawnMeshes: DrawnMesh[] = [];
    // Drawn means visible up the whole chain: Apply leaves the clone mounted and hidden.
    scene!.traverseVisible((o) => {
      const mesh = o as DrawnMesh;
      if (mesh.isMesh && mesh.material?.normalMap?.image) drawnMeshes.push(mesh);
    });
    const bytes = await fetch(`/assets/${file}`).then((r) => r.arrayBuffer());
    const gltf = await new Promise<GLTF>((res, rej) => new GLTFLoader().parse(bytes, '', res, rej));
    let reference: DrawnMesh | null = null;
    gltf.scene.traverse((o) => {
      if ((o as DrawnMesh).isMesh && !reference) reference = o as DrawnMesh;
    });

    const centre = (mesh: DrawnMesh, lightY: number, withMap: boolean): number => {
      const S = new THREE.Scene();
      const material = mesh.material.clone();
      if (!withMap) material.normalMap = null;
      S.add(new THREE.Mesh(mesh.geometry, material));
      const light = new THREE.DirectionalLight(0xffffff, 2);
      light.position.set(0, lightY, 1);
      S.add(light);
      const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      cam.position.set(0, 0, 3);
      cam.lookAt(0, 0, 0);
      const rt = new THREE.WebGLRenderTarget(64, 64);
      const r = gl!;
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 1);
      r.clear();
      r.render(S, cam);
      const px = new Uint8Array(4);
      r.readRenderTargetPixels(rt, 32, 32, 1, 1, px);
      r.setRenderTarget(prev);
      rt.dispose();
      material.dispose();
      return px[0] + px[1] + px[2];
    };
    const lean = (mesh: DrawnMesh) => ({
      withMap: { above: centre(mesh, 1, true), below: centre(mesh, -1, true) },
      control: { above: centre(mesh, 1, false), below: centre(mesh, -1, false) },
    });
    return {
      drawn: drawnMeshes.length === 1 ? lean(drawnMeshes[0]) : null,
      drawnCount: drawnMeshes.length,
      reference: lean(reference!),
    };
  }, FIXTURE);
}

function expectSameLeanAsReference(r: Reading): void {
  expect(r.drawnCount, 'exactly one normal-mapped mesh is drawn').toBe(1);
  const drawn = r.drawn!;
  // The instrument can tell a lean from none: the control reads the same from both sides.
  expect(drawn.control.above).toBe(drawn.control.below);
  expect(r.reference.control.above).toBe(r.reference.control.below);
  // The reference leans toward +Y, as the file says…
  expect(r.reference.withMap.above).toBeGreaterThan(r.reference.withMap.below);
  // …and so does the mesh the app draws.
  expect(drawn.withMap.above, JSON.stringify(r)).toBeGreaterThan(drawn.withMap.below);
}

test('#1325 — a native import’s normal map leans the way the file says', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  await page.evaluate(async (file) => {
    const w = window as unknown as ThreeWindow;
    const bytes = await fetch(`/assets/${file}`).then((r) => r.arrayBuffer());
    await w.__basher_importGltfNative(bytes, `user-imports/p1325/${file}`);
  }, FIXTURE);
  expectSameLeanAsReference(await read(page));
  expect(errors).toEqual([]);
});

test('#1325 — a baked mesh’s normal map leans the way the file says', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  await ingestOnCloneRoad(page, FIXTURE, 'p1325');
  // The clone draws through three's own loader: the reading before the bake is the reference's.
  expectSameLeanAsReference(await read(page));
  const applied = await page.evaluate(async () => {
    const w = window as unknown as ThreeWindow;
    const nodes = w.__basher_dag.getState().state.nodes;
    const dataId = Object.entries(nodes).find(([, n]) => n.type === 'GltfData')?.[0];
    const objectId = Object.entries(nodes).find(
      ([, n]) => n.type === 'Object' && (n.inputs.data as { node?: string })?.node === dataId,
    )?.[0];
    const applyUrl = '/src/app/animate/dispatchApplyTransform.ts';
    const mod = (await import(/* @vite-ignore */ applyUrl)) as {
      dispatchApplyTransform: (id: string | undefined, what: 'all') => Promise<unknown>;
    };
    const result = (await mod.dispatchApplyTransform(objectId, 'all')) as { ok: boolean };
    const after = w.__basher_dag.getState().state.nodes;
    return { result, baked: Object.values(after).filter((n) => n.type === 'BakedData').length };
  });
  expect(applied).toEqual({ result: expect.objectContaining({ ok: true }), baked: 1 });
  expectSameLeanAsReference(await read(page));
  expect(errors).toEqual([]);
});
