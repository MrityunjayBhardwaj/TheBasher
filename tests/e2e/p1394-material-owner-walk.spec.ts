// #1394 — the material-owner walk evaluates the layer under a Material Override to learn which
// texture maps are present. It ran with no evaluator cache from two long-lived readers: the N
// panel's exposed-params memo and the viewport's lane-overlay memo. Put an override on top of the
// "Camera Path + AI Walk" walker's Armature modifier and the layer below is the posed mesh, so
// each run re-did the whole-clip retarget. Both readers now pass the shared UI cache, where the
// viewport already holds that result.
//
// Measured in the dev build (React StrictMode on), each reader reverted alone:
//   N panel uncached   → 2 retargets per selection and per edit of the override, keyed or not;
//   viewport uncached  → 2 per edit, only once the override is keyed (the lane overlay mounts
//                        only for an object in the direct-channel set — hence the keyed round).
// With both fixed every row is 0, so the bar is ZERO: a bar of "at most one" passes some rows
// with a reader still uncached.
//
// What is counted is the retarget itself (`__retargetRunsForTests`), from the action until no
// retarget has run for 15 frames. The positive control proves the scene makes the walk
// expensive: the same walk called with no cache costs a retarget. The override's row in the
// inspector proves the N panel's walk had something to label.

import { expect, test } from './_fixtures';

const OBJ = 'n_nativeObject_843e4bd5';
const OVR = 'p1394_ovr';

interface Win {
  __basher_armature?: { bones: number };
  __basher_selection?: { getState: () => { select: (id: string) => void; clear: () => void } };
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { inputs?: Record<string, { node: string }> }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => unknown;
    };
  };
}

test('the material-owner walk re-uses the retarget the viewport already evaluated', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.route(/:8600\//, (route) => route.abort());
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('basher.lastProjectId');
    } catch {
      /* storage disabled */
    }
  });
  await page.goto('/');
  await page.getByTestId('home-open-example_camera_path_ai_walk').click();
  await page.waitForFunction(
    () => ((window as unknown as Win).__basher_armature?.bones ?? 0) > 10,
    null,
    { timeout: 60_000 },
  );

  // The override goes in through the builder the material stack's "+ Add" calls, so it lands
  // where a director's would: on top of the Armature modifier.
  const below = await page.evaluate(
    async ([obj, ovr]) => {
      const dag = (window as unknown as Win).__basher_dag!;
      const { buildAddMaterialOpOps } = await import('/src/app/operatorStack.ts');
      const base = dag.getState().state.nodes[obj].inputs!.data.node;
      const res = buildAddMaterialOpOps(dag.getState().state, base, 'MaterialOverrideOp', {}, ovr);
      if (!res) return null;
      dag.getState().dispatchAtomic(res.ops, 'e2e', 'add material override');
      return dag.getState().state.nodes[ovr]?.inputs?.target?.node ?? null;
    },
    [OBJ, OVR] as const,
  );
  expect(below, 'the override sits on the Armature modifier').toBe('n_nativeArmatureMod_843e4bd5');

  const control = await page.evaluate(async (obj) => {
    const rc = await import('/src/nodes/RetargetClip.ts');
    const m = await import('/src/app/resolveMaterialFieldOwner.ts');
    const before = rc.__retargetRunsForTests();
    m.resolveMaterialFieldOwners(
      (window as unknown as Win).__basher_dag!.getState().state as never,
      obj,
    );
    return rc.__retargetRunsForTests() - before;
  }, OBJ);
  expect(control, 'the walk with no cache costs a retarget').toBeGreaterThan(0);

  const act = (kind: 'clear' | 'select' | 'edit', arg: string | number | null) =>
    page.evaluate(
      async ([kind, arg, ovr]) => {
        const w = window as unknown as Win;
        const rc = await import('/src/nodes/RetargetClip.ts');
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        for (let i = 0; i < 10; i++) await frame();
        const before = rc.__retargetRunsForTests();
        if (kind === 'clear') w.__basher_selection!.getState().clear();
        if (kind === 'select') w.__basher_selection!.getState().select(arg as string);
        if (kind === 'edit')
          w.__basher_dag!.getState().dispatchAtomic(
            [{ type: 'setParam', nodeId: ovr, paramPath: 'roughness', value: arg }],
            'e2e',
            'edit override',
          );
        let quiet = 0;
        for (let i = 0; i < 180 && quiet < 15; i++) {
          const n = rc.__retargetRunsForTests();
          await frame();
          quiet = rc.__retargetRunsForTests() === n ? quiet + 1 : 0;
        }
        return rc.__retargetRunsForTests() - before;
      },
      [kind, arg, OVR] as const,
    );

  const rows: [string, number][] = [];
  const round = async (phase: string) => {
    for (const rep of [1, 2]) {
      for (const target of [OBJ, OVR]) {
        await act('clear', null);
        rows.push([`${phase}: select ${target} (pass ${rep})`, await act('select', target)]);
        if (rep === 1 && target === OBJ) {
          await expect(page.getByTestId(`inspector-input-${OVR}-roughness`)).toBeVisible();
        }
        rows.push([
          `${phase}: edit the override with ${target} selected (pass ${rep})`,
          await act('edit', 0.2 + rep / 10 + (target === OVR ? 0.3 : 0)),
        ]);
      }
    }
  };
  // The N panel's walk runs for any selection in the lane.
  await round('unkeyed');
  // The viewport's walk runs only for an object in the direct-channel set, so key the
  // override's roughness: that mounts the object's lane overlay, and each edit of the override
  // re-derives its sources.
  await page.evaluate((ovr) => {
    (window as unknown as Win).__basher_dag!.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1394_chan',
          nodeType: 'KeyframeChannelNumber',
          params: {
            name: 'override roughness',
            target: ovr,
            paramPath: 'roughness',
            keyframes: [
              { time: 0, value: 0.2, easing: 'cubic' },
              { time: 1, value: 0.8, easing: 'cubic' },
            ],
          },
        },
      ],
      'e2e',
      'key the override',
    );
  }, OVR);
  await round('keyed');
  for (const [label, n] of rows) console.log(`[1394] ${label}: ${n} retarget runs`);
  expect(rows.filter(([, n]) => n > 0)).toEqual([]);
});
