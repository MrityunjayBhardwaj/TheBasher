// #149 Wave E — explicit commit. The diamond (per-param) and K (whole transform)
// key the HELD TRANSIENT value (not the stale authored value), the SOURCE params
// stay byte-unchanged (H36), and the transient is released so a re-scrub no longer
// reverts (it is now a real keyframe).

import { expect, test } from './_fixtures';

interface KF {
  time: number;
  value: unknown;
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params?: Record<string, unknown> }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_autokey?: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_transient?: {
    getState: () => {
      set: (n: string, p: string, v: unknown) => void;
      has: (n: string, p: string) => boolean;
    };
  };
}

async function seedWrappedAnimatedBox(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_transient);
  });
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const api = w.__basher_dag!.getState();
    const dispatch = (op: unknown) => api.dispatch(op);
    const nodes = () => w.__basher_dag!.getState().state.nodes;
    const findType = (t: string) => Object.entries(nodes()).find(([, n]) => n.type === t)?.[0];
    const sceneId = findType('Scene');
    if (!sceneId) throw new Error('no Scene');
    const boxId = 'n_box';
    // V57 — a free-floating direct channel targeting the box. No AnimationLayer
    // wrapper: the box stays its own scene child; overlayChannels drives it.
    dispatch({
      type: 'addNode',
      nodeId: 'seed_pos_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: boxId,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [4, 0, 0], easing: 'linear' },
        ],
      },
    });
  });
}

function readState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    const posCh = Object.values(nodes).find(
      (n) =>
        n.type === 'KeyframeChannelVec3' &&
        (n.params as { paramPath?: string })?.paramPath === 'position',
    );
    const animatedBands = ['position', 'rotation', 'scale'].filter((band) =>
      Object.values(nodes).some(
        (n) =>
          n.type.startsWith('KeyframeChannel') &&
          (n.params as { target?: string; paramPath?: string })?.target === 'n_box' &&
          (n.params as { paramPath?: string })?.paramPath === band,
      ),
    );
    return {
      boxParams: JSON.stringify(nodes['n_box']?.params ?? {}),
      posKeyframes: (posCh?.params?.keyframes ?? []) as KF[],
      animatedBands,
      transientHeld: w.__basher_transient!.getState().has('n_box', 'position'),
    };
  });
}

async function setupPausedOffKeyEdit(page: import('@playwright/test').Page) {
  await page.goto('/');
  await seedWrappedAnimatedBox(page);
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().pause();
    w.__basher_time!.getState().setTime(1); // off-key (keys at 0 and 2)
    w.__basher_selection!.getState().select('n_box');
    const ak = w.__basher_autokey!.getState();
    if (ak.enabled) ak.toggle();
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.getByTestId('inspector-section-toggle-transform').click();
  const posX = page.getByTestId('inspector-vec-n_box-position-x');
  await posX.fill('9'); // transient [9, *, *]
  await posX.press('Tab');
  await expect.poll(async () => (await readState(page)).transientHeld).toBe(true);
}

test.describe('#149 commit (Wave E)', () => {
  test('diamond keys the TRANSIENT value; source params unchanged (H36); slot cleared', async ({
    page,
  }) => {
    await setupPausedOffKeyEdit(page);
    const before = await readState(page);

    // Click the position diamond → key the transient at t=1.
    await page.getByTestId('inspector-diamond-n_box-position').click();
    await expect.poll(async () => (await readState(page)).transientHeld).toBe(false);

    const after = await readState(page);
    // A new keyframe at t=1 carrying the TYPED transient value (x=9), not the
    // curve value (x=2). kfCount +1.
    expect(after.posKeyframes.length).toBe(before.posKeyframes.length + 1);
    const atT1 = after.posKeyframes.find((k) => Math.abs(k.time - 1) < 1e-6);
    expect(atT1).toBeTruthy();
    expect((atT1!.value as number[])[0]).toBe(9);
    // H36 — the SOURCE node.params is byte-UNCHANGED (the key lives on the channel).
    expect(after.boxParams).toBe(before.boxParams);
    console.log(
      `[p149 E diamond] kf@1=${JSON.stringify(atT1!.value)} boxUnchanged=${after.boxParams === before.boxParams}`,
    );
  });

  test('K keys the whole transform from transients; persists across scrub', async ({ page }) => {
    await setupPausedOffKeyEdit(page);
    const before = await readState(page);

    // K is gated to Animate mode (the viewport key gesture). Enter it (this also
    // moves focus to the <select> — NOT a typing target, so the key handler runs;
    // pressing from a focused inspector input would be swallowed by the typing
    // guard). Keep n_box selected; no timeline channel is active → the #149
    // whole-transform path fires (not the dopesheet active-channel path).
    await page.getByTestId('floating-toolbar-timeline').click();
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
      // Blur the focused <select> — it is a typing target, so the key handler's
      // typing-guard would otherwise swallow the press.
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press('k');
    await expect.poll(async () => (await readState(page)).transientHeld).toBe(false);

    const after = await readState(page);
    // position keyed at t=1 with the transient x=9; source params unchanged (H36).
    const atT1 = after.posKeyframes.find((k) => Math.abs(k.time - 1) < 1e-6);
    expect(atT1).toBeTruthy();
    expect((atT1!.value as number[])[0]).toBe(9);
    expect(after.boxParams).toBe(before.boxParams);
    // Whole transform: rotation + scale now animated too (first-key composites).
    expect(after.animatedBands).toEqual(expect.arrayContaining(['position', 'rotation', 'scale']));

    // Persists across scrub: leave t=1 and return — the value is a REAL key now,
    // so it does NOT revert (unlike a transient, which would have been discarded).
    const persisted = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().setTime(1.5);
      w.__basher_time!.getState().setTime(1);
      const nodes = w.__basher_dag!.getState().state.nodes;
      const posCh = Object.values(nodes).find(
        (n) =>
          n.type === 'KeyframeChannelVec3' &&
          (n.params as { paramPath?: string })?.paramPath === 'position',
      );
      const kfs = (posCh?.params?.keyframes ?? []) as KF[];
      return kfs.find((k) => Math.abs(k.time - 1) < 1e-6)?.value ?? null;
    });
    expect((persisted as number[])[0]).toBe(9);
    console.log(
      `[p149 E K] bands=${JSON.stringify(after.animatedBands)} persisted=${JSON.stringify(persisted)}`,
    );
  });
});
