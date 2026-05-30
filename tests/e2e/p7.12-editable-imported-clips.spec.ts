// P7.12 HEADLINE e2e (#108) — editable imported glTF clips in the dopesheet.
//
// THIS green = the phase GOAL met, by DIRECT OBSERVATION (Lokāyata), not
// inference. The proof spans five surfaces:
//
//   (a) DISPLAY     — selecting an imported bone surfaces its embedded clip as
//                     READ-ONLY dopesheet rows + a curve in the editor, with NO
//                     bake (the most-visible half of #108).
//   (b) EDIT (COW)  — the FIRST timeline edit of a clip-backed bone bakes the
//                     clip track into editable per-bone KeyframeChannel node(s)
//                     and applies the edit; during playback the EDITED bone's
//                     skin-bound vertex DIFFERS from the pure-clip baseline,
//                     while an UNTOUCHED bone's vertex MATCHES it.
//   (b2) PARITY     — the SAME baked-then-edited bone's read-side evaluated
//                     transform (resolveEvaluatedTransform — the gizmo/NPanel
//                     resolver, C3) equals the RENDERED bone TRS at t=0.5/1.5
//                     (BLOCK-1 / H40 — no displayed≠rendered split, the #68/#77
//                     second-surface bug class).
//   (b3) ONE ROW SET— after the clip→baked transition the dopesheet shows
//                     exactly ONE row set for the bone (FLAG-3 — never clip-row
//                     + orphan-row simultaneously).
//   (c) REVERT      — deleting the baked channel falls back to the clip
//                     (presence-based, R-4); the bone plays the original import
//                     again and the clip rows return.
//   (d) PAUSED EDIT — editing while paused reflects without play (C2 dirty-check
//                     keyed on the baked map).
//   (e) PERF GUARD  — bake + edit SEVERAL bones → `commits === 0` across a 5s
//                     playback window. This is the NO-NEW-TIME-SUBSCRIPTION
//                     invariant (FLAG-2): the function-of-time value shape (V24)
//                     keeps the React tree from re-rendering per frame. It is
//                     NOT and CANNOT be a node-count knee measurement on this
//                     small fixture — the knee is a DESIGN argument (≤3 nodes
//                     per baked bone ≪ the ~1000-node knee) proven by the manual
//                     /tmp Fox harness (perf-fox-benchmark.spec.ts), NOT here.
//
// FIXTURE — committed public/assets/skinned-bar.glb (the #88 fixture; repro via
// scripts/gen-skinned-fixture.mjs): a 2-bone bar. Bone1 (the TIP, bone index 1)
// is ANIMATED — the clip rotates it about Z over t∈[0,1]; vertex 4 is weighted
// to Bone1. Bone0 (the BASE, bone index 0) is NOT animated; vertices 0/1 are
// weighted to it. So a SINGLE committed fixture gives both the "edited bone
// moves" AND the "untouched bone unmoved" halves of (b) — no many-bone-rig.glb
// needed. (We measure the channel the clip ACTUALLY drives: skinned-bar bends by
// ROTATION, so we edit the rotation component and read the skin-bound VERTEX —
// vertex-delta is channel-agnostic, the H45/H47 lesson.)
//
// EDIT DISCIPLINE — the edit is driven through the REAL TimelineCanvas pointer
// path (page.mouse drag on the dopesheet <canvas>), NOT a store seam. This
// exercises onPointerDown → endDrag → dispatchBakeThenRetime, the exact
// copy-on-write composite a director triggers. Pixel coordinates are
// GEOMETRY-DERIVED (keyframeToRect imported at runtime — the SAME math the
// component paints with), never magic numbers — same discipline as
// tests/e2e/p7.1-keyframe-retime.spec.ts.
//
// REF: PLAN.md 7.12 Wave E (E2); CONTEXT/PLAN 7.12 (D-04, BLOCK-1, BLOCK-2,
//      FLAG-2/3); skin seam SceneFromDAG.tsx:784-826 (__basher_gltf_skin:
//      vertex/boneRotation); __basher_evaluate boot.ts:307; __basher_perf
//      frameProfiler.ts:196; resolveEvaluatedTransform.ts (C3 read-side);
//      dispatchMutator.ts dispatchBakeThenRetime/dispatchRevertGltfChannel;
//      [[H40]] [[H45]] [[H46]] [[H48]] [[V24]] [[V20]] [[H36]]. Issue #108.
// Harness reused from tests/e2e/p7.10-edit-while-playing.spec.ts.

import { expect, test } from './_fixtures';

const ASSET_REF = 'assets/skinned-bar.glb';
const FIXTURE_URL = '/assets/skinned-bar.glb';
const ANIMATED_CHILD = 'Bone1'; // the TIP bone — clip rotates it about Z
const ANIMATED_BONE_INDEX = 1; // skeleton.bones[1] === Bone1 (gen-skinned-fixture.mjs)
const TIP_VERTEX = 4; // weighted to Bone1 (the animated bone) → MOVES on edit
const BASE_VERTEX = 0; // weighted to Bone0 (un-animated) → must NOT move
const ROW_HEIGHT_PX = 24; // TimelineCanvas.tsx:110
const DIAMOND_PX = 8; // TimelineCanvas.tsx:112
const LABEL_GUTTER_PX = 128; // TimelineCanvas.tsx:114

type Vec3 = [number, number, number];

interface SkinHandle {
  boneCount: number;
  bound: boolean;
  vertex: (i: number) => Vec3;
  boneRotation: (i: number) => Vec3 | null;
  boneName: (i: number) => string | null;
}
interface EvaluatedTransform {
  position: Vec3;
  rotation: Vec3 | null;
  scale: Vec3 | null;
}
interface ChannelRowLite {
  channelId: string;
  keyframes: { time: number }[];
  readOnly?: boolean;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_timeline_selection?: {
    getState: () => {
      setActiveChannel: (id: string | null) => void;
      activeChannelId: string | null;
    };
  };
  __basher_importGltf?: (
    buffer: ArrayBuffer,
    assetRef: string,
  ) => Promise<{ gltfAssetId: string; transformClipIds: string[] }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_evaluate?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown; hash: string };
  __basher_perf?: { start: () => void; stop: () => { commits: number } };
  __basher_time?: {
    getState: () => {
      play: () => void;
      pause: () => void;
      setTime: (s: number) => void;
      seconds: number;
      durationSeconds: number;
    };
  };
  __basher_gltf_skin?: () => SkinHandle | null;
}

/** Stage the fixture (bytes → OPFS, structure → DAG) and wait for the rendered
 *  SkinnedMesh seam. */
async function stageSkinnedBar(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
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
}

/** The GltfChild dagId for the animated bone (hashId('gltfChild', assetRef,
 *  childName)) — found by walking the DAG for the GltfChild carrying childName,
 *  so the test does not re-implement hashId. */
async function animatedChildDagId(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate((childName) => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag.getState().state.nodes;
    for (const [id, n] of Object.entries(nodes)) {
      if (n.type === 'GltfChild' && (n.params as { childName?: string }).childName === childName) {
        return id;
      }
    }
    throw new Error(`no GltfChild for childName "${childName}"`);
  }, ANIMATED_CHILD);
}

/** Select the imported bone (viewport/NPanel selection) so the dopesheet
 *  surfaces its clip rows, then make the ROTATION clip row active (the channel
 *  the fixture actually drives). */
async function selectAnimatedBoneRotationRow(
  page: import('@playwright/test').Page,
  childDagId: string,
): Promise<void> {
  await page.evaluate(
    ({ id, child }) => {
      const w = window as unknown as BasherWindow;
      w.__basher_selection!.getState().select(id);
      // Force the rotation component active (B2 auto-selects the first/position
      // clip row; we want the animated channel for a visible vertex delta).
      w.__basher_timeline_selection!.getState().setActiveChannel(`clip:${child}:rotation`);
    },
    { id: childDagId, child: ANIMATED_CHILD },
  );
}

/** Compute the rotation clip row index + diamond pixel by replaying the SAME
 *  row assembly (collectChannelRows + appendSelectionClipRows) and geometry
 *  (keyframeToRect) the component uses — so the drag is geometry-derived, never
 *  a magic pixel. Returns canvas-local px for the first keyframe of the
 *  rotation row. */
async function rotationRowDiamond(
  page: import('@playwright/test').Page,
  childDagId: string,
  canvasWidth: number,
): Promise<{ rowIndex: number; localX: number; localY: number; fromTime: number }> {
  return page.evaluate(
    async ({ id, child, width, gutter, rowH, diamond }) => {
      const w = window as unknown as BasherWindow;
      const [{ collectChannelRows }, { appendSelectionClipRows }, { keyframeToRect }] =
        await Promise.all([
          import('/src/timeline/TimelineCanvas.tsx'),
          import('/src/timeline/clipChannelRows.ts'),
          import('/src/timeline/timelineCanvasGeometry.ts'),
        ]);
      const nodes = w.__basher_dag.getState().state.nodes as Record<string, never>;
      const rows = appendSelectionClipRows({
        baseRows: collectChannelRows(nodes),
        nodes,
        selectedNodeId: id,
      }) as ChannelRowLite[];
      const rotId = `clip:${child}:rotation`;
      const rowIndex = rows.findIndex((r) => r.channelId === rotId);
      if (rowIndex < 0) throw new Error(`rotation clip row not found among ${rows.length} rows`);
      const fromTime = rows[rowIndex].keyframes[0].time;
      const trackWidth = Math.max(width - gutter, 0);
      const rect = keyframeToRect(fromTime, rowIndex, 0, trackWidth, rowH, diamond);
      // Mirror onPointerDown's mapping: localX = gutter + rect.x + rect.w/2.
      const localX = gutter + rect.x + rect.w / 2;
      const localY = rowIndex * rowH + rowH / 2;
      return { rowIndex, localX, localY, fromTime };
    },
    {
      id: childDagId,
      child: ANIMATED_CHILD,
      width: canvasWidth,
      gutter: LABEL_GUTTER_PX,
      rowH: ROW_HEIGHT_PX,
      diamond: DIAMOND_PX,
    },
  );
}

/** Pause, pin render time, repaint (2 rAFs), read the skin-bound vertex. The
 *  paused read is deterministic (playback phase controlled out). */
async function readVertexAt(
  page: import('@playwright/test').Page,
  vertexIndex: number,
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
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!().vertex(i),
    vertexIndex,
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
    if (typeof localStorage !== 'undefined') localStorage.removeItem('basher.timelineDock.v1');
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_importGltf &&
      w.__basher_writeOpfsBytes &&
      w.__basher_time &&
      w.__basher_evaluate &&
      w.__basher_selection &&
      w.__basher_timeline_selection &&
      w.__basher_perf,
    );
  });
  // The timeline dock is mode-gated to Animate (D-UX-1).
  await page.getByTestId('mode-switcher').selectOption('animate');
});

test('P7.12 (a) DISPLAY — selecting an imported bone surfaces its clip rows + a read-only curve, NO bake', async ({
  page,
}) => {
  await stageSkinnedBar(page);
  const childDagId = await animatedChildDagId(page);

  // Pre-condition: NO KeyframeChannel nodes exist yet (display is bake-free).
  const channelsBefore = await page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    return Object.values(nodes).filter((n) => n.type.startsWith('KeyframeChannel')).length;
  });
  expect(channelsBefore, 'display must not bake — no KeyframeChannel before any edit').toBe(0);

  await selectAnimatedBoneRotationRow(page, childDagId);

  await page.getByTestId('timeline-drawer-toggle').click();
  const host = page.getByTestId('timeline-canvas');
  await expect(host).toBeVisible();
  await expect(host.locator('canvas')).toBeVisible();

  // The dopesheet surfaced the bone's clip rows (3 components × the bone's keys).
  // data-channel-count mirrors rows.length (D-W9-4 data contract).
  const channelCount = await host.getAttribute('data-channel-count');
  expect(
    Number(channelCount),
    'dopesheet shows the imported bone clip rows',
  ).toBeGreaterThanOrEqual(3);

  // Enter the Curve Editor tab (D-W5-3: explicit tab entry only — selecting a
  // row never auto-switches). The CurveEditor pane is display:none until then.
  await page.getByTestId('timeline-tab-curve').click();

  // The curve editor renders the read-only imported curve. The pane visibility
  // is proven by the affordance label (a visible <div>); the curve itself is an
  // SVG <polyline> whose painted bounding box Playwright reports as "hidden"
  // even when drawn (an SVG-child visibility quirk, not a real contract) — so
  // the load-bearing assertion is the polyline's NON-EMPTY `points`, the direct
  // proof a curve was projected from the clip (the "(imported — edit to make
  // editable)" affordance is the read-only signal, no drag handle).
  await expect(page.getByTestId('curve-readonly-label')).toBeVisible();
  await expect(page.getByTestId('curve-track-0')).toBeAttached();
  const points = await page.getByTestId('curve-track-0').getAttribute('points');
  expect(
    points && points.trim().length,
    'curve editor drew a non-empty imported curve',
  ).toBeTruthy();

  // STILL no bake — display is purely read-only.
  const channelsAfter = await page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    return Object.values(nodes).filter((n) => n.type.startsWith('KeyframeChannel')).length;
  });
  expect(channelsAfter, 'displaying a clip must not bake it').toBe(0);
});

test('P7.12 (b)(b2)(b3) EDIT — first timeline edit bakes copy-on-write; edited bone moves, untouched bone does not; read-side==render; one row set', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await stageSkinnedBar(page);
  const childDagId = await animatedChildDagId(page);

  // Baselines (pure clip, no edit yet), paused at two probe times.
  const tipBefore05 = await readVertexAt(page, TIP_VERTEX, 0.5);
  const baseBefore05 = await readVertexAt(page, BASE_VERTEX, 0.5);

  await selectAnimatedBoneRotationRow(page, childDagId);
  await page.getByTestId('timeline-drawer-toggle').click();
  const host = page.getByTestId('timeline-canvas');
  await expect(host).toBeVisible();
  const canvas = host.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = (await canvas.boundingBox())!;
  const { localX, localY } = await rotationRowDiamond(page, childDagId, box.width);

  // DRAG the rotation row's first keyframe to the RIGHT by ~25% of the track.
  // The drag fires onPointerDown (clip-row context) → endDrag →
  // dispatchBakeThenRetime: bake the bone's TRS into 3 KeyframeChannel nodes
  // AND retime the dragged key, as ONE atomic undo (K6). Retiming a clip key
  // changes the interpolated rotation at the probe times → the tip vertex moves.
  const startX = box.x + localX;
  const startY = box.y + localY;
  const targetX = box.x + Math.min(localX + (box.width - LABEL_GUTTER_PX) * 0.3, box.width - 6);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(startX + (targetX - startX) * (i / 8), startY);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);

  // (b-i) A baked KeyframeChannel with the DETERMINISTIC id materialized — the
  // rotation component's gltfChannelDagId(assetRef, childName, 'rotation').
  const baked = await page.evaluate(
    async ({ child, asset }) => {
      const { gltfChannelDagId } = await import('/src/core/import/gltfImportChain.ts');
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag.getState().state.nodes;
      const rotId = gltfChannelDagId(asset, child, 'rotation');
      const channelIds = Object.entries(nodes)
        .filter(([, n]) => n.type.startsWith('KeyframeChannel'))
        .map(([id]) => id);
      return { rotId, present: Boolean(nodes[rotId]), channelIds };
    },
    { child: ANIMATED_CHILD, asset: ASSET_REF },
  );
  expect(
    baked.present,
    `the first timeline edit must materialize the deterministic baked channel ` +
      `${baked.rotId} (got channels: ${baked.channelIds.join(', ') || 'none'})`,
  ).toBe(true);

  // (b-ii) During (paused-at-probe) playback the EDITED bone's tip vertex
  // DIFFERS from the pure-clip baseline.
  const tipAfter05 = await readVertexAt(page, TIP_VERTEX, 0.5);
  const tipDelta = Math.hypot(
    tipAfter05[0] - tipBefore05[0],
    tipAfter05[1] - tipBefore05[1],
    tipAfter05[2] - tipBefore05[2],
  );

  console.log(
    `[P7.12] tip vertex before=${JSON.stringify(tipBefore05)} after=${JSON.stringify(
      tipAfter05,
    )} delta=${tipDelta}`,
  );
  expect(
    tipDelta,
    `the edited bone's skin vertex did not move (delta=${tipDelta}); the baked+edited ` +
      `rotation channel did not reach the rendered skin (C2 resolver / dirty-check)`,
  ).toBeGreaterThan(0.05);

  // (b-iii) An UNTOUCHED bone (Bone0, vertices weighted to it) still plays from
  // the clip — its vertex MATCHES the clip baseline.
  const baseAfter05 = await readVertexAt(page, BASE_VERTEX, 0.5);
  const baseDelta = Math.hypot(
    baseAfter05[0] - baseBefore05[0],
    baseAfter05[1] - baseBefore05[1],
    baseAfter05[2] - baseBefore05[2],
  );

  console.log(
    `[P7.12] base vertex before=${JSON.stringify(baseBefore05)} after=${JSON.stringify(
      baseAfter05,
    )} delta=${baseDelta}`,
  );
  expect(
    baseDelta,
    `an UNTOUCHED bone's vertex moved (delta=${baseDelta}); editing one bone must not ` +
      `disturb bones still playing from the one clip node`,
  ).toBeLessThan(1e-4);

  // (b2) MULTI-SURFACE PARITY (BLOCK-1 / H40): the read-side resolver
  // (resolveEvaluatedTransform — gizmo/NPanel, C3) rotation == the RENDERED bone
  // rotation, at t=0.5 AND t=1.5. read-side is DEGREES; render is RADIANS.
  for (const probe of [0.5, 1.5]) {
    const parity = await page.evaluate(
      async ({ id, boneIdx, seconds }) => {
        const w = window as unknown as BasherWindow;
        w.__basher_time!.getState().pause();
        w.__basher_time!.getState().setTime(seconds);
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
        const { resolveEvaluatedTransform } = await import('/src/app/resolveEvaluatedTransform.ts');
        const state = w.__basher_dag.getState().state as never;
        const ctx = { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
        const resolved = resolveEvaluatedTransform(state, id, ctx) as EvaluatedTransform | null;
        const renderRot = w.__basher_gltf_skin!().boneRotation(boneIdx);
        return { resolvedRot: resolved?.rotation ?? null, renderRot };
      },
      { id: childDagId, boneIdx: ANIMATED_BONE_INDEX, seconds: probe },
    );

    console.log(
      `[P7.12] parity@t=${probe} read-side(deg)=${JSON.stringify(
        parity.resolvedRot,
      )} render(rad)=${JSON.stringify(parity.renderRot)}`,
    );
    expect(
      parity.resolvedRot,
      `read-side resolver returned no rotation for the bone @t=${probe}`,
    ).not.toBeNull();
    expect(
      parity.renderRot,
      `render skeleton returned no rotation for the bone @t=${probe}`,
    ).not.toBeNull();
    const DEG = 180 / Math.PI;
    for (let k = 0; k < 3; k++) {
      const readDeg = parity.resolvedRot![k];
      const renderDeg = (parity.renderRot![k] ?? 0) * DEG;
      expect(
        Math.abs(readDeg - renderDeg),
        `BLOCK-1/H40 displayed≠rendered @t=${probe} axis ${k}: read-side=${readDeg}° ` +
          `render=${renderDeg}° (the #68/#77 second-surface split)`,
      ).toBeLessThan(0.5);
    }
  }

  // (b3) SINGLE ROW SET (FLAG-3): after the clip→baked transition the dopesheet
  // shows exactly ONE row set for the bone — the baked channel rows ONLY, never
  // the clip rows AND an orphan-channel row for the same bone simultaneously.
  const rowInventory = await page.evaluate(
    async ({ id, child, asset }) => {
      const [{ collectChannelRows }, { appendSelectionClipRows }, { gltfChannelDagId }] =
        await Promise.all([
          import('/src/timeline/TimelineCanvas.tsx'),
          import('/src/timeline/clipChannelRows.ts'),
          import('/src/core/import/gltfImportChain.ts'),
        ]);
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag.getState().state.nodes as Record<string, never>;
      const rows = appendSelectionClipRows({
        baseRows: collectChannelRows(nodes),
        nodes,
        selectedNodeId: id,
      }) as ChannelRowLite[];
      const clipRowsForBone = rows.filter((r) => r.channelId.startsWith(`clip:${child}:`));
      const bakedIds = (['position', 'rotation', 'scale'] as const).map((c) =>
        gltfChannelDagId(asset, child, c),
      );
      const bakedRowsForBone = rows.filter((r) => bakedIds.includes(r.channelId));
      return {
        clipRowCount: clipRowsForBone.length,
        bakedRowCount: bakedRowsForBone.length,
        allIds: rows.map((r) => r.channelId),
      };
    },
    { id: childDagId, child: ANIMATED_CHILD, asset: ASSET_REF },
  );

  console.log(`[P7.12] post-bake row inventory = ${JSON.stringify(rowInventory)}`);
  expect(
    rowInventory.clipRowCount,
    `clip rows for the baked bone must be suppressed (FLAG-3 single row set); ids=${rowInventory.allIds.join(
      ', ',
    )}`,
  ).toBe(0);
  expect(
    rowInventory.bakedRowCount,
    'the baked bone must surface its baked channel rows',
  ).toBeGreaterThan(0);

  const relevant = errors.filter((e) => /gltf|three|skeleton|skin|loader|draco/i.test(e));
  expect(relevant, `unexpected loader/skin console errors: ${relevant.join('\n')}`).toHaveLength(0);
});

test('P7.12 (c) REVERT — deleting the baked channel falls back to the clip on both surfaces; clip rows return', async ({
  page,
}) => {
  await stageSkinnedBar(page);
  const childDagId = await animatedChildDagId(page);

  const tipBaseline = await readVertexAt(page, TIP_VERTEX, 0.5);

  await selectAnimatedBoneRotationRow(page, childDagId);
  await page.getByTestId('timeline-drawer-toggle').click();
  const host = page.getByTestId('timeline-canvas');
  await expect(host).toBeVisible();
  const canvas = host.locator('canvas');
  await expect(canvas).toBeVisible();

  // Bake + edit (same drag as (b)).
  const box = (await canvas.boundingBox())!;
  const { localX, localY } = await rotationRowDiamond(page, childDagId, box.width);
  const startX = box.x + localX;
  const startY = box.y + localY;
  const targetX = box.x + Math.min(localX + (box.width - LABEL_GUTTER_PX) * 0.3, box.width - 6);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(startX + (targetX - startX) * (i / 8), startY);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);

  // The edit changed the rendered vertex (precondition for a meaningful revert).
  const tipEdited = await readVertexAt(page, TIP_VERTEX, 0.5);
  const editDelta = Math.hypot(
    tipEdited[0] - tipBaseline[0],
    tipEdited[1] - tipBaseline[1],
    tipEdited[2] - tipBaseline[2],
  );
  expect(
    editDelta,
    'precondition: the edit must have moved the vertex before revert',
  ).toBeGreaterThan(0.05);

  // REVERT (#121) — via the UI affordance, not a programmatic dispatch. The
  // bone is selected (selectAnimatedBoneRotationRow), so its NPanel inspector
  // shows a "Revert to imported clip" button (the production caller for D3's
  // dispatchRevertGltfChannel — RevertImportedClipConnector). Clicking it is
  // structural + presence-based (R-4): delete the bone's baked node(s) → the
  // resolver finds no baked band → falls through to the clip on BOTH surfaces.
  const revertBtn = page.getByTestId('revert-imported-clip');
  await expect(
    revertBtn,
    'a baked bone inspector must surface the "revert to imported clip" button (#121)',
  ).toBeVisible();
  await revertBtn.click();
  await page.waitForTimeout(120);
  const channelsLeft = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag.getState().state.nodes;
    return Object.values(nodes).filter((n) => n.type.startsWith('KeyframeChannel')).length;
  });
  expect(channelsLeft, 'clicking revert must delete the baked channel node(s)').toBe(0);
  // The button hides itself once the bone is no longer baked (subscribed state).
  await expect(revertBtn, 'the revert button hides after the bone reverts').toBeHidden();

  // RENDER side: the bone plays the ORIGINAL import again — its vertex matches
  // the pre-edit clip baseline.
  const tipReverted = await readVertexAt(page, TIP_VERTEX, 0.5);
  const revertDelta = Math.hypot(
    tipReverted[0] - tipBaseline[0],
    tipReverted[1] - tipBaseline[1],
    tipReverted[2] - tipBaseline[2],
  );

  console.log(
    `[P7.12] revert: baseline=${JSON.stringify(tipBaseline)} edited=${JSON.stringify(
      tipEdited,
    )} reverted=${JSON.stringify(tipReverted)} revertDelta=${revertDelta}`,
  );
  expect(
    revertDelta,
    `after revert the bone did not return to the clip (revertDelta=${revertDelta}); the ` +
      `presence-based fallback (R-4) did not resurface the clip`,
  ).toBeLessThan(1e-4);

  // DISPLAY side: the clip rows return (the baked rows vanished with the node).
  const rows = await page.evaluate(
    async ({ id, child }) => {
      const [{ collectChannelRows }, { appendSelectionClipRows }] = await Promise.all([
        import('/src/timeline/TimelineCanvas.tsx'),
        import('/src/timeline/clipChannelRows.ts'),
      ]);
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag.getState().state.nodes as Record<string, never>;
      const all = appendSelectionClipRows({
        baseRows: collectChannelRows(nodes),
        nodes,
        selectedNodeId: id,
      }) as ChannelRowLite[];
      return all.filter((r) => r.channelId.startsWith(`clip:${child}:`)).length;
    },
    { id: childDagId, child: ANIMATED_CHILD },
  );
  expect(rows, 'after revert the imported clip rows must return for the bone').toBeGreaterThan(0);
});

test('P7.12 (d) EDIT-WHILE-PAUSED — an edit reflects in the render without playing (C2 dirty-check)', async ({
  page,
}) => {
  await stageSkinnedBar(page);
  const childDagId = await animatedChildDagId(page);

  // Pause and pin a probe time; read the pure-clip vertex.
  const tipBefore = await readVertexAt(page, TIP_VERTEX, 0.5);

  await selectAnimatedBoneRotationRow(page, childDagId);
  await page.getByTestId('timeline-drawer-toggle').click();
  const host = page.getByTestId('timeline-canvas');
  await expect(host).toBeVisible();
  const canvas = host.locator('canvas');
  await expect(canvas).toBeVisible();

  // Stay PAUSED at the probe time for the whole edit (never call play()).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().pause();
    w.__basher_time!.getState().setTime(0.5);
  });

  const box = (await canvas.boundingBox())!;
  const { localX, localY } = await rotationRowDiamond(page, childDagId, box.width);
  const startX = box.x + localX;
  const startY = box.y + localY;
  const targetX = box.x + Math.min(localX + (box.width - LABEL_GUTTER_PX) * 0.3, box.width - 6);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(startX + (targetX - startX) * (i / 8), startY);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);

  // Let the scene repaint WITHOUT advancing time (still paused at 0.5). The C2
  // useFrame dirty-check is keyed on the baked-channels map ref, so a paused
  // edit re-applies even though `seconds` did not change.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const tipAfter = await page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!().vertex(i),
    TIP_VERTEX,
  );
  const delta = Math.hypot(
    tipAfter[0] - tipBefore[0],
    tipAfter[1] - tipBefore[1],
    tipAfter[2] - tipBefore[2],
  );

  console.log(
    `[P7.12] paused-edit: before=${JSON.stringify(tipBefore)} after=${JSON.stringify(
      tipAfter,
    )} delta=${delta}`,
  );
  expect(
    delta,
    `a paused edit did not reflect in the render (delta=${delta}); the C2 dirty-check is ` +
      `not keyed on the baked-channels map (edit-while-paused regression)`,
  ).toBeGreaterThan(0.05);
});

test('P7.12 (e) PERF GUARD — bake + edit several bones, commits===0 across 5s playback (NO-NEW-TIME-SUBSCRIPTION, NOT a knee)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await stageSkinnedBar(page);

  // Bake + edit BOTH bones via the timeline path (the most we can on a 2-bone
  // fixture). NOTE (FLAG-2): this asserts the NO-NEW-TIME-SUBSCRIPTION invariant
  // — the function-of-time value shape (V24) keeps the React tree from
  // re-rendering per playback frame. It is NOT a node-count knee measurement:
  // skinned-bar is far too small to exhibit the ~1000-node React-reconciliation
  // knee. The knee is a DESIGN argument (≤3 channel nodes per baked bone) proven
  // by the manual /tmp Fox harness (perf-fox-benchmark.spec.ts), not here.
  await page.getByTestId('timeline-drawer-toggle').click();
  const host = page.getByTestId('timeline-canvas');
  await expect(host).toBeVisible();
  const canvas = host.locator('canvas');
  await expect(canvas).toBeVisible();

  for (const childName of ['Bone0', 'Bone1']) {
    const childDagId = await page.evaluate((cn) => {
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag.getState().state.nodes;
      for (const [id, n] of Object.entries(nodes)) {
        if (n.type === 'GltfChild' && (n.params as { childName?: string }).childName === cn) {
          return id;
        }
      }
      return null;
    }, childName);
    // Bone0 may have no clip track (only Bone1 is animated) — bake whichever
    // bones DO carry a clip; skip the rest. The guard only needs ≥1 baked bone
    // plus the clip-driven bone to populate the no-subscription playback path.
    if (!childDagId) continue;
    await page.evaluate(
      ({ id, cn }) => {
        const w = window as unknown as BasherWindow;
        w.__basher_selection!.getState().select(id);
        w.__basher_timeline_selection!.getState().setActiveChannel(`clip:${cn}:rotation`);
      },
      { id: childDagId, cn: childName },
    );
    const box = (await canvas.boundingBox())!;
    const diamond = await page.evaluate(
      async ({ id, cn, width, gutter, rowH, dia }) => {
        const [{ collectChannelRows }, { appendSelectionClipRows }, { keyframeToRect }] =
          await Promise.all([
            import('/src/timeline/TimelineCanvas.tsx'),
            import('/src/timeline/clipChannelRows.ts'),
            import('/src/timeline/timelineCanvasGeometry.ts'),
          ]);
        const w = window as unknown as BasherWindow;
        const nodes = w.__basher_dag.getState().state.nodes as Record<string, never>;
        const rows = appendSelectionClipRows({
          baseRows: collectChannelRows(nodes),
          nodes,
          selectedNodeId: id,
        }) as ChannelRowLite[];
        const idx = rows.findIndex((r) => r.channelId === `clip:${cn}:rotation`);
        if (idx < 0) return null;
        const trackWidth = Math.max(width - gutter, 0);
        const fromTime = rows[idx].keyframes[0].time;
        const rect = keyframeToRect(fromTime, idx, 0, trackWidth, rowH, dia);
        return { localX: gutter + rect.x + rect.w / 2, localY: idx * rowH + rowH / 2 };
      },
      {
        id: childDagId,
        cn: childName,
        width: box.width,
        gutter: LABEL_GUTTER_PX,
        rowH: ROW_HEIGHT_PX,
        dia: DIAMOND_PX,
      },
    );
    if (!diamond) continue; // no clip row for this bone — nothing to bake
    const startX = box.x + diamond.localX;
    const startY = box.y + diamond.localY;
    const targetX =
      box.x + Math.min(diamond.localX + (box.width - LABEL_GUTTER_PX) * 0.3, box.width - 6);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(startX + (targetX - startX) * (i / 6), startY);
      await page.waitForTimeout(15);
    }
    await page.mouse.up();
    await page.waitForTimeout(80);
  }

  // At least one bone baked.
  const bakedCount = await page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    return Object.values(nodes).filter((n) => n.type.startsWith('KeyframeChannel')).length;
  });
  expect(bakedCount, 'the perf guard needs at least one baked bone').toBeGreaterThan(0);

  // Profile a 5s REAL playback window (rAF Clock drives timeStore.tick).
  const result = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().pause();
    w.__basher_time!.getState().setTime(0);
    await new Promise<void>((r) => setTimeout(r, 200));
    w.__basher_perf!.start();
    w.__basher_time!.getState().play();
    await new Promise<void>((r) => setTimeout(r, 5000));
    w.__basher_time!.getState().pause();
    return w.__basher_perf!.stop();
  });

  console.log(`[P7.12] NO-SUBSCRIPTION GUARD — commits during 5s playback = ${result.commits}`);
  expect(
    result.commits,
    `React committed ${result.commits} times during 5s of playback with baked bones; the ` +
      `function-of-time value shape (V24) must keep the React tree from re-rendering per frame ` +
      `(H48 — a new time subscription was reintroduced in A3/C2). This is the NO-NEW-TIME-` +
      `SUBSCRIPTION invariant, NOT a node-count knee measurement (FLAG-2).`,
  ).toBe(0);
});
