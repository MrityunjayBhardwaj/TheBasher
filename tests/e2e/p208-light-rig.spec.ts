// #208 increment 1 — the LightRig node (epic #201, §7.2/§7.5). Observes on the
// LIVE app (Lokayata) that a LightRig wired to `Scene.inputs.lightRig` renders the
// lights it GROUPS as a parallel band to the scene's direct lights, and — the key
// boundary-pair — that a Track-To on a rig light STILL aims it. The aim only fires
// when the renderer recovers the rig light's node id (constraintTargets.has(id)),
// so a passing aim proves `resolveRigLightSources` matched the right id by
// index-correspondence (the same contract the direct lights hold).
//
// FALSIFICATION (guards a vacuous pass): the SAME two lights, grouped by a rig that
// is NOT wired to the scene, render NOTHING — so it's the rig→scene edge that
// brings them in, not a stray direct connection.
//
// PARITY (V37): the offscreen render succeeds with the rig present.
//
// REF: src/nodes/LightRig.ts; src/app/resolveRigLightSources.ts;
//      src/viewport/SceneFromDAG.tsx (the rig render band); vyapti V62/V60/V37.

import { expect, test } from './_fixtures';
import { splitLightOps } from './_splitLight';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface RigWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_three: { getState: () => { scene: ThreeSceneLike | null } };
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
}
interface ThreeSceneLike {
  traverse: (cb: (o: ThreeObjLike) => void) => void;
}
interface ThreeObjLike {
  type: string;
  updateMatrixWorld?: (f?: boolean) => void;
  matrixWorld?: { elements: number[] };
}

function countRectLights(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as RigWindow;
    const scene = w.__basher_three.getState().scene;
    let n = 0;
    scene?.traverse((o) => {
      if ((o as ThreeObjLike).type === 'RectAreaLight') n++;
    });
    return n;
  });
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
    const w = window as unknown as RigWindow;
    return Boolean(
      w.__basher_dag && w.__basher_three && w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('#208 — a LightRig wired to the scene renders its grouped lights; a Track-To still aims one (V60)', async ({
  page,
}) => {
  const before = await countRectLights(page);

  const POS: [number, number, number] = [3, 4, 3];
  const AIM: [number, number, number] = [5, 0, -5];
  const AUTHORED: [number, number, number] = [0, 0, 0];

  // #386 C3: each rig light is split — an Object (pose) + a LightData (shading). The rig
  // groups the OBJECTS, so `resolveRigLightSources`' index-correspondence and the Track-To
  // target below both keep addressing the same ids they did when the lights were fused.
  const rigL1 = splitLightOps({
    objectId: 'rig_l1',
    lightKind: 'Area',
    position: POS,
    shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: AUTHORED },
  });
  const rigL2 = splitLightOps({
    objectId: 'rig_l2',
    lightKind: 'Area',
    position: [-3, 4, 3],
    shading: { intensity: 3, color: '#ffffff', width: 2, height: 2, lookAt: AUTHORED },
  });
  await page.evaluate(
    ({ aim, rigL1, rigL2 }) => {
      const w = window as unknown as RigWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          // Two area lights GROUPED by a rig (not wired to scene.lights directly).
          ...rigL1,
          ...rigL2,
          {
            type: 'addNode',
            nodeId: 'rig_node',
            nodeType: 'LightRig',
            params: { name: 'Key setup' },
          },
          {
            type: 'connect',
            from: { node: 'rig_l1', socket: 'out' },
            to: { node: 'rig_node', socket: 'lights' },
          },
          {
            type: 'connect',
            from: { node: 'rig_l2', socket: 'out' },
            to: { node: 'rig_node', socket: 'lights' },
          },
          // The rig feeds the scene's lightRig input (the active profile).
          {
            type: 'connect',
            from: { node: 'rig_node', socket: 'out' },
            to: { node: sceneId, socket: 'lightRig' },
          },
          // A Track-To aims the FIRST rig light at a fixed point distinct from its authored lookAt.
          {
            type: 'addNode',
            nodeId: 'rig_tt',
            nodeType: 'TrackTo',
            params: { target: 'rig_l1', aimNode: '', aimPoint: aim, up: [0, 1, 0] },
          },
        ],
        'e2e',
        'add light rig',
      );
    },
    { aim: AIM, rigL1, rigL2 },
  );

  // Both grouped lights render through the rig band.
  await page.waitForFunction(
    (prev) => {
      const w = window as unknown as RigWindow;
      const scene = w.__basher_three.getState().scene;
      let n = 0;
      scene?.traverse((o) => {
        if ((o as ThreeObjLike).type === 'RectAreaLight') n++;
      });
      return n >= prev + 2;
    },
    before,
    { timeout: 15_000 },
  );
  expect(await countRectLights(page)).toBe(before + 2);

  // BOUNDARY-PAIR: the Track-To aims rig_l1 — only possible if the renderer
  // recovered rig_l1's node id for the rig-band light (resolveRigLightSources).
  const norm = (v: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const expected = norm([AIM[0] - POS[0], AIM[1] - POS[1], AIM[2] - POS[2]]);
  const authoredDir = norm([AUTHORED[0] - POS[0], AUTHORED[1] - POS[1], AUTHORED[2] - POS[2]]);

  await page.waitForFunction(
    (exp) => {
      const w = window as unknown as RigWindow;
      const scene = w.__basher_three.getState().scene;
      let aimed = false;
      scene?.traverse((o) => {
        const obj = o as ThreeObjLike;
        if (obj.type === 'RectAreaLight' && obj.matrixWorld) {
          obj.updateMatrixWorld?.(true);
          const e = obj.matrixWorld.elements;
          const z: [number, number, number] = [-e[8], -e[9], -e[10]];
          const l = Math.hypot(z[0], z[1], z[2]) || 1;
          const fwd: [number, number, number] = [z[0] / l, z[1] / l, z[2] / l];
          if (
            Math.abs(fwd[0] - exp[0]) < 0.02 &&
            Math.abs(fwd[1] - exp[1]) < 0.02 &&
            Math.abs(fwd[2] - exp[2]) < 0.02
          ) {
            aimed = true;
          }
        }
      });
      return aimed;
    },
    expected,
    { timeout: 15_000 },
  );
  // The constraint overrode the authored lookAt — distinct by construction.
  expect(expected).not.toEqual(authoredDir);

  // PARITY (V37): the offscreen render succeeds with the rig present.
  const out = await page.evaluate(() => {
    const w = window as unknown as RigWindow;
    return w.__basher_render_png!();
  });
  expect(out).not.toBeNull();
  expect(out!.dataUrl.startsWith('data:image/png')).toBe(true);
});

test('#208 — a LightProfileSelect switches the live profile by name (one rig at a time)', async ({
  page,
}) => {
  const before = await countRectLights(page);

  // Two profiles (rigs) co-resident in the DAG; a LightProfileSelect feeds the
  // scene. "Key" has 2 lights, "Rim" has 1 — so the live count tells us which is on.
  // Split area lights (Object + LightData); the rigs group the Objects.
  const al = (id: string, x: number) =>
    splitLightOps({
      objectId: id,
      lightKind: 'Area',
      position: [x, 4, 3],
      shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: [0, 0, 0] },
    });
  const profileLightOps = [...al('key_a', 3), ...al('key_b', -3), ...al('rim_a', 0)];
  await page.evaluate(
    ({ profileLightOps }) => {
      const w = window as unknown as RigWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      const conn = (from: string, to: string, socket: string) => ({
        type: 'connect',
        from: { node: from, socket: 'out' },
        to: { node: to, socket },
      });
      dag.dispatchAtomic(
        [
          ...profileLightOps,
          { type: 'addNode', nodeId: 'rig_key', nodeType: 'LightRig', params: { name: 'Key' } },
          { type: 'addNode', nodeId: 'rig_rim', nodeType: 'LightRig', params: { name: 'Rim' } },
          conn('key_a', 'rig_key', 'lights'),
          conn('key_b', 'rig_key', 'lights'),
          conn('rim_a', 'rig_rim', 'lights'),
          {
            type: 'addNode',
            nodeId: 'profile_sel',
            nodeType: 'LightProfileSelect',
            params: { selectedProfile: 'Key' },
          },
          conn('rig_key', 'profile_sel', 'rigs'),
          conn('rig_rim', 'profile_sel', 'rigs'),
          conn('profile_sel', sceneId, 'lightRig'),
        ],
        'e2e',
        'two profiles + select',
      );
    },
    { profileLightOps },
  );

  // "Key" is live → 2 rig lights render.
  await page.waitForFunction(
    (prev) => {
      const w = window as unknown as RigWindow;
      const scene = w.__basher_three.getState().scene;
      let n = 0;
      scene?.traverse((o) => {
        if ((o as ThreeObjLike).type === 'RectAreaLight') n++;
      });
      return n === prev + 2;
    },
    before,
    { timeout: 15_000 },
  );

  // Switch the live profile to "Rim" (a single param change) → 1 rig light renders.
  await page.evaluate(() => {
    const w = window as unknown as RigWindow;
    const dag = w.__basher_dag.getState();
    dag.dispatchAtomic(
      [{ type: 'setParam', nodeId: 'profile_sel', paramPath: 'selectedProfile', value: 'Rim' }],
      'e2e',
      'switch to Rim',
    );
  });
  await page.waitForFunction(
    (prev) => {
      const w = window as unknown as RigWindow;
      const scene = w.__basher_three.getState().scene;
      let n = 0;
      scene?.traverse((o) => {
        if ((o as ThreeObjLike).type === 'RectAreaLight') n++;
      });
      return n === prev + 1;
    },
    before,
    { timeout: 15_000 },
  );
  expect(await countRectLights(page)).toBe(before + 1);
});

test('#208 — a rig NOT wired to the scene renders nothing (falsification)', async ({ page }) => {
  const before = await countRectLights(page);

  const orphanLightOps = splitLightOps({
    objectId: 'orphan_l1',
    lightKind: 'Area',
    position: [3, 4, 3],
    shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: [0, 0, 0] },
  });
  await page.evaluate(
    ({ orphanLightOps }) => {
      const w = window as unknown as RigWindow;
      const dag = w.__basher_dag.getState();
      // Build the rig + lights but DO NOT connect the rig to scene.lightRig.
      dag.dispatchAtomic(
        [
          ...orphanLightOps,
          {
            type: 'addNode',
            nodeId: 'orphan_rig',
            nodeType: 'LightRig',
            params: { name: 'Unwired' },
          },
          {
            type: 'connect',
            from: { node: 'orphan_l1', socket: 'out' },
            to: { node: 'orphan_rig', socket: 'lights' },
          },
        ],
        'e2e',
        'add unwired rig',
      );
    },
    { orphanLightOps },
  );

  // Give the renderer a beat, then assert the count is unchanged — an unwired rig
  // contributes no lights.
  await page.waitForTimeout(500);
  expect(await countRectLights(page)).toBe(before);
});
