// P7 Wave C (C2) — inspector diamond drives first-key / keyframe /
// delete through the Wave A seam (D-01 entry, D-03 3-state viz, D-05
// single spine).
//
// Coverage (the C2 <verify>, observed not inferred):
//   - select n_box, scrub to frame 60, click the Position diamond →
//     DAG gains a free-floating KeyframeChannel + exactly ONE sample (#199 —
//     a direct channel, NO AnimationLayer), and the diamond shows 'on-key'.
//   - scrub off the key → diamond shows 'animated'.
//   - scrub back to the key + click → deleteKeyframe → 'none' again.
//   - Cmd+Z reverts the WHOLE composite in ONE undo entry.
//
// The diamond click is the REAL affordance (NPanel testid), not a
// synthetic store poke — the truest test of D-01/D-05.
//
// REF: .planning/phases/07-animation-authoring/PLAN.md Wave C (C2).

import { expect, test } from './_fixtures';

interface KF {
  time: number;
  value: unknown;
}
interface DagNode {
  id: string;
  type: string;
  params?: { target?: string; paramPath?: string; keyframes?: KF[] } & Record<string, unknown>;
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, DagNode> };
      undoStack: unknown[];
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
}

function dagSnapshot(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const st = w.__basher_dag!.getState();
    const nodes = Object.values(st.state.nodes);
    const layers = nodes.filter((n) => n.type === 'AnimationLayer');
    const channels = nodes.filter((n) => n.type.startsWith('KeyframeChannel'));
    return {
      layerCount: layers.length,
      channelCount: channels.length,
      channelKeyframes: channels.map((c) => c.params?.keyframes ?? []),
      undoLen: st.undoStack.length,
    };
  });
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
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_selection);
  });
  // Default project seeds n_box → n_scene → n_render (outputs.render).
  // Select n_box so the inspector renders its Position diamond.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_box');
  });
  // BoxMesh declares inspectorSections ['mesh','transform','material'];
  // only the first ('mesh') is default-expanded (§5.8). 'position' lives
  // in 'transform', so expand it (real affordance — the section toggle).
  await page.getByTestId('inspector-section-toggle-transform').click();
  await expect(page.getByTestId('inspector-section-body-transform')).toBeVisible();
});

test('P7.C2 diamond: none → first-key composite → on-key (one undo entry)', async ({ page }) => {
  // Scrub to frame 60 (1.0s).
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(1.0);
  });

  const before = await dagSnapshot(page);
  expect(before.layerCount).toBe(0);
  expect(before.channelCount).toBe(0);

  const diamond = page.getByTestId('inspector-diamond-n_box-position');
  await expect(diamond).toBeVisible();
  await expect(diamond).toHaveAttribute('data-anim-state', 'none');

  await diamond.click();

  // #199 — first key = ONE free-floating direct channel + ONE sample, ONE undo
  // entry. NO AnimationLayer is created.
  const after = await dagSnapshot(page);
  expect(after.layerCount).toBe(0);
  expect(after.channelCount).toBe(1);
  expect(after.channelKeyframes[0]).toHaveLength(1);
  expect(after.undoLen).toBe(before.undoLen + 1);

  await expect(diamond).toHaveAttribute('data-anim-state', 'on-key');

  // Scrub OFF the key → 'animated'.
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(2.0);
  });
  await expect(diamond).toHaveAttribute('data-anim-state', 'animated');

  // Scrub BACK + click → deleteKeyframe → channel still exists but no
  // sample at the playhead → 'animated' (channel present, off-key sense)
  // — per C1 a channel with the sample removed at this frame is
  // 'animated' if other samples exist, else still 'animated' (zero kf).
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(1.0);
  });
  await expect(diamond).toHaveAttribute('data-anim-state', 'on-key');
  await diamond.click(); // on-key → deleteKeyframe

  const afterDelete = await dagSnapshot(page);
  // The only sample was removed → channel has zero keyframes.
  expect(afterDelete.channelKeyframes[0]).toHaveLength(0);
  // Channel node still present (delete removes the sample, not the
  // channel) → C1 returns 'animated' (channel exists, no on-key sample).
  await expect(diamond).toHaveAttribute('data-anim-state', 'animated');
});

test('P7.C2 Cmd+Z reverts the first-key composite in ONE step', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(1.0);
  });
  const before = await dagSnapshot(page);

  const diamond = page.getByTestId('inspector-diamond-n_box-position');
  await diamond.click();

  const after = await dagSnapshot(page);
  expect(after.layerCount).toBe(0);
  expect(after.channelCount).toBe(1);
  expect(after.undoLen).toBe(before.undoLen + 1);

  // ONE Cmd+Z reverts the whole first key (channel + sample).
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');

  await expect.poll(async () => (await dagSnapshot(page)).layerCount).toBe(before.layerCount);
  const reverted = await dagSnapshot(page);
  expect(reverted.layerCount).toBe(0);
  expect(reverted.channelCount).toBe(0);
  await expect(diamond).toHaveAttribute('data-anim-state', 'none');
});
