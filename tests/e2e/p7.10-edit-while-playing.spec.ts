// P7.10 Wave F6 — edit-while-playing acceptance (K-7.10.2, issue #114), on a native character (#1205).
//
// What this proves: a keyframe edit dispatched WHILE play() is running reaches the drawn skin.
// Time lives outside the React tree (the rAF Clock advances the time store; the skinned draw poses
// its bones in a useFrame), so the risk this gate guards is an edit that changes the graph and never
// reaches the frame loop:
//
//   1. play() loop running (rAF Clock advances timeStore).
//   2. setParam on the base pose layer's channels (the file's keys) → useDagStore changes.
//   3. SceneFromDAG re-renders; evaluate() misses its cache (the layer's params hash flipped) →
//      a NEW posed skeleton for the armature Object.
//   4. The skinned draw's pose ref is refreshed on that render (`SkinnedMeshR`).
//   5. On the next R3F frame, useFrame samples the NEW pose at live time.
//
// If the draw kept sampling a pose captured before the edit, this gate fails while "it still
// animates" passes — it catches edit propagation specifically.
//
// FIXTURE: the committed skinned-bar (2-bone bar, a Z-bend on Bone1 over the clip), imported
// through the product's ingest, so it is a native character. The edit sets every Bone1 rotation
// key to identity, unbending the bar; mid-bend the tip then sits well away from where it was.
// The tip vertex is found by its REST position (highest, then furthest +x), because the native draw
// numbers vertices its own way.
import { readFileSync } from 'node:fs';
import { test, expect } from './_fixtures';

const T_PROBE = 0.9; // mid-bend eval point

type Vec3 = [number, number, number];
interface SkinHandle {
  count: number;
  rest: (i: number) => Vec3;
  vertex: (i: number) => Vec3;
}
interface LayerChannel {
  bone: string;
  component: string;
  keyframes: { time: number; value: number[] }[];
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, source?: string, description?: string) => void;
    };
  };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_time?: {
    getState: () => {
      play: () => void;
      pause: () => void;
      setTime: (s: number) => void;
      seconds: number;
    };
  };
  __basher_gltf_skin?: () => SkinHandle | null;
}

/** Ingest the fixture through the product road, wait for the drawn skin, and return the tip
 *  vertex (by rest position). */
async function stageSkinnedBar(page: import('@playwright/test').Page): Promise<number> {
  const bytes = [...readFileSync('public/assets/skinned-bar.glb')];
  await page.evaluate(
    (b) =>
      (window as unknown as BasherWindow).__basher_ingestGltfFolder!(
        [{ relativePath: 'skinned-bar.glb', bytes: new Uint8Array(b) }],
        'p7-10',
      ),
    bytes,
  );
  await page.waitForFunction(
    () => Boolean((window as unknown as BasherWindow).__basher_gltf_skin?.()),
    undefined,
    { timeout: 15_000 },
  );
  return page.evaluate(() => {
    const s = (window as unknown as BasherWindow).__basher_gltf_skin!()!;
    let tip = 0;
    for (let i = 1; i < s.count; i++) {
      const r = s.rest(i);
      const best = s.rest(tip);
      if (r[1] > best[1] + 1e-6 || (Math.abs(r[1] - best[1]) <= 1e-6 && r[0] > best[0])) tip = i;
    }
    return tip;
  });
}

/** Pause playback, pin render time, let the scene repaint (2 rAFs), read the tip. Pausing makes
 *  the read deterministic: the only variable across a before/after pair is the edit. */
async function readTipAt(
  page: import('@playwright/test').Page,
  tip: number,
  seconds: number,
): Promise<Vec3> {
  await page.evaluate((s) => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().pause();
    w.__basher_time!.getState().setTime(s);
  }, seconds);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!()!.vertex(i),
    tip,
  );
}

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
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_time);
  });
});

test('P7.10 F6 — a keyframe edit dispatched DURING play() reaches the rendered skin (K-7.10.2)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  const tip = await stageSkinnedBar(page);
  const vBefore = await readTipAt(page, tip, T_PROBE);

  const playback = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const time = () => w.__basher_time!.getState();
    // The base pose layer: the one holding the file's keys.
    const { nodes } = w.__basher_dag.getState().state;
    const layerId = Object.keys(nodes).find(
      (id) =>
        nodes[id].type === 'PoseLayer' &&
        ((nodes[id].params.channels as LayerChannel[] | undefined)?.length ?? 0) > 0,
    );
    if (!layerId) return null;
    const channels = nodes[layerId].params.channels as LayerChannel[];
    const bent = channels.filter((c) => c.bone === 'Bone1' && c.component === 'quaternion');

    time().pause();
    time().setTime(0);
    const secondsStart = time().seconds;
    time().play();
    await new Promise<void>((r) => setTimeout(r, 500));
    const edited = channels.map((c) =>
      c.bone === 'Bone1' && c.component === 'quaternion'
        ? { ...c, keyframes: c.keyframes.map((k) => ({ ...k, value: [0, 0, 0, 1] })) }
        : c,
    );
    w.__basher_dag
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: layerId, paramPath: 'channels', value: edited },
        'user',
      );
    await new Promise<void>((r) => setTimeout(r, 500));
    const secondsEnd = time().seconds;
    time().pause();
    return { secondsStart, secondsEnd, keyed: bent.reduce((n, c) => n + c.keyframes.length, 0) };
  });
  expect(playback, 'the import holds no base pose layer with keys').not.toBeNull();
  expect(playback!.keyed, 'no Bone1 rotation keys to edit').toBeGreaterThan(0);
  expect(
    playback!.secondsEnd,
    `play() did not advance time on its own (start=${playback!.secondsStart}, ` +
      `end=${playback!.secondsEnd}); the rAF Clock loop is not running`,
  ).toBeGreaterThan(playback!.secondsStart + 0.3);

  const vAfter = await readTipAt(page, tip, T_PROBE);
  const delta = Math.hypot(vAfter[0] - vBefore[0], vAfter[1] - vBefore[1], vAfter[2] - vBefore[2]);
  expect(
    delta,
    `tip vertex unchanged after an edit-while-playing (delta=${delta}); the layer edit did not ` +
      `reach the drawn skin — the draw may be sampling a pose captured before the edit`,
  ).toBeGreaterThan(0.2);

  const relevant = errors.filter((e) => /gltf|three|skeleton|skin|loader|draco/i.test(e));
  expect(relevant, `unexpected loader/skin console errors: ${relevant.join('\n')}`).toHaveLength(0);
});
