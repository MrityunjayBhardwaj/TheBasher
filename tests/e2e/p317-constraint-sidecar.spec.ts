// p317 — the camera look-at dropdown must reflect the constraint the camera OBEYS.
//
// The aim band is LAST-WRITER-WINS, so the winner is the TOP of the constraint stack —
// that is what `resolveTrackToTarget` resolves and what the viewport renders. The dropdown
// used to read `trackToForTarget` (the BOTTOM member) and scan for its own first
// `type === 'TrackTo'` match. Identical for a single constraint; but once the Constraints
// panel (#312) let an object carry TWO, the dropdown displayed and re-targeted the LOSER
// while the camera aimed somewhere else. Verified: with this spec's fix reverted, the
// dropdown reads 'n_aimA' while the camera obeys 'n_aimB'.

import { test, expect } from '@playwright/test';

interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { inputs: Record<string, unknown> }>;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
}

test('camera look-at dropdown reflects the WINNING constraint, not the bottom one', async ({
  page,
}) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => !!(window as unknown as W).__basher_dag.getState().state.outputs,
  );

  const camId = await page.evaluate(() => {
    const w = window as unknown as W;
    const st = w.__basher_dag.getState().state;
    const d = (op: unknown) => w.__basher_dag.getState().dispatch(op);
    const sceneId = st.outputs.scene!.node;
    // The PRODUCTION camera hangs off scene.inputs.camera (it is NOT in scene.children).
    const ref = st.nodes[sceneId].inputs.camera as { node: string } | { node: string }[];
    const camId = (Array.isArray(ref) ? ref[0] : ref).node;
    // Two aim targets wired into the scene.
    for (const [id, pos] of [
      ['n_aimA', [10, 0, 0]],
      ['n_aimB', [0, 0, -10]],
    ] as const) {
      d({ type: 'addNode', nodeId: id, nodeType: 'Null', params: { position: pos } });
      d({
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      });
    }
    // TWO constraints on the camera. BOTTOM (order 0) aims at A; TOP (order 5) aims at B.
    // Last-writer-wins ⇒ the camera actually obeys B. A bottom-reading dropdown says A.
    for (const [id, aim, order] of [
      ['n_ttA', 'n_aimA', 0],
      ['n_ttB', 'n_aimB', 5],
    ] as const) {
      d({
        type: 'addNode',
        nodeId: id,
        nodeType: 'TrackTo',
        params: { target: camId, aimNode: aim, aimPoint: [0, 0, 0], up: [0, 1, 0], order },
      });
    }
    w.__basher_selection.getState().select(camId);
    return camId;
  });

  const dropdown = page.getByTestId(`inspector-camera-lookat-${camId}`);
  await expect(dropdown).toBeVisible({ timeout: 10_000 });
  const shown = await dropdown.inputValue();
  console.log('DROPDOWN SHOWS:', shown, '| camera actually obeys the TOP member → n_aimB');
  expect(shown).toBe('n_aimB'); // the WINNER. Pre-#317 this was 'n_aimA' — the loser.
});
