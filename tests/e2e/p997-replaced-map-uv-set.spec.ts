// #997 — a REPLACED map must sample the UV set its material names, ON SCREEN.
//
// ── WHAT THIS SPEC COVERS, AND WHAT IT STOPPED COVERING ──────────────────────────────
//
// Written for the file's-copy road, where `replacedMapUvSet.gate.test.ts` proved
// `applyEditedMaps` writes the captured set onto the texture but not that the CALLER passes
// the sets in: deleting that argument at the call site in `SceneFromDAG` left the whole unit
// tier green, and only this file redded.
//
// Since #1062 the subject imports as native geometry, so this file now observes the NATIVE
// road: a map naming a UV layer, resolved against the drawn mesh's own layers, before and after
// a replacement. The file's-copy call site (`uvLayers: ir.mapUvLayers`) is no longer reached by
// any e2e — the same hole #1079 records for that road's bake, and closed the same way (a fixture
// that stays on that road), not by keeping this subject refused.
//
// ── AND WHY IT READS PIXELS RATHER THAN `Texture.channel` ─────────────────────────────
//
// `channel` is the property under test. Asserting it would be asserting that the value we
// wrote is the value we wrote — true with a renderer that ignores it entirely. Only the
// composited picture answers "does the quad show the part of the image its material asked
// for", so the observation is a colour sampled off the viewport at points projected
// through the live camera (the p568 / p553 pattern).
//
// ── THE FIXTURE, AND WHY THESE FOUR POINTS ───────────────────────────────────────────
//
// `two-uv-quad.gltf` is a unit quad whose TEXCOORD_0 spans [0,1] and whose TEXCOORD_1
// spans [0.25,0.75] — the centre quarter — with its base-colour map bound to `texCoord: 1`.
// Both images it is looked at through are a BORDER around a CENTRE, so which set is bound
// reads directly off the corners:
//
//                        corners show          centre shows
//   set 0 (whole image)   the BORDER            the CENTRE
//   set 1 (centre quarter) the CENTRE           the CENTRE
//
// The centre point is where the two sets AGREE, and it rides along in every case as the
// within-run control: it must read the same on subject and control, so a corner difference
// cannot be some other difference between the two assets leaking in.
//
// Sampled at ±0.35 of the quad rather than at its corners because set 1's range ENDS at
// 0.25/0.75, exactly the image's border/centre boundary — a corner-exact sample sits on a
// texel edge and answers by rounding. `twoUvFixture.gate.test.ts` pins the same four
// points against the image bytes, so the two tiers are one argument.
//
// ── BEFORE AND AFTER, IN THE SAME RUN ─────────────────────────────────────────────────
//
// BEFORE the replacement the quad draws the project's copy of the file's own image, sampled
// through the UV layer its material names. AFTER, it draws a replacement built by the
// production pick → bake → apply road, which must keep sampling that same layer. Different
// hues on purpose (the fixture's image is green/magenta, the replacement blue/red) so neither
// state can be mistaken for the other, and the 64×64 replacement's dimensions identify it
// independently.
//
// ── BOTH CASES ON ONE ROAD (#1062) ────────────────────────────────────────────────────
//
// Both files now arrive as native geometry. `two-uv-quad`'s mesh stores `TEXCOORD_1` as the
// corner layer `UVMap.001`, its material names that layer, and the draw resolves the name
// against the mesh to the `uv1` buffer. With subject and control on the same road the only
// difference between them is the UV set, which is what makes the centre-point control above
// hold. Each case still asserts its road, so a file that falls back to the file's copy reds
// here rather than passing on the other road's drawing.
//
// REF: src/app/material/gltfMapOverlay.ts (`applyEditedMaps` — the write),
//      src/viewport/SceneFromDAG.tsx (the call site this file is the only cover for),
//      src/core/import/gltfJsonMaterialToOpenpbr.ts (`capturePerMapUvLayers` — the capture),
//      src/app/cornerLayerNames.ts (`uvChannelOf` — a layer name resolved on the drawn mesh),
//      src/core/import/twoUvFixture.gate.test.ts (the fixture's own gate),
//      tests/e2e/_importedMesh.ts (the lookup + drawn reader, both roads);
//      issues #997, #553, #550, #1071, #1062.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes, firstMaterialMesh, importRoots } from './_importedMesh';
import { openInspectorSection } from './_inspectorSections';

/** 64×64: a 16px BLUE border around a RED centre — the same border/centre shape as the
 *  fixture's own image, in hues the fixture does not use. */
const BORDER_CENTRE_64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAjUlEQVR4nO3aQQrAMBDDQK3o/7+cviGEEgSdu2HBJ8MOLMokTuIkTuIkTuIkTuIkTuIkTuIkTuIk7tkNLIYvzeY+yTcgcRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRI3/7/QZRIncRIncRIncRIncRIncRIncRLn7QNOvS62BH8fnp+WAAAAAElFTkSuQmCC';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: unknown[], src: string, label: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_three: {
    getState: () => { scene: { getObjectByName: (n: string) => unknown } };
  };
  __basher_project_ndc: (xyz: [number, number, number]) => [number, number, number] | null;
  __basher_view_camera: () => { position: [number, number, number] } | null;
}

type RGB = { r: number; g: number; b: number };

/**
 * The drawn base-colour image's WIDTH, off the live material.
 *
 * The landed-check for every async step, keyed on the artefact's own identity — 4 for the
 * fixture's image, 64 for the replacement. Deliberately NOT the property under test: p553
 * measured that polling the placement after a replacement returns the OLD texture's answer
 * while the new one is still decoding, which reads exactly like "the feature did nothing".
 */
async function drawnWidth(page: Page) {
  const all = await drawnImportMeshes(page);
  return { n: all.length, width: all[0]?.mapWidth ?? null };
}

async function materialChild(page: Page) {
  const mesh = await firstMaterialMesh(page);
  if (!mesh) return null;
  const m0 = mesh.slots[0] as Record<string, unknown>;
  return {
    id: mesh.dataId,
    road: mesh.road,
    rootId: mesh.rootId,
    maps: m0.maps as Record<string, unknown> | undefined,
  };
}

/**
 * Which of the four fixture hues a sample is, by DOMINANCE rather than by value.
 *
 * The quad is lit, so no sample arrives at the texel's literal colour — a 255-red texel
 * reads about (132, 0, 4) under the seed light. What survives lighting is which channels
 * carry the energy, and the four hues in play (green, magenta, blue, red) are distinct
 * under that test. `null` for anything else, which is what a background sample gives, so a
 * mis-projected point cannot pass as a colour.
 */
function hue(c: RGB): 'green' | 'magenta' | 'blue' | 'red' | null {
  const peak = Math.max(c.r, c.g, c.b);
  if (peak < 30) return null; // unlit background, not a texel
  const on = (v: number) => v > peak * 0.5;
  const [r, g, b] = [on(c.r), on(c.g), on(c.b)];
  if (!r && g && !b) return 'green';
  if (r && !g && b) return 'magenta';
  if (!r && !g && b) return 'blue';
  if (r && !g && !b) return 'red';
  return null;
}

/**
 * The centre, then the four corners at ±0.35 of the quad — inside their texels and clear of
 * set 1's range ending exactly on a texel edge. The same points `twoUvFixture.gate.test.ts`
 * resolves against the image bytes, which is what makes the two tiers one argument.
 *
 * ONE array of name-and-place rather than two parallel ones: the sample is read back by
 * index, so a point added to a list of places and not to a list of names mislabels every
 * reading after it, and every assertion below addresses its point BY NAME.
 */
const POINTS = [
  { name: 'centre', at: [0, 0] },
  { name: 'corner -x-y', at: [-0.35, -0.35] },
  { name: 'corner +x-y', at: [0.35, -0.35] },
  { name: 'corner -x+y', at: [-0.35, 0.35] },
  { name: 'corner +x+y', at: [0.35, 0.35] },
] as const;

/**
 * The view camera's world position, or `null` while the camera is not mounted.
 *
 * Needed because the boot bounds-fit is not on a deadline — it exits when what it watches
 * stops changing, so it is alive for a window whose length depends on the scene. A point
 * projected on one side of such a move and sampled on the other lands somewhere else on the
 * quad, and the reading that comes back is a plausible colour from the wrong place.
 */
async function cameraPose(page: Page): Promise<number[] | null> {
  return page.evaluate(() => {
    const f = (window as unknown as BasherWindow).__basher_view_camera;
    return typeof f === 'function' ? (f()?.position ?? null) : null;
  });
}

/**
 * Whether two poses are the same VIEW — compared with a tolerance, and that is not fussiness.
 *
 * Measured: this camera's position jitters in the last bit of the double
 * (`-0.24555108944091697` against `-0.24555108944091653`) while the view is visibly, and for
 * every purpose here actually, still. An exact comparison reads every one of those as a move,
 * so the retry below never converged and the spec timed out. The threshold is roughly a
 * thousandth of the world distance one screen pixel spans at this camera's range, so a move
 * large enough to shift a sample by even one pixel is still caught.
 *
 * A `null` on either side is never "the same": it means the camera was not mounted for one of
 * the two reads, which is a state to retry out of, not one to compare through.
 */
const sameView = (a: number[] | null, b: number[] | null): boolean =>
  a !== null && b !== null && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

async function sampleQuad(page: Page, rootId: string) {
  for (let attempt = 0; ; attempt++) {
    const before = await cameraPose(page);
    const read = await captureQuad(page, rootId);
    // The capture is only usable if the camera held still across it — see `cameraPose`.
    // Bracketing is cheaper and stricter than waiting a fixed time for stillness first: it
    // guards the race itself rather than a proxy for it, and it costs nothing when there is
    // no race. Retried rather than failed, because the fit settles on its own.
    if (sameView(await cameraPose(page), before)) return read;
    expect(attempt, 'the view camera never held still long enough to sample a frame').toBeLessThan(
      20,
    );
    await page.waitForTimeout(150);
  }
}

/**
 * The quad is found through its import ROOT, not its name: the renderer names the root's group
 * with the root's node id on both roads, while the mesh itself carries the file's node name only
 * on the clone road (a native mesh is unnamed). Each fixture draws exactly one mesh.
 */
async function captureQuad(page: Page, rootId: string) {
  const shot = (await page.screenshot()).toString('base64');
  const read = await page.evaluate(
    async ({ rootId, points, shot }: { rootId: string; points: number[][]; shot: string }) => {
      const w = window as unknown as BasherWindow;
      let mesh: unknown = null;
      const root = w.__basher_three.getState().scene.getObjectByName(rootId) as
        | { traverse: (f: (o: unknown) => void) => void }
        | undefined;
      root?.traverse((o) => {
        const m = o as { isMesh?: boolean };
        if (!mesh && m.isMesh) mesh = o;
      });
      if (!mesh) return null;
      const m = mesh as {
        position: { clone: () => { set: (x: number, y: number, z: number) => unknown } };
        localToWorld: (v: unknown) => { x: number; y: number; z: number };
      };
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();

      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('screenshot decode failed'));
        img.src = `data:image/png;base64,${shot}`;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      // Self-calibrating rather than assuming a device pixel ratio of 1: the capture's own
      // width against the viewport's is the scale, whatever the runner is configured with.
      const scale = img.naturalWidth / window.innerWidth;

      const HALF = 2;
      return points.map(([lx, ly]) => {
        // `position.clone().set(…)` gives a Vector3 without importing THREE into the page.
        const wp = m.localToWorld(m.position.clone().set(lx, ly, 0));
        const ndc = w.__basher_project_ndc([wp.x, wp.y, wp.z]);
        if (!ndc) return null;
        const px = (rect.left + ((ndc[0] + 1) / 2) * rect.width) * scale;
        const py = (rect.top + ((1 - ndc[1]) / 2) * rect.height) * scale;
        const { data } = ctx.getImageData(
          Math.round(px) - HALF,
          Math.round(py) - HALF,
          HALF * 2,
          HALF * 2,
        );
        let r = 0;
        let g = 0;
        let b = 0;
        const n = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
        return {
          rgb: { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) },
          inFrustum: ndc[0] > -1 && ndc[0] < 1 && ndc[1] > -1 && ndc[1] < 1 && ndc[2] < 1,
        };
      });
    },
    { rootId, points: POINTS.map((p) => [...p.at]), shot },
  );
  if (!read) throw new Error(`no mesh is drawn under import root ${rootId}`);
  const out: Record<string, { hue: ReturnType<typeof hue>; rgb: RGB; inFrustum: boolean }> = {};
  POINTS.forEach(({ name }, i) => {
    const r = read[i];
    if (!r) throw new Error(`${name} did not project through the view camera`);
    out[name] = { hue: hue(r.rgb), rgb: r.rgb, inFrustum: r.inFrustum };
  });
  return out;
}

async function importAndSelect(page: Page, asset: string, folder: string) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  // The seed box is a unit cube at the origin and the quad's plane cuts straight through
  // it, so the box would occlude the very points this file samples. Move it out of shot;
  // the quad is the subject and nothing here is about the box.
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [0, -1.5, 0] }],
        'e2e',
        '#997 clear the shot',
      );
  });
  await page.evaluate(
    async ({ asset, folder }: { asset: string; folder: string }) => {
      const w = window as unknown as BasherWindow;
      const buf = (await fetch(`/assets/${asset}`).then((r) => r.arrayBuffer())) as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      await w.__basher_ingestGltfFolder([{ relativePath: asset, bytes }], folder);
    },
    { asset, folder },
  );
  await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
  const child = (await materialChild(page))!;
  // ONE import, so its root is the only one.
  expect((await importRoots(page)).map((r) => r.rootId)).toEqual([child.rootId]);
  await page.evaluate((nid: string) => {
    (window as unknown as BasherWindow).__basher_selection.getState().select(nid);
  }, child.id);
  await openInspectorSection(page, 'material');
  // The fixture's OWN image has reached the render before any premise is read.
  await expect.poll(async () => (await drawnWidth(page)).width).toBe(4);
  // ONE drawn mesh, so the reader's `[0]` is unambiguous.
  expect((await drawnWidth(page)).n).toBe(1);
  return child;
}

/** Replace the base-colour map through the production pick → bake → apply road. */
async function replaceAlbedo(page: Page, childId: string) {
  await page.getByTestId(`inspector-map-file-${childId}-albedo`).setInputFiles({
    name: 'border-centre.png',
    mimeType: 'image/png',
    buffer: Buffer.from(BORDER_CENTRE_64, 'base64'),
  });
  // The DAG param is the first half of "landed" — necessary, nowhere near sufficient.
  await expect.poll(async () => (await materialChild(page))?.maps?.albedo != null).toBe(true);
  // …and this is the half that matters: the DRAWN image is the 64×64 replacement.
  await expect.poll(async () => (await drawnWidth(page)).width).toBe(64);
}

const CASES = [
  {
    asset: 'two-uv-quad.gltf',
    mesh: 'TwoUvQuad',
    title: 'a map bound to TEXCOORD_1 draws the CENTRE QUARTER',
    road: 'native',
    // Set 1 spans the centre quarter, so every corner of the quad shows the image's centre.
    inherited: 'magenta',
    replaced: 'red',
  },
  {
    asset: 'one-uv-quad.gltf',
    mesh: 'OneUvQuad',
    title: 'the CONTROL, on the default set, draws the WHOLE image',
    road: 'native',
    // Set 0 spans the whole image, so the corners show its border.
    inherited: 'green',
    replaced: 'blue',
  },
] as const;

for (const c of CASES) {
  test(`#997 — ${c.title}`, async ({ page }) => {
    const child = await importAndSelect(page, c.asset, `p997-${c.mesh}`);
    expect(child.road, `${c.asset} arrived on the ${child.road} road`).toBe(c.road);

    // ── The INHERITED image: the file's own texture, sampled through the layer the material names.
    const before = await sampleQuad(page, child.rootId);
    for (const [k, v] of Object.entries(before))
      expect(v.inFrustum, `${k} is off screen — the sample would be background`).toBe(true);
    // The centre is where the two sets agree: the same hue on subject and control.
    expect(before.centre.hue, `centre before: ${JSON.stringify(before.centre.rgb)}`).toBe(
      'magenta',
    );
    for (const k of Object.keys(before).filter((k) => k !== 'centre'))
      expect(before[k].hue, `${k} before: ${JSON.stringify(before[k].rgb)}`).toBe(c.inherited);

    // ── The REPLACED road: a director's own file, through the production pick.
    await replaceAlbedo(page, child.id);

    const after = await sampleQuad(page, child.rootId);
    for (const [k, v] of Object.entries(after))
      expect(v.inFrustum, `${k} is off screen — the sample would be background`).toBe(true);
    expect(after.centre.hue, `centre after: ${JSON.stringify(after.centre.rgb)}`).toBe('red');
    for (const k of Object.keys(after).filter((k) => k !== 'centre'))
      expect(after[k].hue, `${k} after: ${JSON.stringify(after[k].rgb)}`).toBe(c.replaced);
  });
}
