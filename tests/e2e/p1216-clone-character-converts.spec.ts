// #1216 — a project saved with a clone-road character loads as a native character, drawn where and
// how the clone drew it.
//
// The project is one saved with the character on the CLONE road, the way every skinned import arrived
// before #1205 — recorded (`_recordedSave.ts`), since #1053 retired the clone road's import — moved and
// turned, and its drawn tip vertex read at two times. After a reload — the resume road,
// which goes through `hydrateLoadedProject` — the same instrument (`__basher_gltf_skin`, which reads
// the drawn SkinnedMesh on either road) must read the tip the clone drew (recorded since #1053 retired
// the clone renderer, `CLONE_DREW`), and the scene must hold a Skeleton
// and an Armature modifier and nothing of the clone road.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { recordedSave, savedTypes, writeRecordedSave, type RecordedSave } from './_recordedSave';

interface SkinHandle {
  count?: number;
  vertex: (i: number) => [number, number, number];
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: unknown }> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinHandle | null;
}

const REF = 'user-imports/p1216/skinned-bar.glb';

/**
 * What the CLONE drew, for the cases that stage a character on the clone road in the browser rather
 * than loading a recording (#1053: the clone renderer is gone, so it can no longer be read live).
 * Read by this spec's own `drawnTip` / `__basher_gltf_meshes` on the committed code at `7e659d1d`,
 * with the renderer still in place; the prints are kept in the store at
 * `ref/architecture/1053-clone-goldens.txt`. The staging below is unchanged, so the saved project
 * the converter reads is still made by the product's own verbs.
 */
const CLONE_DREW = {
  capturedAt: '7e659d1d',
  placed: [
    [1.5, 1.602159282629117, -0.17695431503732417],
    [1.4999999999999998, 0.8879167739419482, 0.013625844001874388],
  ] as [number, number, number][],
  colourUntouched: '#f0a85a',
  colourSet: '#12ab34',
  /** #1265 #1267 and #1269: the same file and gestures on the file's bones, at 0.25/0.5/0.75/1 s. */
  mutedOrBypassed: [
    [2.823963530312899, 2.004495484978301, 4.70227987379039e-8],
    [2.4718652030831576, 1.8723953723985547, 6.133540965681136e-8],
    [2.1915848986255484, 1.621663199124534, 7.522009555950725e-8],
    [2.021236328450141, 1.286394595732033, 8.678875761219706e-8],
  ] as [number, number, number][],
};

async function setTime(page: Page, seconds: number): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time!.getState().setTime(s),
    seconds,
  );
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_writeOpfsBytes && w.__basher_time);
  });
}

/**
 * The drawn tip vertex (highest y at t = 0, then highest x) at each time, and how many vertices the
 * search examined. Found by the DRAWN position on both roads: the clone road's seam has no `count`
 * and no `rest` (only the native one does), so the scan runs until the buffer ends (a read past it
 * is NaN, or throws in three's skinning) — and a search that examined nothing fails here rather than comparing vertex 0.
 */
async function drawnTip(
  page: Page,
  times: number[],
): Promise<{ examined: number; tip: [number, number, number][] }> {
  await page.waitForFunction(
    () => Boolean((window as unknown as BasherWindow).__basher_gltf_skin?.()),
    { timeout: 15_000 },
  );
  await setTime(page, 0);
  const found = await page.evaluate(() => {
    const s = (window as unknown as BasherWindow).__basher_gltf_skin!()!;
    let best = -1;
    let bestAt: [number, number, number] = [0, -Infinity, 0];
    let i = 0;
    for (; i < (s.count ?? 100_000); i++) {
      let v: [number, number, number];
      try {
        v = s.vertex(i);
      } catch {
        break; // past the buffer, three's skinning reads a bone that is not there
      }
      if (!v.every(Number.isFinite)) break;
      if (v[1] > bestAt[1] + 1e-6 || (Math.abs(v[1] - bestAt[1]) <= 1e-6 && v[0] > bestAt[0])) {
        best = i;
        bestAt = v;
      }
    }
    return { examined: i, best };
  });
  // skinned-bar.glb's POSITION accessor holds 6 vertices; every road draws at least those.
  expect(found.examined, 'vertices the tip search examined').toBeGreaterThanOrEqual(6);
  const tip: [number, number, number][] = [];
  for (const t of times) {
    await setTime(page, t);
    tip.push(
      await page.evaluate(
        (i) => (window as unknown as BasherWindow).__basher_gltf_skin!()!.vertex(i),
        found.best,
      ),
    );
  }
  return { examined: found.examined, tip };
}

const types = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Object.values((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).map(
      (n) => n.type,
    ),
  );

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await ready(page);
});

test('#1216 — a saved clone character loads native, drawn where the clone drew it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Recorded: staged on the clone road, then placed — the import Group moved by [1.5, 0, -1] and
  // turned to [0, 90, 0] about Y, as a director would.
  const saved = recordedSave('clone-characters/placed');
  expect(saved.ref).toBe(REF);
  expect(savedTypes(saved)).toContain('GltfAsset');
  expect(savedTypes(saved)).not.toContain('ArmatureModifier');
  const cloneTip = CLONE_DREW.placed;

  const { after } = await loadRecorded(page, saved);
  expect(after).toEqual(
    expect.arrayContaining(['Skeleton', 'PoseLayer', 'ArmatureModifier', 'PolyMeshData']),
  );
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  const notice = await page.evaluate(async (ref) => {
    const m = await import('/src/app/stores/assetErrorStore.ts');
    const s = m.useAssetErrorStore.getState();
    return { message: s.errors[`character:${ref}`], label: s.labels[`character:${ref}`] };
  }, REF);
  expect(notice.label).toBe('character converted:');
  expect(notice.message).toContain('now loads as a native character');

  const native = await drawnTip(page, [0.5, 1]);
  const nativeTip = native.tip;
  console.log(
    `tip search examined ${native.examined} (native); clone (recorded) ${JSON.stringify(cloneTip)} native ${JSON.stringify(nativeTip)}`,
  );
  nativeTip.forEach((v, t) =>
    v.forEach((c, k) =>
      expect(c, `tip at ${[0.5, 1][t]}s, axis ${k}`).toBeCloseTo(cloneTip[t][k], 4),
    ),
  );
  // The pose moves between the two times, so equal tips are not two rests.
  expect(Math.hypot(...cloneTip[0].map((c, k) => c - cloneTip[1][k]))).toBeGreaterThan(0.1);
  expect(errors).toEqual([]);
});

/** Reload on the resume road (no save), and read back the node types and the file's notice. */
async function reloadAndRead(
  page: Page,
  ref: string,
): Promise<{ after: string[]; notice: { message?: string; label?: string } }> {
  await page.reload();
  await ready(page);
  const after = await types(page);
  const notice = await page.evaluate(async (r) => {
    const m = await import('/src/app/stores/assetErrorStore.ts');
    const s = m.useAssetErrorStore.getState();
    return { message: s.errors[`character:${r}`], label: s.labels[`character:${r}`] };
  }, ref);
  return { after, notice };
}

function expectSameTip(
  cloneTip: number[][],
  nativeTip: number[][],
  times: readonly number[] = [0.5, 1],
): void {
  nativeTip.forEach((v, t) =>
    v.forEach((c, k) => expect(c, `tip at ${times[t]}s, axis ${k}`).toBeCloseTo(cloneTip[t][k], 4)),
  );
}

/**
 * A project saved with a clone-road character whose edits used the clone road's own tools (they
 * retired with #1053), and the tip vertex the clone DREW at each time (and the colour, where an edit
 * set one). The recording is the only witness left of what the clone drew.
 */
interface Recorded extends RecordedSave {
  times: number[];
  clone: { tip: [number, number, number][]; colour?: string | null };
}

const recorded = (name: string): Recorded => recordedSave<Recorded>(`clone-characters/${name}`);

/** The recorded project loaded on the resume road, as a returning user's browser loads it. */
async function loadRecorded(
  page: Page,
  saved: RecordedSave,
  opts?: { withFile?: boolean },
): Promise<{ after: string[]; notice: { message?: string; label?: string } }> {
  await writeRecordedSave(page, saved, opts);
  return reloadAndRead(page, saved.ref);
}

test('#1216 slice 2 — a bound motion with a hand-pose on it loads native, drawn as the clone drew it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Recorded: the swing BVH stood in the scene, bound onto the clone rig (the retarget mutator),
  // Bone1 posed on that motion (the pose mutator, which wrote a PoseOverride).
  const saved = recorded('bind-pose');
  expect(savedTypes(saved)).toEqual(expect.arrayContaining(['GltfAsset', 'PoseOverride']));

  const { after, notice } = await loadRecorded(page, saved);
  expect(after).toEqual(expect.arrayContaining(['Skeleton', 'PoseLayer', 'RetargetClip']));
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect|PoseOverride/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');

  const native = await drawnTip(page, saved.times);
  console.log(
    `bind+pose: clone ${JSON.stringify(saved.clone.tip)} native ${JSON.stringify(native.tip)}`,
  );
  expectSameTip(saved.clone.tip, native.tip, saved.times);
  // The bound motion moves the root between the two times; equal tips are not two rests.
  expect(
    Math.hypot(...saved.clone.tip[0].map((c, k) => c - saved.clone.tip[1][k])),
  ).toBeGreaterThan(0.1);
  expect(errors).toEqual([]);
});

test('#1216 slice 2 — a later take and a bone posed by the gizmo load native, drawn as the clone drew them', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Recorded: the take picker's param set to Wave, and the gizmo's write on the root bone (value
  // [20, 0, 30] + override bit).
  const saved = recorded('take-gizmo');

  const { after, notice } = await loadRecorded(page, saved);
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');

  const native = await drawnTip(page, saved.times);
  console.log(
    `take+gizmo: clone ${JSON.stringify(saved.clone.tip)} native ${JSON.stringify(native.tip)}`,
  );
  expectSameTip(saved.clone.tip, native.tip, saved.times);
  // Wave moves the tip bone between the two times; equal tips are not two rests.
  expect(
    Math.hypot(...saved.clone.tip[0].map((c, k) => c - saved.clone.tip[1][k])),
  ).toBeGreaterThan(0.05);
  expect(errors).toEqual([]);
});

test('#1216 slice 3 — a key edited on a bone loads native, drawn as the clone drew it, between keys too', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Recorded: the clone road's key tool on Bone1's rotation at 0.5 s ([20, 0, 40]) — a copy of the
  // file's track, then the key.
  const saved = recorded('bone-key');
  expect(savedTypes(saved)).toContain('KeyframeChannelVec3');

  const { after, notice } = await loadRecorded(page, saved);
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');

  const native = await drawnTip(page, saved.times);
  console.log(
    `key edit: clone ${JSON.stringify(saved.clone.tip)} native ${JSON.stringify(native.tip)}`,
  );
  expectSameTip(saved.clone.tip, native.tip, saved.times);
  expect(errors).toEqual([]);
});

test('#1216 slice 3 — a material colour set on the character loads native, drawn in that colour', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Recorded: the clone road's material editor on the file's `SkinnedBar` mesh
  // (`mutator.setMaterialColor`, #12ab34).
  const saved = recordedSave('clone-characters/colour-set');
  expect(JSON.stringify(saved.project)).toContain('#12ab34');

  const { after, notice } = await loadRecorded(page, saved);
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');
  const native = { color: await nativeMeshColour(page) };
  console.log(
    `material: clone (recorded) untouched ${CLONE_DREW.colourUntouched} set ${CLONE_DREW.colourSet} native ${JSON.stringify(native)}`,
  );
  // Drawn in the colour the edit set, not the file's own: a converter that dropped the edit fails.
  expect(native.color).toBe(CLONE_DREW.colourSet);
  expect(native.color).not.toBe(CLONE_DREW.colourUntouched);
  expect(errors).toEqual([]);
});

test('#1216 slice 4 — every carried edit on one character loads native, drawn as the clone drew it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Recorded: each edit through the product's own verbs, all on the one character, each on a
  // component no other edit draws over (so dropping any one of them moves the drawn tip or the
  // colour): placed and turned (the Group, [10, 90, 0]), a motion bound (retarget), Bone1 posed on
  // that motion (poseBone), Bone0 turned by the gizmo (value + override bit), Bone0's location keyed
  // (the key tool's bone address), and the mesh's colour set (setMaterialColor, #12ab34).
  const saved = recorded('every-edit');
  expect(savedTypes(saved)).toEqual(
    expect.arrayContaining(['GltfAsset', 'PoseOverride', 'RetargetClip', 'KeyframeChannelVec3']),
  );

  const { after, notice } = await loadRecorded(page, saved);
  expect(after).toEqual(
    expect.arrayContaining(['Skeleton', 'PoseLayer', 'ArmatureModifier', 'RetargetClip']),
  );
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect|PoseOverride/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');
  console.log(`every edit: notice ${notice.message}`);

  const native = await drawnTip(page, saved.times);
  const nativeColour = await nativeMeshColour(page);
  console.log(
    `every edit: clone ${JSON.stringify(saved.clone.tip)} ${saved.clone.colour} native ${JSON.stringify(native.tip)} ${nativeColour}`,
  );
  expectSameTip(saved.clone.tip, native.tip, saved.times);
  expect(saved.clone.colour).toBe('#12ab34');
  expect(nativeColour).toBe(saved.clone.colour);
  // The bound motion and the key move the tip between the times; equal tips are not two rests.
  expect(
    Math.hypot(...saved.clone.tip[0].map((c, k) => c - saved.clone.tip[2][k])),
  ).toBeGreaterThan(0.1);
  expect(errors).toEqual([]);
});

/** The colour the native mesh Object (the one an Armature modifier deforms) draws in. */
async function nativeMeshColour(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const w = window as unknown as BasherWindow & {
      __basher_mesh_material?: (id: string) => { color: string | null } | null;
    };
    const nodes = w.__basher_dag.getState().state.nodes as Record<
      string,
      { type: string; inputs?: Record<string, { node: string }> }
    >;
    const meshObject = Object.entries(nodes).find(
      ([, n]) =>
        n.type === 'Object' && nodes[n.inputs?.data?.node ?? '']?.type === 'ArmatureModifier',
    )![0];
    for (let i = 0; i < 100; i++) {
      const m = w.__basher_mesh_material?.(meshObject);
      if (m) return m.color;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return null;
  });
}

test('#1216 slice 4 — a character whose file is gone says so by name, and the project still opens', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Recorded: the file imported on the clone road and saved. Its file is NOT put in this browser's
  // storage (cleared site data, another browser).
  const saved = recordedSave('clone-characters/file-gone');
  const name =
    (Object.values(saved.project.state.nodes) as { type: string; meta?: { name?: string } }[]).find(
      (n) => n.type === 'Group',
    )?.meta?.name ?? null;
  const { after, notice } = await loadRecorded(page, saved, { withFile: false });
  const gone = await page.evaluate(async (ref) => {
    const boot = await import('/src/app/boot.ts');
    return !(await (await boot.getStorage()).exists(ref));
  }, REF);
  expect(gone).toBe(true);
  console.log(
    `file gone: name ${name} types ${JSON.stringify(after)} notice ${JSON.stringify(notice)}`,
  );
  // The project opened: the scene is there, and the character is kept exactly as saved.
  expect(after).toContain('GltfAsset');
  expect(after).not.toContain('ArmatureModifier');
  expect(notice.label).toBe('character not converted:');
  // The Group carries no name of its own here, so the notice names the character by its file.
  expect(notice.message).toContain(`"${name ?? REF.split('/').pop()}"`);
  expect(notice.message).toContain("no longer in this browser's storage");
  // #1053 (user decision 2026-09-30): a kept import is NOT DRAWN, and the notice says so. Nothing
  // draws it, so nothing reads the missing file: no row of its own and no page error.
  expect(notice.message).toContain('is not drawn');
  expect(
    await page.evaluate(() => (window as unknown as BasherWindow).__basher_gltf_skin?.() ?? null),
  ).toBeNull();
  const fileRow = await page.evaluate(async (r) => {
    const m = await import('/src/app/stores/assetErrorStore.ts');
    return m.useAssetErrorStore.getState().errors[r] ?? null;
  }, REF);
  expect(fileRow).toBeNull();
  expect(errors).toEqual([]);
});

test('#1263 — keys edited on a node of the file that is not a bone load native, drawn as the clone drew them', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Recorded: the clone road's key tool on the file's `Rig` empty, which the file slides and turns:
  // rotation keys [20, 10, 30] at 0.5 s and [40, -15, 60] at 1 s (two axes, so an euler order or an
  // euler/quaternion slip moves the tip), and a location key [0.2, 0.1, -0.3] at 0.5 s.
  const saved = recorded('rig-keys');

  const { after, notice } = await loadRecorded(page, saved);
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');
  expect(notice.message).toContain('"Rig" now turns in euler mode');

  const native = await drawnTip(page, saved.times);
  console.log(
    `rig keys: clone ${JSON.stringify(saved.clone.tip)} native ${JSON.stringify(native.tip)}`,
  );
  expectSameTip(saved.clone.tip, native.tip, saved.times);
  expect(errors).toEqual([]);
});

test('#1265 #1267 — curves added on a node of the file, which the clone never drew, load muted: drawn as the clone drew it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The file's `SkinnedBar` empty, which holds the mesh and the bones and which the file does not
  // move: what the curves would move, the tip shows. (A node the file turns is not compared here:
  // the two roads turn it differently between its keys even untouched, #1268.)
  //
  // Recorded: the key tools' own curves, made with addChannel on the clone's Object — two-axis
  // rotations (an euler order or an euler/quaternion slip moves the tip) keyed [0, 0, 0] at 0 s,
  // [20, 10, 30] at 0.5 s and [40, -15, 60] at 1 s, and a location keyed [0.2, 0.1, -0.3] at 0.5 s and
  // [0.6, 0, 0.2] at 1 s.
  const saved = recordedSave('clone-characters/empty-curves');
  expect(savedTypes(saved).filter((t) => t === 'KeyframeChannelVec3')).toHaveLength(2);
  const times = [0.25, 0.5, 0.75, 1];
  const clone = { tip: CLONE_DREW.mutedOrBypassed };

  const { after, notice } = await loadRecorded(page, saved);
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');
  expect(notice.message).toContain(
    'keys "rotation" of "SkinnedBar", which the old structure never drew',
  );
  expect(notice.message).toContain(
    'keys "position" of "SkinnedBar", which the old structure never drew',
  );

  const native = await drawnTip(page, times);
  console.log(
    `empty curves: clone (recorded) ${JSON.stringify(clone.tip)} native ${JSON.stringify(native.tip)}`,
  );
  expectSameTip(clone.tip, native.tip, times);
  expect(errors).toEqual([]);
});

test('#1269 — a driver, a Track-To, a Follow-Path and a strip on a node of the file, which the clone never drew, load bypassed: drawn as the clone drew it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Recorded: each made by the product's own builder on the clone's `SkinnedBar` empty (which holds
  // the mesh and the bones, and which the file does not move), from a controller and a path in the
  // scene — a driver on its scale from the controller (`buildBindDriverOps`), a Track-To aimed at
  // [3, 3, 3] and a Follow-Path on the path at 0.5 (`buildAddConstraintOps`), and an NLA strip of a
  // one-second slide (`mutator.nla.createAction` + `addStrip`).
  const saved = recordedSave('clone-characters/bypassed');
  const ids = Object.keys(saved.project.state.nodes);
  expect(['drv1', 'aim1', 'follow1', 'strip1'].filter((id) => ids.includes(id))).toHaveLength(4);
  const times = [0.25, 0.5, 0.75, 1];
  const clone = { tip: CLONE_DREW.mutedOrBypassed };

  const { after, notice } = await loadRecorded(page, saved);
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');
  for (const says of ['drives "scale" of', 'aims', 'sets a path for', 'plays an action on']) {
    expect(notice.message).toContain(
      `${says} "SkinnedBar", which the old structure never drew; it is kept muted`,
    );
  }

  const native = await drawnTip(page, times);
  console.log(
    `bypassed: clone (recorded) ${JSON.stringify(clone.tip)} native ${JSON.stringify(native.tip)}`,
  );
  expectSameTip(clone.tip, native.tip, times);
  expect(errors).toEqual([]);
});
