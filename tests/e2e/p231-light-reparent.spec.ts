// #231 Inc 2a.2 — groupable lights, the AUTHORING path. Top-level lights now
// appear in the outliner (parent socket 'lights'); dragging a light row onto a
// Group moves it into the Group's `children` (cross-socket reparent), and dragging
// it back onto the Scene root returns it to `scene.lights` (its rich home band, not
// the generic children band — the kind-aware reparentSocket). Proven on the DAG +
// the rendered world (the light follows the group).
//
// HTML5 DnD driven by dragstart→dragover→drop with ONE shared DataTransfer.

import { expect, test } from './_fixtures';
import type { Page, JSHandle } from '@playwright/test';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: Record<string, { node: string }>;
        nodes: Record<string, { inputs: { children?: { node: string }[]; lights?: { node: string }[] } }>;
      };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_light_world_positions?: () => [number, number, number][];
}

const GRP_ID = 'n_p231r_grp';
const LIGHT_ID = 'n_light'; // the default scene's DirectionalLight

const sceneList = (page: Page, socket: 'children' | 'lights') =>
  page.evaluate((s) => {
    const st = (window as unknown as W).__basher_dag.getState().state;
    const scene = st.nodes[st.outputs.scene.node];
    return ((scene.inputs as Record<string, { node: string }[]>)[s] ?? []).map((r) => r.node);
  }, socket);

const groupChildren = (page: Page) =>
  page.evaluate((g) => {
    const st = (window as unknown as W).__basher_dag.getState().state;
    return (st.nodes[g].inputs.children ?? []).map((r) => r.node);
  }, GRP_ID);

async function dragRowOnto(page: Page, srcId: string, dstId: string) {
  const dt: JSHandle = await page.evaluateHandle(() => new DataTransfer());
  const src = page.locator(`[data-testid="scene-tree-row-${srcId}"]`);
  const dst = page.locator(`[data-testid="scene-tree-row-${dstId}"]`);
  await src.dispatchEvent('dragstart', { dataTransfer: dt });
  await dst.dispatchEvent('dragover', { dataTransfer: dt });
  await dst.dispatchEvent('drop', { dataTransfer: dt });
}

test.describe('#231 Inc 2a.2 — light reparent in the outliner', () => {
  test('a light drags from scene.lights into a Group and back', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), { timeout: 15000 });

    // Add a Group at [5,0,0] wired to scene.children.
    await page.evaluate(
      ({ grpId }) => {
        const w = window as unknown as W;
        const dispatch = (op: unknown) => w.__basher_dag.getState().dispatch(op);
        dispatch({ type: 'addNode', nodeId: grpId, nodeType: 'Group', params: { position: [5, 0, 0] } });
        dispatch({ type: 'connect', from: { node: grpId, socket: 'out' }, to: { node: 'n_scene', socket: 'children' } });
      },
      { grpId: GRP_ID },
    );

    // The default light starts on scene.lights and shows as an outliner row.
    expect(await sceneList(page, 'lights')).toContain(LIGHT_ID);
    await expect(page.locator(`[data-testid="scene-tree-row-${LIGHT_ID}"]`)).toBeVisible();

    // Drag the light onto the Group → moves to group.children, leaves scene.lights.
    await dragRowOnto(page, LIGHT_ID, GRP_ID);
    await expect.poll(() => groupChildren(page)).toContain(LIGHT_ID);
    expect(await sceneList(page, 'lights')).not.toContain(LIGHT_ID);

    // The rendered light now follows the group (world X ≈ group 5 + light local).
    await page.waitForFunction(() => {
      const positions = (window as unknown as W).__basher_light_world_positions?.() ?? [];
      return positions.some((p) => p[0] >= 4.9);
    });

    // Drag it back onto the Scene root → returns to scene.lights (rich band), not children.
    await dragRowOnto(page, LIGHT_ID, 'n_scene');
    await expect.poll(() => sceneList(page, 'lights')).toContain(LIGHT_ID);
    expect(await groupChildren(page)).not.toContain(LIGHT_ID);
  });
});
