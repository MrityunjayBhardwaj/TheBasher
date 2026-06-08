// P7 Animation Authoring — e2e observation gate for the "Animate this"
// director affordance.
//
// Wave D scope (this file): D2 Auto-Key indicator unmissability +
// D4 Auto-Key commit-handler interception.
//
// Wave E scope (this file, appended below — D's tests untouched): the
// PHASE OBSERVATION GATE. Drive the REAL P7 affordance (the Wave C
// inspector diamond → Wave A composite seam — NOT a synthetic setParam,
// NOT a hand-wired raw dispatch) to seed a rotation channel, then assert
// the EVALUATED transform DELTA at the render root over time
// (`__basher_evaluate` → walk render → scene → layer → .target.rotation:
// [0,0,0]@t=0 → [0,180,0]@t=1 → [0,360,0]@t=2). H35 guard: the proof is
// the evaluated numeric delta pre-projection from the DAG — NEVER a
// dopesheet row, a data-*-count, or a pixel-diff. Also asserts
// Scene.children was rewired to the layer's .out by the composite
// addLayer (the direct disproof of the P3#3/H34 orphan topology that
// p3-acceptance.spec.ts:113-127 silently passes on).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_viewport?: { getState: () => { timelineDrawerOpen: boolean } };
  __basher_time?: { getState: () => { setTime: (s: number) => void; seconds: number } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  // The DEV-only evaluate probe (boot.ts:263, inside `if
  // (import.meta.env.DEV)` — Vite-stripped in prod). E1's mandated
  // capability ALREADY EXISTS here with this ctx-based signature and
  // ~15 existing p2/p3 callers; Wave E consumes it rather than
  // regressing the signature. We build the ctx E1 would have inlined:
  // { frame: round(s*60), seconds: s, normalized: 0 }.
  __basher_evaluate?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown; hash: string };
}

// NOTE (E1): the ctx E1's `(nodeId, seconds)` form would have inlined —
// `{ frame: Math.round(s*60), seconds: s, normalized: 0 }` — is built
// inline inside evalRenderRoot's page.evaluate closure (a Playwright
// closure cannot reference an outer-scope helper). 60fps grid per
// timeStore FRAMES_PER_SECOND.

/** All KeyframeChannel* nodes currently in the DAG (the byte-identical /
 *  motion observable — we assert on these, never on a row or count). */
async function channelNodes(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    return Object.entries(nodes)
      .filter(([, n]) => n.type.startsWith('KeyframeChannel'))
      .map(([id, n]) => ({
        id,
        type: n.type,
        target: n.params.target,
        paramPath: n.params.paramPath,
        keyframes: (n.params.keyframes ?? []) as { time: number; value: unknown }[],
      }));
  });
}

async function selectBoxAndOpenTransform(page: import('@playwright/test').Page) {
  // beforeEach puts us in Animate mode where the SceneTree row is not the
  // active surface; drive selection through __basher_selection (mode-
  // independent, the same store driver acceptance.spec.ts:123 uses). The
  // input edit still goes through Playwright .fill() so React's controlled
  // input sees real input/change events (a raw DOM .value set does not).
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_selection);
  });
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_box');
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  // BoxMesh: Mesh is the primary domain; Transform is default-collapsed
  // (§5.8). Position lives in Transform — expand it to reach the input.
  await page.getByTestId('inspector-section-toggle-transform').click();
  await expect(page.getByTestId('inspector-section-body-transform')).toBeVisible();
}

async function editPositionX(page: import('@playwright/test').Page, v: string) {
  // .fill() + Tab dispatches the input/change events React tracks (mirrors
  // acceptance.spec.ts:127-128) — the inspector onChange fires for real,
  // which is exactly the D4 commit chokepoint under test.
  const input = page.getByTestId('inspector-vec-n_box-position-x');
  await expect(input).toBeVisible();
  await input.fill(v);
  await input.press('Tab');
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
    return Boolean(w.__basher_dag && w.__basher_viewport);
  });
  // v0.6 #4: the timeline slot is always mounted; keyframe authoring here is
  // driven through the always-visible inspector diamond, so no drawer-reveal
  // setup is needed. The one test that checks the dopesheet row opens the
  // drawer itself.
});

test.describe('P7 D2 — Auto-Key indicator is unmissable (footgun mitigation)', () => {
  test('OFF by default: no record-armed treatment', async ({ page }) => {
    const bar = page.getByTestId('timebar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-autokey', 'off');
    // The dot exists but is the hollow idle ring — NOT the armed filled dot.
    const dot = page.getByTestId('autokey-dot');
    await expect(dot).not.toHaveClass(/bg-record/);
    await expect(page.getByTestId('autokey-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('toggle ON → red dot + tinted header, visible across panel focus changes', async ({
    page,
  }) => {
    await page.getByTestId('autokey-toggle').click();

    const bar = page.getByTestId('timebar');
    await expect(bar).toHaveAttribute('data-autokey', 'on');
    // Tinted header treatment present (record-tinted bg + border).
    await expect(bar).toHaveClass(/bg-record\/15/);
    await expect(bar).toHaveClass(/border-record/);
    // Filled, pulsing red record dot.
    const dot = page.getByTestId('autokey-dot');
    await expect(dot).toHaveClass(/bg-record/);
    await expect(dot).toHaveClass(/animate-pulse/);
    await expect(page.getByTestId('autokey-toggle')).toHaveAttribute('aria-pressed', 'true');

    // Move focus into a different panel (the scene tree / inspector area):
    // the indicator must REMAIN — it is global, not focus-scoped.
    await page.getByTestId('timebar-scrub').focus();
    await page.keyboard.press('Tab');
    await expect(bar).toHaveAttribute('data-autokey', 'on');
    await expect(bar).toHaveClass(/bg-record\/15/);
    await expect(dot).toHaveClass(/bg-record/);
  });

  test('toggle OFF again → treatment fully removed', async ({ page }) => {
    const toggle = page.getByTestId('autokey-toggle');
    await toggle.click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');
    await toggle.click();
    const bar = page.getByTestId('timebar');
    await expect(bar).toHaveAttribute('data-autokey', 'off');
    await expect(bar).not.toHaveClass(/bg-record\/15/);
    await expect(page.getByTestId('autokey-dot')).not.toHaveClass(/bg-record/);
  });
});

test.describe('P7 D4 — Auto-Key commit-handler interception (single chokepoint)', () => {
  test('Auto-Key OFF → edit Position creates ZERO channels (byte-identical to pre-P7)', async ({
    page,
  }) => {
    await selectBoxAndOpenTransform(page);
    // Auto-Key is OFF by default — do NOT toggle it.
    expect(await channelNodes(page)).toHaveLength(0);

    await editPositionX(page, '2.5');

    // The raw setParam landed (pre-P7 behaviour) but ZERO KeyframeChannel
    // nodes were created — the seam was never entered. Byte-identical.
    const after = await channelNodes(page);
    expect(after).toHaveLength(0);
    const boxPos = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_dag!.getState().state.nodes['n_box'].params.position;
    });
    expect((boxPos as number[])[0]).toBe(2.5); // raw setParam only
  });

  test('Auto-Key ON → first-key composite then single keyframe on the SAME channel', async ({
    page,
  }) => {
    await selectBoxAndOpenTransform(page);
    await page.getByTestId('autokey-toggle').click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');

    // Scrub to frame 30 (0.5s @ 60fps) and edit Position → first-key
    // composite: a layer + a channel + ONE keyframe at 0.5s.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().setTime(0.5);
    });
    await editPositionX(page, '1');

    let chs = await channelNodes(page);
    expect(chs).toHaveLength(1);
    expect(chs[0].target).toBe('n_box');
    expect(chs[0].paramPath).toBe('position');
    expect(chs[0].keyframes).toHaveLength(1);
    expect(chs[0].keyframes[0].time).toBeCloseTo(0.5, 5);
    const channelId = chs[0].id;

    // Scrub to frame 60 (1.0s) and edit again → a SINGLE keyframe
    // appended to the SAME channel (no second layer/channel).
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().setTime(1.0);
    });
    await editPositionX(page, '3');

    chs = await channelNodes(page);
    expect(chs).toHaveLength(1); // still ONE channel
    expect(chs[0].id).toBe(channelId); // the SAME channel
    expect(chs[0].keyframes).toHaveLength(2);
    const times = chs[0].keyframes.map((k) => k.time).sort((a, b) => a - b);
    expect(times[0]).toBeCloseTo(0.5, 5);
    expect(times[1]).toBeCloseTo(1.0, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wave E — the PHASE OBSERVATION GATE (D-04). Not deferrable. THIS green
// = the phase GOAL met. Closes the P3#3 / H34 coverage gap by asserting
// the EVALUATED rotation DELTA at the render root — never a row/count.
// ─────────────────────────────────────────────────────────────────────

/** Walk the evaluated render root → scene → the AnimationLayer wrapping
 *  our cube → its patched target's rotation. Pure observation of the DAG
 *  via the evaluator's input-binding-only walk (evaluator.ts:97-113 —
 *  the H34 reachability semantics). Returns the rotation vec3 AND the
 *  scene.children kinds (to prove the composite addLayer rewired
 *  Scene.children to the layer's .out, NOT the raw box — the direct
 *  disproof of the P3#3 orphan topology). */
async function evalRenderRoot(page: import('@playwright/test').Page, seconds: number) {
  return page.evaluate(
    ({ s }) => {
      const w = window as unknown as BasherWindow;
      const dag = w.__basher_dag!.getState() as unknown as {
        state: { outputs: { render?: { node: string; socket: string } } };
      };
      const renderRoot = dag.state.outputs.render;
      if (!renderRoot) throw new Error('no outputs.render in DAG state');
      const frame = Math.round(s * 60);
      const out = w.__basher_evaluate!(renderRoot.node, {
        time: { frame, seconds: s, normalized: 0 },
      }).value as {
        kind: string;
        scene?: { kind: string; children: Array<Record<string, unknown>> };
      };
      // RenderOutput → { kind:'RenderOutput', scene } ; Scene → { children }.
      const scene = out.scene ?? (out as unknown as { children?: unknown[] });
      const children = (scene as { children: Array<Record<string, unknown>> }).children;
      const layer = children.find((c) => (c as { kind?: string }).kind === 'AnimationLayer') as
        | {
            kind: string;
            sampleTarget?: (sec: number) => { rotation?: [number, number, number] } | null;
          }
        | undefined;
      return {
        // Names of every scene child by kind — proves the rewire.
        sceneChildKinds: children.map((c) => (c as { kind?: string }).kind),
        layerKind: layer?.kind ?? null,
        // P7.12 D-04: sample the function-of-time patched target (was layer.target).
        rotation: layer?.sampleTarget?.(s)?.rotation ?? null,
      };
    },
    { s: seconds },
  );
}

test.describe('P7 E2 — render-root rotation-delta motion gate (D-04, H34/H35/H28-correct)', () => {
  test('REAL affordance seeds a rotation channel; evaluated render-root rotation advances [0,0,0]→[0,180,0]→[0,360,0] and Scene.children is rewired to the layer (orphan topology disproven)', async ({
    page,
  }) => {
    // 1 — Default seed only (n_render.scene←n_scene; n_scene.children←n_box,
    //     default.ts:60-67). Select n_box. NO synthetic setParam, NO raw
    //     dispatch wiring — the topology must come from the affordance.
    await selectBoxAndOpenTransform(page);
    expect(await channelNodes(page)).toHaveLength(0);

    // Pre-condition observation: at this point Scene.children names the
    // RAW box (the orphan-prone default). We will prove the affordance
    // rewires it.
    const before = await evalRenderRoot(page, 0);
    expect(before.layerKind).toBeNull(); // no AnimationLayer yet
    expect(before.sceneChildKinds).not.toContain('AnimationLayer');

    // 2 — Through the REAL Wave C diamond (→ Wave A composite seam):
    //     at frame 0, rotation = [0,0,0]. Click the rotation diamond →
    //     first-key composite (addLayer + addChannel + keyframe). The
    //     composite addLayer performs the full 4-edge splice INCLUDING
    //     the Scene.children rewire automatically (addLayer.ts:95-123).
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().setTime(0);
    });
    const rotDiamond = page.getByTestId('inspector-diamond-n_box-rotation');
    await expect(rotDiamond).toBeVisible();
    await expect(rotDiamond).toHaveAttribute('data-anim-state', 'none');
    await rotDiamond.click();
    // The composite landed: exactly one rotation channel, one key @ t=0.
    await expect.poll(async () => (await channelNodes(page)).length).toBe(1);
    let chs = await channelNodes(page);
    expect(chs[0].target).toBe('n_box');
    expect(chs[0].paramPath).toBe('rotation');
    expect(chs[0].type).toBe('KeyframeChannelVec3');
    expect(chs[0].keyframes).toHaveLength(1);
    expect(chs[0].keyframes[0].time).toBeCloseTo(0, 5);
    expect(chs[0].keyframes[0].value).toEqual([0, 0, 0]);

    // 3 — Enable Auto-Key (the post-#77 REAL affordance for "set a value
    //     at the playhead and key it" — the autokey-toggle precedent at
    //     :194-195). Scrub to t=2s, set rotation Y to 360 via the
    //     inspector vec input (rotation IS a schema'd BoxMesh field —
    //     H28-safe). On an already-animated param with Auto-Key ON the
    //     inspector commit routes through routeAnimatedGrab→autoKeyCommit
    //     (the #77 shared chokepoint) and keys [0,360,0]@t=2 DIRECTLY —
    //     no dead-write, no separate diamond click. (Pre-#77 the OFF edit
    //     silently dead-wrote the box and the re-clicked diamond keyed
    //     that authored value; #77 correctly converts the animated+OFF
    //     edit to a no-op, so the staging — not the asserted contract —
    //     moves to Auto-Key ON. Still the REAL affordance.)
    await page.getByTestId('autokey-toggle').click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().setTime(2);
    });
    const rotY = page.getByTestId('inspector-vec-n_box-rotation-y');
    await expect(rotY).toBeVisible();
    await rotY.fill('360');
    await rotY.press('Tab');
    // With Auto-Key ON the seam keyed [0,360,0] AT the playhead (t=2):
    // a key now exists at the current frame, so the diamond is 'on-key'
    // (a key IS here), NOT 'animated' (animated but off-key). 'on-key'
    // is the strictly stronger proof the REAL affordance keyed via the
    // #77 chokepoint — exactly the contract this test asserts.
    await expect(rotDiamond).toHaveAttribute('data-anim-state', 'on-key');
    await expect
      .poll(async () => {
        const c = await channelNodes(page);
        return c[0]?.keyframes.length ?? 0;
      })
      .toBe(2);
    chs = await channelNodes(page);
    expect(chs).toHaveLength(1); // still ONE channel (same layer/channel)
    const kfTimes = chs[0].keyframes.map((k) => k.time).sort((a, b) => a - b);
    expect(kfTimes[0]).toBeCloseTo(0, 5);
    expect(kfTimes[1]).toBeCloseTo(2, 5);

    // 4 — THE GATE: the evaluated transform DELTA at the RENDER ROOT.
    //     vec3 channels default easing = cubic (smoothstep); at the
    //     midpoint u=0.5, smoothstep(0.5)=0.5 exactly → Y(t=1)=180.
    //     We assert the actual evaluated numbers, the DELTA, and strict
    //     monotonicity — NOT the presence of a dopesheet row (H35).
    const r0 = await evalRenderRoot(page, 0);
    const r1 = await evalRenderRoot(page, 1);
    const r2 = await evalRenderRoot(page, 2);

    // Surface the VERBATIM observed deltas in the test log (the phase
    // GOAL is met only if these real numbers advance).
    console.log(
      `\n[P7.E2 GATE] render-root rotation:` +
        ` t=0 → ${JSON.stringify(r0.rotation)}` +
        ` | t=1 → ${JSON.stringify(r1.rotation)}` +
        ` | t=2 → ${JSON.stringify(r2.rotation)}` +
        ` | Scene.children kinds = ${JSON.stringify(r0.sceneChildKinds)}\n`,
    );

    // 4a — the layer is ON the render-root input-binding path at every t
    //      (proves the splice; orphan wrapper would be absent here).
    expect(r0.layerKind).toBe('AnimationLayer');
    expect(r1.layerKind).toBe('AnimationLayer');
    expect(r2.layerKind).toBe('AnimationLayer');

    // 4b — Scene.children names the AnimationLayer (the layer's .out),
    //      and NOT the raw box. This is the direct disproof of the
    //      P3#3 / H34 orphan topology (which leaves children = raw box
    //      and passes on a row alone). A list-socket double-connect
    //      would show BOTH — assert exactly one child, the layer.
    expect(r0.sceneChildKinds).toEqual(['AnimationLayer']);

    // 4c — THE DELTA: rotation strictly advances 0 → 180 → 360 over
    //      t=0→2s (cubic-eased, smoothstep(0.5)=0.5 → exact 180 @ t=1).
    expect(r0.rotation).toEqual([0, 0, 0]);
    expect(r1.rotation![1]).toBeCloseTo(180, 4);
    expect(r1.rotation![0]).toBeCloseTo(0, 6);
    expect(r1.rotation![2]).toBeCloseTo(0, 6);
    expect(r2.rotation![1]).toBeCloseTo(360, 4);

    // 4d — the DELTA itself (NOT presence): t=1 ≠ t=0, strictly
    //      monotonic increasing on the animated (Y) axis.
    expect(r1.rotation![1]).not.toBe(r0.rotation![1]);
    expect(r1.rotation![1]).toBeGreaterThan(r0.rotation![1]);
    expect(r2.rotation![1]).toBeGreaterThan(r1.rotation![1]);

    // 5 — K13 no-regression OBSERVATION (RESEARCH U2; not new code):
    //     the new channel surfaces a TimelineCanvas row (the canvas data
    //     change rebuilt the static layer — K13 step 3). This is a
    //     no-regression CHECK, NOT the proof of motion (the proof is 4c
    //     above; this row is explicitly NOT asserted as motion — H35).
    await page.getByTestId('timeline-drawer-toggle').click();
    await expect(page.getByTestId('timeline-canvas')).toBeVisible();
  });
});
