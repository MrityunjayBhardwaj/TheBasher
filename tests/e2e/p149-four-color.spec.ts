// #149 Wave F — the full Blender 4-color field state across inspector diamonds:
// gray (not animated) / green (animated, off-key) / yellow (on-key) / orange
// (edited-but-not-keyed transient, TOP precedence). Orange is FLAG-A's mandatory
// replacement (held-but-not-persisted). Multi-slot (D-149-1): two fields orange
// at once. Orange clears on commit (now a real key) AND on scrub (discarded).

import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_autokey?: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_transient?: { getState: () => { clearAll: () => void } };
}

async function seedTwoBandAnimatedBox(page: import('@playwright/test').Page) {
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
    // V57 — two free-floating direct channels targeting the box (position +
    // rotation). No AnimationLayer wrapper: the box stays its own scene child;
    // overlayChannels drives it.
    for (const [id, paramPath] of [
      ['seed_pos', 'position'],
      ['seed_rot', 'rotation'],
    ] as const) {
      dispatch({
        type: 'addNode',
        nodeId: id,
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: id,
          target: boxId,
          paramPath,
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 2, value: [4, 0, 0], easing: 'linear' },
          ],
        },
      });
    }
  });
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box'),
  );
  await expect(page.getByTestId('inspector')).toBeVisible();
  await openInspectorSection(page, 'transform');
}

const diamond = (page: import('@playwright/test').Page, band: string) =>
  page.getByTestId(`inspector-diamond-n_box-${band}`);

test.describe('#149 four-color field state (Wave F)', () => {
  test('gray / green / yellow + orange precedence + multi-slot + commit/scrub clears', async ({
    page,
  }) => {
    await page.goto('/');
    await seedTwoBandAnimatedBox(page);
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_transient!.getState().clearAll();
      w.__basher_time!.getState().pause();
      const ak = w.__basher_autokey!.getState();
      if (ak.enabled) ak.toggle(); // Auto-Key OFF
    });

    // GRAY — scale is not animated.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_time!.getState().setTime(1),
    );
    await expect(diamond(page, 'scale')).toHaveAttribute('data-anim-state', 'none');

    // YELLOW — at t=0 (a key) the position diamond is on-key.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_time!.getState().setTime(0),
    );
    await expect(diamond(page, 'position')).toHaveAttribute('data-anim-state', 'on-key');

    // GREEN — at t=1 (off-key) the position diamond is animated.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_time!.getState().setTime(1),
    );
    await expect(diamond(page, 'position')).toHaveAttribute('data-anim-state', 'animated');
    await expect(diamond(page, 'position')).not.toHaveAttribute('data-transient', 'true');

    // ORANGE — edit position.x → the position diamond goes transient (orange),
    // regardless of its animated/off-key underlying state (orange wins).
    await page.getByTestId('inspector-vec-n_box-position-x').fill('9');
    await page.getByTestId('inspector-vec-n_box-position-x').press('Tab');
    await expect(diamond(page, 'position')).toHaveAttribute('data-transient', 'true');
    // The orange token is on the rendered glyph.
    await expect(diamond(page, 'position')).toHaveClass(/text-warn/);

    // MULTI-SLOT (D-149-1) — edit rotation.x too → BOTH fields orange at once.
    await page.getByTestId('inspector-vec-n_box-rotation-x').fill('45');
    await page.getByTestId('inspector-vec-n_box-rotation-x').press('Tab');
    await expect(diamond(page, 'rotation')).toHaveAttribute('data-transient', 'true');
    await expect(diamond(page, 'position')).toHaveAttribute('data-transient', 'true');

    // COMMIT — click the position diamond → it keys the transient at t=1 and
    // leaves orange (now a real key → yellow on-key here). Rotation stays orange.
    await diamond(page, 'position').click();
    await expect(diamond(page, 'position')).not.toHaveAttribute('data-transient', 'true');
    await expect(diamond(page, 'position')).toHaveAttribute('data-anim-state', 'on-key');
    await expect(diamond(page, 'rotation')).toHaveAttribute('data-transient', 'true');

    // SCRUB — a frame change discards the remaining rotation transient → no orange.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_time!.getState().setTime(1.5),
    );
    await expect(diamond(page, 'rotation')).not.toHaveAttribute('data-transient', 'true');
  });
});
