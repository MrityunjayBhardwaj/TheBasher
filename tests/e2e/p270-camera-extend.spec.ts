// p270 item 2 (#270) — a keyed CAMERA scalar (fov) honours the extend rule on
// BOTH the render path (activeCamera → __basher_frustum_pose) and the read path
// (__basher_evaluated_param → ch.sample()). Pre-fix the frustum clamped while the
// read cycled (H40 divergence). Post-fix they agree AND cycle.
import { expect, test } from './_fixtures';
import { dataNodeIdOf, objectPosing } from './_seedNodes';

interface CamPose {
  fov: number;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_frustum_pose?: Record<string, CamPose>;
  __basher_evaluated_param?: (
    nodeId: string,
    paramPath: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => unknown;
}

test('camera fov honours cycle-offset extend on render+read', async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag && (window as unknown as W).__basher_time),
  );

  // #387 C4 — this used to find the camera as "the node of type PerspectiveCamera", which
  // no longer exists: a camera is an `Object` posing a `CameraData`, so the finder returned
  // undefined and the channel below was never seeded. Note the shape of that failure — the
  // retired type name appears in a FINDER, not in a construction, so a sweep looking for
  // where retired kinds are BUILT walks straight past it while the spec quietly tests
  // nothing. Asking possession is what makes the question survive the split.
  //
  // The ids then part ways: the channel targets the LENS half, which owns `fov` and is
  // where the app's own routing puts it, while both readings stay on the OBJECT — the
  // frustum seam is keyed by the posed node, and the evaluated-param read reaches across
  // the pair on its own. That asymmetry is the point of the test, not an accident of it.
  const camId = await objectPosing(page, 'CameraData');
  const lensId = await dataNodeIdOf(page, camId);
  await page.evaluate(
    ({ lens }) => {
      const w = window as unknown as W;
      w.__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'tmp270cam_ch',
            nodeType: 'KeyframeChannelNumber',
            params: {
              name: 'fov',
              target: lens,
              paramPath: 'fov',
              keyframes: [
                { time: 0, value: 30, easing: 'linear' },
                { time: 2, value: 60, easing: 'linear' },
              ],
              // #275 — cycle-offset is now a Cycles F-Modifier on the stack.
              modifiers: [
                {
                  type: 'cycles',
                  beforeMode: 'none',
                  afterMode: 'repeat-offset',
                  beforeCycles: 0,
                  afterCycles: 0,
                },
              ],
            },
          },
        ],
        'e2e',
        'tmp270-cam-seed',
      );
    },
    { lens: lensId },
  );

  // t=6: cycle-offset → fov = 30 + 3·(60-30) = 120 (travelled), NOT clamped to 60.
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(6));
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    const pose = w.__basher_frustum_pose;
    return pose && Object.values(pose).some((p) => Math.abs(p.fov - 120) < 1);
  });

  const result = await page.evaluate((id) => {
    const w = window as unknown as W;
    const render = w.__basher_frustum_pose?.[id!]?.fov ?? null; // Side A
    const readRaw = w.__basher_evaluated_param?.(id!, 'fov', ctxAtG(6)) as { value?: unknown }; // Side B
    const read = readRaw && typeof readRaw.value === 'number' ? readRaw.value : null;
    return { render, read };
    function ctxAtG(s: number) {
      return { time: { frame: Math.round(s * 60), seconds: s, normalized: 0 } };
    }
  }, camId);
  expect(result.render, 'render frustum fov cycled').toBeCloseTo(120, 0);
  expect(result.read, 'read fov cycled').toBeCloseTo(120, 0);
  expect(result.render!, 'render == read (H40)').toBeCloseTo(result.read!, 1);

  // FALSIFY: remove the Cycles modifier → hold extrapolation → t=6 clamps to the
  // last key (60) on the render path.
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: 'tmp270cam_ch', paramPath: 'modifiers', value: [] }],
        'e2e',
        'tmp270-hold',
      );
  });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    const pose = w.__basher_frustum_pose;
    return pose && Object.values(pose).some((p) => Math.abs(p.fov - 60) < 1);
  });
  const held = await page.evaluate(
    (id) => (window as unknown as W).__basher_frustum_pose?.[id!]?.fov ?? null,
    camId,
  );
  expect(held, 'hold clamps fov').toBeCloseTo(60, 0);
});
