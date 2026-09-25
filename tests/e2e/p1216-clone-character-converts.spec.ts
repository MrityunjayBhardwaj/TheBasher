// #1216 — a project saved with a clone-road character loads as a native character, drawn where and
// how the clone drew it.
//
// The character is staged on the CLONE road the way every skinned import arrived before #1205
// (`__basher_writeOpfsBytes` + `__basher_importGltf`, which always takes the clone road), moved and
// turned, and its drawn tip vertex read at two times. After a save and a reload — the resume road,
// which goes through `hydrateLoadedProject` — the same instrument (`__basher_gltf_skin`, which reads
// the drawn SkinnedMesh on either road) must read the same tip, and the scene must hold a Skeleton
// and an Armature modifier and nothing of the clone road.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

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
  __basher_importGltf?: (buf: ArrayBuffer, ref: string) => Promise<unknown>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinHandle | null;
}

const REF = 'user-imports/p1216/skinned-bar.glb';
const TWO_REF = 'user-imports/p1216/skinned-bar-two-clips.glb';

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
    return Boolean(w.__basher_importGltf && w.__basher_writeOpfsBytes && w.__basher_time);
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

  // Staged on the clone road, then placed: moved and turned about Y, as a director would.
  await page.evaluate(async (ref) => {
    const w = window as unknown as BasherWindow;
    const buf = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
    await w.__basher_importGltf!(buf, ref);
    const dag = w.__basher_dag.getState();
    const [groupId] = Object.entries(dag.state.nodes).find(
      ([, n]) =>
        n.type === 'Group' && Object.values(dag.state.nodes).some((m) => m.type === 'GltfAsset'),
    )!;
    const pos = (dag.state.nodes[groupId].params as { position: number[] }).position;
    dag.dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: groupId,
          paramPath: 'position',
          value: [pos[0] + 1.5, pos[1], pos[2] - 1],
        },
        { type: 'setParam', nodeId: groupId, paramPath: 'rotation', value: [0, 90, 0] },
      ],
      'user',
      'place the character',
    );
  }, REF);
  const before = await types(page);
  expect(before).toContain('GltfAsset');
  expect(before).not.toContain('ArmatureModifier');
  const clone = await drawnTip(page, [0.5, 1]);
  const cloneTip = clone.tip;

  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await ready(page);

  const after = await types(page);
  expect(after).toEqual(
    expect.arrayContaining(['Skeleton', 'PoseLayer', 'ArmatureModifier', 'PolyMeshData']),
  );
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  const notice = await page.evaluate(async (ref) => {
    const m = await import('/src/app/stores/assetErrorStore.ts');
    const s = m.useAssetErrorStore.getState();
    return { message: s.errors[ref], label: s.labels[ref] };
  }, REF);
  expect(notice.label).toBe('character converted:');
  expect(notice.message).toContain('now loads as a native character');

  const native = await drawnTip(page, [0.5, 1]);
  const nativeTip = native.tip;
  console.log(
    `tip search examined ${clone.examined} (clone) / ${native.examined} (native); clone ${JSON.stringify(cloneTip)} native ${JSON.stringify(nativeTip)}`,
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

/** Save, reload on the resume road, and read back the scene's node types and the file's notice. */
async function saveAndReload(
  page: Page,
  ref: string,
): Promise<{ after: string[]; notice: { message?: string; label?: string } }> {
  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await ready(page);
  const after = await types(page);
  const notice = await page.evaluate(async (r) => {
    const m = await import('/src/app/stores/assetErrorStore.ts');
    const s = m.useAssetErrorStore.getState();
    return { message: s.errors[r], label: s.labels[r] };
  }, ref);
  return { after, notice };
}

/** The file imported on the clone road, as every skinned import arrived before #1205. */
async function stageClone(page: Page, file: string, ref: string): Promise<void> {
  await page.evaluate(
    async ({ file, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(`/assets/${file}`).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
    },
    { file, ref },
  );
}

/** Two euler axes, so a wrong axis order or a degrees/radians slip moves the tip. */
const POSE: [number, number, number] = [20, 0, 30];

function expectSameTip(cloneTip: number[][], nativeTip: number[][]): void {
  nativeTip.forEach((v, t) =>
    v.forEach((c, k) =>
      expect(c, `tip at ${[0.5, 1][t]}s, axis ${k}`).toBeCloseTo(cloneTip[t][k], 4),
    ),
  );
}

test('#1216 slice 2 — a bound motion with a hand-pose on it loads native, drawn as the clone drew it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await stageClone(page, 'skinned-bar.glb', REF);

  // A motion stands in the scene, bound onto the clone rig and a bone posed on it — each through
  // the product's own verbs (the retarget and the pose mutators, as the drop and the inspector call them).
  const bound = await page.evaluate(async (pose) => {
    const w = window as unknown as BasherWindow;
    const bvh = await import('/src/core/import/bvhImportChain.ts');
    const stand = await import('/src/core/import/skeletonObject.ts');
    const { dispatchMutatorFromUI } = await import('/src/app/animate/dispatchMutator.ts');
    const text = [
      'HIERARCHY',
      'ROOT Hips',
      '{',
      '  OFFSET 0 0 0',
      '  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation',
      '  JOINT Spine',
      '  {',
      '    OFFSET 0 1 0',
      '    CHANNELS 3 Zrotation Xrotation Yrotation',
      '    End Site',
      '    {',
      '      OFFSET 0 1 0',
      '    }',
      '  }',
      '}',
      'MOTION',
      'Frames: 3',
      'Frame Time: 0.5',
      '0 0 0 0 0 0 0 0 0',
      '0 0 0 15 0 0 45 0 0',
      '0 0 0 30 0 0 90 0 0',
      '',
    ].join('\n');
    const dag = w.__basher_dag.getState();
    const motion = bvh.buildBvhImportOps({
      text,
      name: 'swing',
      ids: { skeleton: 'swing_skel', clip: 'swing_clip' },
    });
    dag.dispatchAtomic(motion.ops, 'user', 'import swing');
    const nodes = w.__basher_dag.getState().state.nodes;
    const scene = (
      w.__basher_dag.getState().state as unknown as { outputs: { scene: { node: string } } }
    ).outputs.scene.node;
    const bones = (nodes.swing_skel.params as { bones: unknown[] }).bones;
    dag.dispatchAtomic(
      stand.buildSkeletonObjectOps({
        skeletonId: 'swing_skel',
        bones: bones as never,
        sceneNodeId: scene,
        normalise: false,
        name: 'swing',
        clipId: 'swing_clip',
        nameFollowsClip: true,
      }).ops,
      'user',
      'stand swing',
    );
    const rig = Object.entries(w.__basher_dag.getState().state.nodes).find(
      ([, n]) => n.type === 'GltfSkeleton',
    )![0];
    const retarget = dispatchMutatorFromUI(
      'mutator.animation.retarget',
      {
        sourceClipId: 'swing_clip',
        sourceSkeletonId: 'swing_skel',
        targetSkeletonId: rig,
        customMap: { Hips: 'Bone0', Spine: 'Bone1' },
        outputClipId: 'swing_on_bar',
        outputName: 'bar motion',
      },
      'bind',
    );
    const posed = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { retarget: 'swing_on_bar', bone: 'Bone1', rotation: pose },
      'pose',
    );
    return { retarget: retarget.ok, posed: posed.ok };
  }, POSE);
  expect(bound).toEqual({ retarget: true, posed: true });
  expect(await types(page)).toEqual(expect.arrayContaining(['GltfAsset', 'PoseOverride']));
  const clone = await drawnTip(page, [0.5, 1]);

  const { after, notice } = await saveAndReload(page, REF);
  expect(after).toEqual(expect.arrayContaining(['Skeleton', 'PoseLayer', 'RetargetClip']));
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect|PoseOverride/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');

  const native = await drawnTip(page, [0.5, 1]);
  console.log(`bind+pose: clone ${JSON.stringify(clone.tip)} native ${JSON.stringify(native.tip)}`);
  expectSameTip(clone.tip, native.tip);
  // The bound motion moves the root between the two times; equal tips are not two rests.
  expect(Math.hypot(...clone.tip[0].map((c, k) => c - clone.tip[1][k]))).toBeGreaterThan(0.1);
  expect(errors).toEqual([]);
});

test('#1216 slice 2 — a later take and a bone posed by the gizmo load native, drawn as the clone drew them', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await stageClone(page, 'skinned-bar-two-clips.glb', TWO_REF);

  // The take picker's param, and the gizmo's write on an imported child (value + override bit).
  await page.evaluate((pose) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const nodes = dag.state.nodes;
    const [selectId] = Object.entries(nodes).find(([, n]) => n.type === 'ClipSelect')!;
    const asset = Object.values(nodes).find((n) => n.type === 'GltfAsset')!;
    const bone0 = (asset.params as { nodeNameMap: Record<string, string> }).nodeNameMap.Bone0;
    dag.dispatchAtomic(
      [
        { type: 'setParam', nodeId: selectId, paramPath: 'selectedClipName', value: 'Wave' },
        { type: 'setParam', nodeId: bone0, paramPath: 'rotation', value: pose },
        { type: 'setParam', nodeId: bone0, paramPath: 'overridden.rotation', value: true },
      ],
      'user',
      'pick Wave, turn the root bone',
    );
  }, POSE);
  const clone = await drawnTip(page, [0.5, 1]);

  const { after, notice } = await saveAndReload(page, TWO_REF);
  expect(after.filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expect(notice.label).toBe('character converted:');

  const native = await drawnTip(page, [0.5, 1]);
  console.log(
    `take+gizmo: clone ${JSON.stringify(clone.tip)} native ${JSON.stringify(native.tip)}`,
  );
  expectSameTip(clone.tip, native.tip);
  // Wave moves the tip bone between the two times; equal tips are not two rests.
  expect(Math.hypot(...clone.tip[0].map((c, k) => c - clone.tip[1][k]))).toBeGreaterThan(0.05);
  expect(errors).toEqual([]);
});
