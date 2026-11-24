// #1721 — a generated motion's strip shows stale when its path changes, and Re-cook on the strip
// clears it with one generation call, for that generator only.
//
// Driven through the director's roads: two curves from the Add menu, a motion generated along each
// from the Assets panel, a waypoint moved in the curve's inspector rows, Re-cook pressed on the
// strip in the NLA pane.
//
// 🔴 NO REAL GENERATION. Every request to the motion server's address is answered HERE by a fake
// that synthesises the stub generator's BVH (`synthesiseBvh`, the offline generator's own bytes),
// so a Kimodo server that happens to be running is never reached — the route is matched before the
// network. The fake counts each `/generate` call and keeps its body, which is how "one call, for
// that generator" is asserted.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import {
  STUB_UNIT_SCALE,
  synthesiseBvh,
} from '../../src/core/motiongen/StubMotionGenerationCapability';
import { toolbarControl } from './_toolbar';

// #1952 — works inside the outliner / inspector, so it runs with both panels open (see _fixtures).
test.use({ sidePanels: 'open' });

interface DagNode {
  type: string;
  inputs: Record<string, { node?: string } | undefined>;
  params: Record<string, unknown>;
}
interface Win {
  __basher_dag: { getState: () => { state: { nodes: Record<string, DagNode> } } };
  __basher_selection: { getState: () => { select: (id: string) => void } };
}

const nodesOf = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__basher_dag.getState().state.nodes);
const select = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as Win).__basher_selection.getState().select(i), id);

/** Every `/generate` body the fake answered, in order. */
interface GenerateCall {
  prompt: string;
  seed: number;
  waypoints?: [number, number][];
}

async function fakeMotionServer(page: Page): Promise<GenerateCall[]> {
  const calls: GenerateCall[] = [];
  await page.route(/127\.0\.0\.1:8600\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/health') return route.fulfill({ status: 200, json: { ok: true } });
    if (url.pathname === '/generate') {
      const body = route.request().postDataJSON() as {
        prompt: string;
        model: string;
        seconds: number;
        seed: number;
        waypoints?: [number, number][];
      };
      calls.push({ prompt: body.prompt, seed: body.seed, waypoints: body.waypoints });
      return route.fulfill({
        status: 200,
        json: {
          jobId: `fake-${calls.length}`,
          bvh: synthesiseBvh({
            prompt: body.prompt,
            model: body.model,
            seconds: body.seconds,
            seed: body.seed,
          }),
          model: body.model,
          unitScale: STUB_UNIT_SCALE,
        },
      });
    }
    return route.abort();
  });
  return calls;
}

async function addCurve(page: Page, before: Set<string>): Promise<string> {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+A');
  await expect(page.getByTestId('add-menu')).toBeVisible();
  await page.getByTestId('add-menu-empty').hover();
  await page.getByTestId('add-menu-item-Curve').click();
  await expect(page.getByTestId('add-menu')).toHaveCount(0);
  const nodes = await nodesOf(page);
  return Object.keys(nodes).find((k) => {
    const n = nodes[k];
    const d = n.inputs?.data?.node;
    return !before.has(k) && n.type === 'Object' && !!d && nodes[d]?.type === 'CurveData';
  })!;
}

/** Generate along `curveId` from the Assets panel; resolves to the new producer and clip. */
async function generateAlong(page: Page, curveId: string, prompt: string) {
  const before = new Set(Object.keys(await nodesOf(page)));
  await select(page, curveId);
  if (!(await page.getByTestId('generate-kind-motion').isVisible())) {
    await (await toolbarControl(page, 'top-toolbar-assets')).click();
  }
  await page.getByTestId('generate-kind-motion').click();
  await page.getByTestId('generate-prompt').fill(prompt);
  await page.getByTestId('generate-submit').click();
  await page.waitForFunction(
    (known) =>
      Object.entries((window as unknown as Win).__basher_dag.getState().state.nodes).some(
        ([id, n]) =>
          !known.includes(id) &&
          n.type === 'AnimationClip' &&
          typeof n.params.sourceHash === 'string' &&
          n.params.sourceHash !== '',
      ),
    [...before],
    { timeout: 30_000 },
  );
  const nodes = await nodesOf(page);
  const producer = Object.keys(nodes).find(
    (k) => !before.has(k) && nodes[k].type === 'MotionGenerate',
  )!;
  const clip = Object.keys(nodes).find((k) => !before.has(k) && nodes[k].type === 'AnimationClip')!;
  expect(nodes[producer].inputs.path?.node, 'the generator walks the selected curve').toBe(curveId);
  return { producer, clip };
}

/** The clip's poses as stored — what plays — at a time inside the run. */
const posesJson = (page: Page, clipId: string) =>
  page.evaluate(
    (id) =>
      JSON.stringify(
        (window as unknown as Win).__basher_dag.getState().state.nodes[id].params.poses,
      ),
    clipId,
  );

/** The rigs as DRAWN at `t` seconds, once the frames after the time change have rendered. */
const drawnAt = (page: Page, t: number) =>
  page.evaluate(async (sec) => {
    const w = window as unknown as {
      __basher_time: { getState: () => { setTime: (s: number) => void } };
      __basher_armature?: {
        bones: number;
        matrices: number[][];
        skeletonObjects: { id: string; posed: boolean }[];
      };
    };
    w.__basher_time.getState().setTime(sec);
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    const band = w.__basher_armature!;
    return {
      bones: band.bones,
      posed: band.skeletonObjects.map((o) => o.posed),
      matrices: JSON.stringify(band.matrices.map((m) => m.map((v) => v.toFixed(5)))),
    };
  }, t);

test('dragging a waypoint marks exactly that strip stale, and Re-cook clears it with one generation call', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = await fakeMotionServer(page);

  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Win;
    return Boolean(w.__basher_dag && w.__basher_selection);
  });

  const curveA = await addCurve(page, new Set(Object.keys(await nodesOf(page))));
  const curveB = await addCurve(page, new Set(Object.keys(await nodesOf(page))));
  const a = await generateAlong(page, curveA, 'a figure walks forward');
  const b = await generateAlong(page, curveB, 'a figure runs');
  // One call per generation, each carrying its own curve. The fake answered every one.
  expect(calls.map((c) => c.prompt)).toEqual(['a figure walks forward', 'a figure runs']);
  expect(calls.every((c) => (c.waypoints?.length ?? 0) > 1)).toBe(true);
  const seedA = calls[0].seed;

  // The Assets panel lives in the same drawer, so it is open already; only the tab changes.
  if (!(await page.getByTestId('timeline-tab-nla').isVisible())) {
    await (await toolbarControl(page, 'floating-toolbar-timeline')).click();
  }
  await page.getByTestId('timeline-tab-nla').click();
  await expect(page.getByTestId('nla-pane')).toHaveAttribute('data-active', 'true');
  const stripA = page.getByTestId(`nla-gen-strip-${a.clip}`);
  const stripB = page.getByTestId(`nla-gen-strip-${b.clip}`);
  await expect(stripA).toHaveAttribute('data-stale', 'false');
  await expect(stripB).toHaveAttribute('data-stale', 'false');

  const playingBefore = await posesJson(page, a.clip);
  expect(JSON.parse(playingBefore).length).toBeGreaterThan(0);
  // What is drawn mid-run, and proof that it moves at all (else "unchanged" would prove nothing).
  const drawnStart = await drawnAt(page, 0);
  const drawnBefore = await drawnAt(page, 1);
  expect(drawnBefore.bones).toBeGreaterThan(0);
  expect(drawnBefore.posed).toEqual([true, true]);
  expect(drawnBefore.matrices).not.toBe(drawnStart.matrices);

  // Move waypoint 3 of A's path in the curve's inspector rows — the director's own road.
  await select(page, curveA);
  const x = page.getByTestId('curve-point-2-x');
  await expect(x).toBeVisible();
  const was = Number(await x.inputValue());
  await x.fill(String(was + 1.5));
  await x.press('Enter');

  // Exactly A goes stale, in amber; B does not.
  await expect(stripA).toHaveAttribute('data-stale', 'true');
  await expect(stripA).toHaveAttribute('data-stale-because', 'inputs');
  await expect(stripB).toHaveAttribute('data-stale', 'false');
  await expect(stripA).toHaveCSS('border-top-color', 'rgb(224, 168, 58)');
  await expect(page.getByTestId(`nla-gen-status-${a.clip}`)).toHaveText('stale · inputs changed');
  // The old take still plays — nothing jumped — and the edit asked the server for nothing.
  expect(await posesJson(page, a.clip)).toBe(playingBefore);
  expect((await drawnAt(page, 1)).matrices).toBe(drawnBefore.matrices);
  await drawnAt(page, 0);
  expect(calls).toHaveLength(2);
  await page.screenshot({ path: test.info().outputPath('p1721-stale.png') });

  // Now B's path moves too, so BOTH runs are behind: a Re-cook that cooked the scene rather than
  // the strip it sits on would show up here as a second call.
  await select(page, curveB);
  const xb = page.getByTestId('curve-point-1-x');
  await xb.fill(String(Number(await xb.inputValue()) - 1));
  await xb.press('Enter');
  await expect(stripB).toHaveAttribute('data-stale', 'true');
  const bHash = (await nodesOf(page))[b.clip].params.sourceHash;
  expect(calls).toHaveLength(2);

  await page.getByTestId(`nla-gen-recook-${a.clip}`).click();
  await expect(stripA).toHaveAttribute('data-stale', 'false', { timeout: 30_000 });

  // ONE call, for A, keeping its prompt and seed, along the moved path.
  expect(calls).toHaveLength(3);
  expect(calls[2]).toMatchObject({ prompt: 'a figure walks forward', seed: seedA });
  expect(calls[2].waypoints).not.toEqual(calls[0].waypoints);
  // B was not touched: same take, still saying it is behind.
  expect((await nodesOf(page))[b.clip].params.sourceHash).toBe(bHash);
  await expect(stripB).toHaveAttribute('data-stale', 'true');
  await expect(page.getByTestId(`nla-gen-status-${a.clip}`)).toHaveText('up to date');
  await page.screenshot({ path: test.info().outputPath('p1721-recooked.png') });

  // B's own Re-cook: one more call, B's.
  await page.getByTestId(`nla-gen-recook-${b.clip}`).click();
  await expect(stripB).toHaveAttribute('data-stale', 'false', { timeout: 30_000 });
  expect(calls.map((c) => c.prompt).slice(3)).toEqual(['a figure runs']);

  // New seed on B: a different take of the same prompt, one call, B's own.
  await page.getByTestId(`nla-gen-newseed-${b.clip}`).click();
  await expect.poll(() => calls.length, { timeout: 30_000 }).toBe(5);
  expect(calls[4].prompt).toBe('a figure runs');
  expect(calls[4].seed).not.toBe(calls[1].seed);
  await expect(stripB).toHaveAttribute('data-stale', 'false');
  await expect(stripA).toHaveAttribute('data-stale', 'false');

  expect(errors).toEqual([]);
});
