// #422 — a CONSTRAINED split object still renders its data-half animation.
//
// The renderer picks ONE overlay road per object and the constraint branch wins:
// OverlayDispatch returns ConstrainedR before it ever considers DirectChannelsR. So a
// constrained node takes the constraint road exclusively — and that road was missed by
// both data-half reaches (#398 channels, #400 transients), which only ever landed on
// DirectChannelsR. Result: constraining a cube froze its keyframed colour at the base
// value in the viewport while the inspector and every read seam reported it animating.
//
// This is the assertion that did not exist: NOTHING in the suite paired a constraint
// with a data param, which is why three passes over the same axis all missed this road.
//
// Fixture discipline (the vacuous-pass trap): the base colour, the two keyframe values
// and the renderer's grey fallback are FOUR distinct values, so an assertion can never
// pass by colliding with the thing it is meant to exclude. Base #00ff00, keys #ff0000 →
// #0000ff, fallback #808080.

import { expect, test } from './_fixtures';
import { splitCubeOps } from './_splitCube';

const OBJ_ID = 'n_c422';
const DATA_ID = 'n_c422_data';
const BASE_COLOR = '#00ff00'; // never expected once the channel is live
const KEY_A = '#ff0000'; // value at t=0
const KEY_B = '#0000ff'; // value at t=2

interface W {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, unknown>; outputs: Record<string, { node: string }> };
      dispatchAtomic(ops: unknown[], source?: string, description?: string): unknown;
    };
  };
  __basher_time?: { getState(): { pause(): void; setTime(t: number): void } };
  __basher_mesh_material?: (id: string) => { color: string | null; type: string | null } | null;
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForSelector('canvas');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_mesh_material));
}

/** The rendered material colour of `id`, once the mesh exists. */
async function renderedColor(page: import('@playwright/test').Page, id: string) {
  await page.waitForFunction(
    (nodeId) => (window as unknown as W).__basher_mesh_material?.(nodeId)?.color != null,
    id,
  );
  return page.evaluate(
    (nodeId) => (window as unknown as W).__basher_mesh_material!(nodeId)!.color,
    id,
  );
}

async function setTime(page: import('@playwright/test').Page, t: number) {
  await page.evaluate((seconds) => {
    const w = window as unknown as W;
    w.__basher_time!.getState().pause();
    w.__basher_time!.getState().setTime(seconds);
  }, t);
  // one frame for the useFrame overlay to re-apply
  await page.waitForTimeout(120);
}

test('#422: a Track-To constrained split cube still renders its animated material colour', async ({
  page,
}) => {
  await boot(page);

  await page.evaluate(
    ({ ops, objId, dataId, keyA, keyB }) => {
      const w = window as unknown as W;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene.node;
      dag.dispatchAtomic(
        [
          ...ops,
          {
            type: 'connect',
            from: { node: objId, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
          // The colour channel targets the DATA node — that is where material lives.
          {
            type: 'addNode',
            nodeId: 'n_c422_ch',
            nodeType: 'KeyframeChannelColor',
            params: {
              target: dataId,
              paramPath: 'material.base.color',
              keyframes: [
                { time: 0, value: keyA },
                { time: 2, value: keyB },
              ],
            },
          },
          // A Track-To on the OBJECT. aimNode is empty so it aims at a fixed point —
          // enough to put the cube in the constraint set (the whole point: this is what
          // routes it onto ConstrainedR instead of DirectChannelsR).
          {
            type: 'addNode',
            nodeId: 'n_c422_tt',
            nodeType: 'TrackTo',
            params: {
              name: 'tt',
              target: objId,
              aimNode: '',
              aimPoint: [10, 0, 0],
              up: [0, 1, 0],
              mute: false,
            },
          },
        ],
        'e2e',
        '#422 constrained split cube with an animated material',
      );
    },
    {
      ops: splitCubeOps({ objectId: OBJ_ID, dataId: DATA_ID, color: BASE_COLOR }),
      objId: OBJ_ID,
      dataId: DATA_ID,
      keyA: KEY_A,
      keyB: KEY_B,
    },
  );

  await page.waitForFunction(
    (id) => (window as unknown as W).__basher_mesh_world_position?.(id) != null,
    OBJ_ID,
  );

  // t=0 — the channel's first key, NOT the base colour and NOT the grey fallback.
  await setTime(page, 0);
  const atZero = await renderedColor(page, OBJ_ID);
  expect(atZero?.toLowerCase()).toBe(KEY_A);

  // t=2 — it must actually MOVE. Asserting one frame would pass on a value that
  // merely happened to differ from the base; two frames pin that the channel drives it.
  await setTime(page, 2);
  const atTwo = await renderedColor(page, OBJ_ID);
  expect(atTwo?.toLowerCase()).toBe(KEY_B);

  // And never the un-overlaid base — the exact symptom this guards.
  expect(atZero?.toLowerCase()).not.toBe(BASE_COLOR);
  expect(atTwo?.toLowerCase()).not.toBe(BASE_COLOR);
});
