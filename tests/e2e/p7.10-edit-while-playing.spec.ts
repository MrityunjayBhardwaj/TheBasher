// P7.10 Wave F6 — edit-while-playing acceptance (K-7.10.2, issue #114).
//
// What this proves: after Pass 3 (B13) moved time OUT of SceneFromDAG's React
// subscriptions (Wave D) and INTO the value via TransformClipValue.sample(t)
// (Wave A), a keyframe edit dispatched WHILE play() is running still reaches
// the rendered bones. The architectural risk the gate guards:
//
//   K-7.10.2 lifecycle:
//     1. play() loop running (rAF Clock advances timeStore).
//     2. setParam on a TransformClip's keyframes → useDagStore changes.
//     3. SceneFromDAG re-renders (it still subscribes to dagStore — only the
//        THREE time subscriptions were removed in Wave D).
//     4. evaluate() runs with frozen ctx.time → TransformClip cache MISS
//        (params hash flipped because keyframes changed) → NEW closure built.
//     5. React commits → GltfAssetR receives the new value.transformClip prop.
//     6. On the next R3F frame, useFrame calls the NEW closure at live time.
//     7. Bones reflect the new keyframes within ~1 frame.
//
// If Wave D had ALSO severed the dagStore subscription (it must not), or if
// useFrame closed over a stale clip closure, the edit would never reach the
// surface and this gate fails while the perf benchmark's "fox still animates"
// validity gate still passes — i.e. this test catches the edit-propagation
// regression specifically, not just "does it animate".
//
// FIXTURE CHOICE — committed skinned-bar, not Fox.glb. The PLAN's F6 row names
// Fox.glb (it sat next to the perf benchmark), but F6 is a CORRECTNESS gate,
// not a perf measurement. Fox.glb is /tmp-only and the perf spec skips on CI
// (no real GPU) — a K-7.10.2 gate keyed to Fox.glb would never run in CI,
// defeating its purpose. The committed public/assets/skinned-bar.glb (the #88
// fixture: 2-bone bar, tip vertex 4 weighted to Bone1, a Z-bend clip over
// t∈[0,1]) is deterministic, reproducible (scripts/gen-skinned-fixture.mjs),
// and runs headless on CI — the right substrate for an acceptance gate. The
// observable (a skin-bound vertex world-position) is identical to Fox.glb's.
//
// Observation discipline mirrors p7.6: assert on the deformed VERTEX, never the
// bone TRS (the joints move regardless of the skin binding). The reads are
// stabilised by pausing at a FIXED eval time so the playback phase is controlled
// out and the only variable across the before/after pair is the mid-play edit.
//
// REF: PLAN.md 7.10 Wave F6 + K-7.10.2; CONTEXT 7.10 D-01/D-05; vyapti V3
// (amended) + V24; hetvabhasa H48/H49; dharana B13 (SHIPPED HOW); issue #114.
// Harness reused from tests/e2e/p7.6-gltf-skinned.spec.ts.

import { test, expect } from './_fixtures';

const ASSET_REF = 'assets/skinned-bar.glb';
const FIXTURE_URL = '/assets/skinned-bar.glb';
const TIP_VERTEX = 4; // far-end vertex weighted to Bone1 (gen-skinned-fixture.mjs TIP_VERTEX_INDEX)
const T_PROBE = 0.9; // mid-bend eval point — the same time p7.6's deform headline uses

interface SkinHandle {
  boneCount: number;
  bound: boolean;
  vertex: (i: number) => [number, number, number];
}
type Vec3 = [number, number, number];
interface Keyframe {
  targetNodeId: string;
  time: number;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, source?: string, description?: string) => void;
    };
  };
  __basher_importGltf?: (
    buffer: ArrayBuffer,
    assetRef: string,
  ) => Promise<{ gltfAssetId: string; transformClipIds: string[] }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
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

/** Stage the fixture (bytes → OPFS, structure → DAG), wait for the rendered
 *  SkinnedMesh seam, and return the imported TransformClip node ids. */
async function stageSkinnedBar(page: import('@playwright/test').Page): Promise<string[]> {
  const clipIds = await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      const res = await w.__basher_importGltf!(buf, ref);
      return res.transformClipIds;
    },
    { url: FIXTURE_URL, ref: ASSET_REF },
  );
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    { timeout: 15_000 },
  );
  return clipIds;
}

/** Pause playback, pin render time to a fixed eval point, and let the scene
 *  repaint (2 rAFs) so the bone-matrix palette recomputes before the read.
 *  Pausing makes the read deterministic — the playback phase is controlled out
 *  so the only variable across a before/after pair is the keyframe edit. */
async function readTipAt(page: import('@playwright/test').Page, seconds: number): Promise<Vec3> {
  await page.evaluate((s) => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().pause();
    w.__basher_time!.getState().setTime(s);
  }, seconds);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!().vertex(i),
    TIP_VERTEX,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Fresh OPFS so writeOpfsBytes staging is the only source of the asset.
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
    return Boolean(w.__basher_importGltf && w.__basher_writeOpfsBytes && w.__basher_time);
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

  const clipIds = await stageSkinnedBar(page);
  expect(
    clipIds.length,
    'fixture imported no TransformClip — the bend clip is missing',
  ).toBeGreaterThan(0);

  // Baseline: paused at the probe time with the ORIGINAL keyframes.
  const vBefore = await readTipAt(page, T_PROBE);

  // Drive REAL playback (~1s of rAF Clock ticks) and MID-PLAY dispatch a
  // keyframe edit that adds a large rotation offset to every keyframe of the
  // bend clip. The edit must reach GltfAssetR's useFrame even though
  // SceneFromDAG no longer subscribes to time (Wave D).
  const playback = await page.evaluate(
    async ({ clipId }) => {
      const w = window as unknown as BasherWindow;
      const time = () => w.__basher_time!.getState();
      time().pause();
      time().setTime(0);
      const secondsStart = time().seconds;

      time().play();
      // Let the rAF Clock advance on its own for ~500ms BEFORE the edit.
      await new Promise<void>((r) => setTimeout(r, 500));

      // EDIT WHILE PLAYING — amplify every keyframe's rotation by +90° on each
      // axis. Shifting all keyframes of a track by a constant shifts the
      // interpolated pose at every time, so the bend at T_PROBE changes
      // substantially → the tip vertex must move.
      const node = w.__basher_dag.getState().state.nodes[clipId];
      const original = node.params.keyframes as Keyframe[];
      const edited = original.map((k) => ({
        ...k,
        rotation: [k.rotation[0] + 90, k.rotation[1] + 90, k.rotation[2] + 90] as [
          number,
          number,
          number,
        ],
      }));
      w.__basher_dag
        .getState()
        .dispatch(
          { type: 'setParam', nodeId: clipId, paramPath: 'keyframes', value: edited },
          'user',
        );

      // Keep playing so at least one frame commits the new closure into useFrame.
      await new Promise<void>((r) => setTimeout(r, 500));
      const secondsEnd = time().seconds;
      time().pause();
      return { secondsStart, secondsEnd, keyframeCount: original.length };
    },
    { clipId: clipIds[0] },
  );

  // Sanity: the clip actually had keyframes to edit.
  expect(playback.keyframeCount, 'TransformClip had no keyframes to edit').toBeGreaterThan(0);

  // (1) Playback was genuinely LIVE — the rAF Clock loop advanced time on its
  //     own (not via manual setTime). This is K-7.10.2 step 1.
  expect(
    playback.secondsEnd,
    `play() did not advance time on its own (start=${playback.secondsStart}, ` +
      `end=${playback.secondsEnd}); the rAF Clock loop is not running`,
  ).toBeGreaterThan(playback.secondsStart + 0.3);

  // (2) Re-read at the SAME probe time. Phase is controlled out, so the only
  //     variable is the mid-play keyframe edit. The tip vertex MUST have moved
  //     → the new keyframes reached the rendered bones (K-7.10.2 steps 4–7).
  const vAfter = await readTipAt(page, T_PROBE);

  const delta = Math.hypot(vAfter[0] - vBefore[0], vAfter[1] - vBefore[1], vAfter[2] - vBefore[2]);
  expect(
    delta,
    `tip vertex unchanged after an edit-while-playing (delta=${delta}); the keyframe ` +
      `setParam did not reach the rendered skin — SceneFromDAG may have lost its dagStore ` +
      `re-evaluation, or useFrame is sampling a stale clip closure`,
  ).toBeGreaterThan(0.2);

  const relevant = errors.filter((e) => /gltf|three|skeleton|skin|loader|draco/i.test(e));
  expect(relevant, `unexpected loader/skin console errors: ${relevant.join('\n')}`).toHaveLength(0);
});
