// #522 / #519 — an animated data param paints through a data-lane operator.
//
// ── WHAT WAS BROKEN, MEASURED BEFORE THE FIX ────────────────────────────────────────
//
// A cube carrying an ORDINARY geometry modifier went static. The write road put the colour
// channel on the base data node, correctly; the render's reach walked ONE edge from the
// Object's `data` input, which since the operator stack moved onto the data lane names the
// TOP of the stack. So the overlay asked the modifier whether it was animated, the answer
// was no, and the Object never even entered the membership set that decides whether the
// overlay mounts at all. The mutator reported success, the channel existed on the right
// node, the dopesheet drew the curve, and the viewport did not move. Nothing was logged.
//
// Measured on this exact pair: with the modifier `#ff0000 → #ff0000`, without it
// `#ff0000 → #0000ff`.
//
// ── WHAT THIS PINS, AND WHY EACH ROW IS A DIFFERENT QUESTION ────────────────────────
//
// 1. THE CONTROL. No operator: the channel paints. If this ever fails, the instrument is
//    broken and nothing below means anything — a uniform result across subject and control
//    is the instrument, not the product.
// 2. THE DEFECT. One ordinary modifier, nothing to do with materials: the channel paints.
// 3. THE AGENT'S ROAD END TO END. A forcing material operator, and the agent addressed at
//    the OBJECT: the channel lands on the operator (#519) and paints (#522). Neither half
//    alone is visible — with the write road fixed and the render road not, this still
//    showed the operator's colour.
// 4. PRECEDENCE. A channel on the MASKED base does NOT paint while the operator supplies
//    that field, and DOES the moment the operator is muted. This is the same rule the
//    inspector states with its masking label, on the render side: a covered value is a
//    fallback, not the drawn value, and muting the cover restores it.
//
// VACUITY GUARDS: every cube starts at the same base colour and the keyed colour differs
// from both it and the operator's, so a cube that never repainted, repainted from the wrong
// layer, or was never built cannot pass. Row 4 asserts BOTH directions across one mute, so a
// row that simply never paints fails the second half.

import { expect, test } from './_fixtures';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface UiWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_mesh_material?: (id: string) => { color: string | null } | null;
  __basher_dispatchMutator?: (
    name: string,
    spec: unknown,
    label?: string,
  ) => { ok: boolean; reason?: string };
}

const BASE = '#ff0000'; // what every data node authors
const FORCED = '#00ff88'; // what the material operator supplies
const KEYED = '#0000ff'; // what the channel holds at every time

/** The colour the viewport is actually drawing for `id`. */
function rendered(page: import('@playwright/test').Page, id: string): Promise<string | null> {
  return page.evaluate(
    (n) => (window as unknown as UiWindow).__basher_mesh_material!(n)?.color ?? null,
    id,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as UiWindow;
    return Boolean(
      w.__basher_dag &&
      w.__basher_mesh_material &&
      w.__basher_dispatchMutator &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });

  // Three cubes, differing only in what stands between the data node and the Object.
  //   plain:  BoxData ─────────────────────▶ Object
  //   mod:    BoxData ─▶ ArrayModifier ────▶ Object
  //   ovr:    BoxData ─▶ MaterialOverrideOp ▶ Object   (forces colour)
  await page.evaluate(
    ({ base, forced }) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      const material = { name: 'inline', base: { color: base } };
      const cube = (data: string, obj: string, x: number): Op[] => [
        {
          type: 'addNode',
          nodeId: data,
          nodeType: 'BoxData',
          params: { size: [1, 1, 1], material },
        },
        { type: 'addNode', nodeId: obj, nodeType: 'Object', params: { position: [x, 0, 0] } },
        {
          type: 'connect',
          from: { node: obj, socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
      ];
      dag.dispatchAtomic(
        [
          ...cube('p522_plain_data', 'p522_plain', -5),
          {
            type: 'connect',
            from: { node: 'p522_plain_data', socket: 'out' },
            to: { node: 'p522_plain', socket: 'data' },
          },
          ...cube('p522_mod_data', 'p522_mod_obj', 0),
          { type: 'addNode', nodeId: 'p522_mod', nodeType: 'ArrayModifier', params: { count: 2 } },
          {
            type: 'connect',
            from: { node: 'p522_mod_data', socket: 'out' },
            to: { node: 'p522_mod', socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: 'p522_mod', socket: 'out' },
            to: { node: 'p522_mod_obj', socket: 'data' },
          },
          ...cube('p522_ovr_data', 'p522_ovr_obj', 5),
          {
            type: 'addNode',
            nodeId: 'p522_ovr',
            nodeType: 'MaterialOverrideOp',
            params: { color: forced },
          },
          {
            type: 'connect',
            from: { node: 'p522_ovr_data', socket: 'out' },
            to: { node: 'p522_ovr', socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: 'p522_ovr', socket: 'out' },
            to: { node: 'p522_ovr_obj', socket: 'data' },
          },
        ],
        'e2e',
        '#522 three cubes, one lane each',
      );
    },
    { base: BASE, forced: FORCED },
  );
});

/** Create a channel through the agent's own road, addressed at the OBJECT — the way a
 *  director's instruction reaches the graph, and the road #519 measured. */
async function keyColour(page: import('@playwright/test').Page, objectId: string): Promise<void> {
  const result = await page.evaluate(
    ({ id, keyed }) =>
      (window as unknown as UiWindow).__basher_dispatchMutator!(
        'mutator.timeline.addChannel',
        {
          target: id,
          paramPath: 'material.base.color',
          valueType: 'color',
          channelId: `${id}_chan`,
          initialKeyframe: { time: 0, value: keyed },
        },
        '#522 key colour',
      ),
    { id: objectId, keyed: KEYED },
  );
  expect(result.ok, result.reason ?? 'the mutator refused').toBe(true);
}

test('#522 CONTROL — with no operator in the lane, a keyed colour paints', async ({ page }) => {
  await expect.poll(() => rendered(page, 'p522_plain')).toBe(BASE);
  await keyColour(page, 'p522_plain');
  await expect.poll(() => rendered(page, 'p522_plain')).toBe(KEYED);
});

test('#522 — an ORDINARY modifier in the lane no longer freezes the colour', async ({ page }) => {
  await expect.poll(() => rendered(page, 'p522_mod_obj')).toBe(BASE);
  await keyColour(page, 'p522_mod_obj');
  // Before the fix this stayed at BASE: the channel was created on the right node and the
  // render never asked that node whether it was animated.
  await expect.poll(() => rendered(page, 'p522_mod_obj')).toBe(KEYED);
});

test('#519 + #522 — keying through a forcing operator lands on it AND paints', async ({ page }) => {
  // The operator supplies the colour, so this is what the viewport shows to begin with.
  await expect.poll(() => rendered(page, 'p522_ovr_obj')).toBe(FORCED);

  await keyColour(page, 'p522_ovr_obj');

  // The write road put the channel on the OPERATOR, in the operator's own flat vocabulary —
  // asserted here rather than only in a unit test, because the two halves are only jointly
  // observable: a correct target with the old render reach still showed FORCED.
  const channel = await page.evaluate(() => {
    const n = (window as unknown as UiWindow).__basher_dag.getState().state.nodes;
    const params = (n['p522_ovr_obj_chan'] as { params?: Record<string, unknown> } | undefined)
      ?.params;
    return `${String(params?.target)}|${String(params?.paramPath)}`;
  });
  expect(channel).toBe('p522_ovr|color');

  await expect.poll(() => rendered(page, 'p522_ovr_obj')).toBe(KEYED);
});

test('#522 — a channel on the MASKED base waits for the operator to be muted', async ({ page }) => {
  // Keyed straight onto the base, which is what the inspector's own base row would do: the
  // row is editable and keyable on purpose, because the value under a cover is a fallback,
  // not dead state.
  await page.evaluate((keyed) => {
    (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p522_base_chan',
          nodeType: 'KeyframeChannelColor',
          params: {
            name: 'base colour',
            target: 'p522_ovr_data',
            paramPath: 'material.base.color',
            keyframes: [{ time: 0, value: keyed, easing: 'cubic' }],
          },
        },
      ],
      'e2e',
      '#522 channel on the masked base',
    );
  }, KEYED);

  // Covered: the operator still supplies the colour, so the curve exists and is not drawn.
  await expect.poll(() => rendered(page, 'p522_ovr_obj')).toBe(FORCED);

  // Remove the cover and the same channel is the answer — no second rule, just the ownership
  // walk giving a different result.
  await page.evaluate(() => {
    (window as unknown as UiWindow).__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: 'p522_ovr', paramPath: 'muted', value: true }],
        'e2e',
        '#522 mute the operator',
      );
  });
  await expect.poll(() => rendered(page, 'p522_ovr_obj')).toBe(KEYED);
});
