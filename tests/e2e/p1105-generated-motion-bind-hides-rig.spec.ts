// #1105 — a motion GENERATED onto a character leaves no second rig standing beside it.
//
// A generated motion's skeleton stands in the scene as an Object (#1078), and when the generate
// road binds the clip to a character, the retarget hides that Object inside the bind's own undo
// entry. The file road already shows this in a browser (`p1056-bare-skeleton-object`, row 4).
// The generate road had only a unit row, which reads the DAG and cannot see what the armature
// band draws — where #1056's size bug hid — and the panel's e2e cannot bind at all: the offline
// stub's three-joint Hips/Spine/Head rig shares no naming with any character.
//
// So this row gives the panel a generator that CAN bind, at the one boundary the app already
// crosses: the motion service at `DEFAULT_MOTIONGEN_URL`. The page's requests there are answered
// with `soma-generated.bvh`, the SOMA fixture the unit row and the somaToMixamo preset are
// pinned against, in the envelope the HTTP client asks for (`?format=json` →
// `{ jobId, bvh, model, unitScale }`). Nothing in the product is replaced: the capability probe,
// the HTTP client, the licence check on the model it reports, the mint, the cook and the bind
// all run as they do against a real Kimodo server.
//
// REF: src/core/motiongen/HttpMotionGenerationCapability.ts (the envelope);
//      src/app/boot.ts `getMotionCapability` (probed lazily, at the first generate);
//      src/agent/mutators/builders/retarget.ts (the hide);
//      src/app/asset/generateMotionAsNode.test.ts ("with a character, the bind hides the Object").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './_fixtures';

interface DagNode {
  type: string;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
  meta?: { hidden?: boolean };
}
interface Win {
  __basher_dag: {
    getState: () => { state: { nodes: Record<string, DagNode> }; undo: () => unknown };
  };
  __basher_importGltf?: (buf: ArrayBuffer, ref: string) => Promise<unknown>;
  __basher_writeOpfsBytes?: (ref: string, bytes: Uint8Array) => Promise<void>;
  __basher_gltf_skin?: () => unknown;
  __basher_armature?: { skeletonObjects: { id: string }[] };
}

const MOTION_SERVICE = 'http://127.0.0.1:8600';
// The org-qualified default the client licence-checks and then requires the service to echo.
const MODEL = 'nvidia/Kimodo-SOMA-RP-v1.1';
const SOMA_BVH = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../public/fixtures/anim/soma-generated.bvh',
  ),
  'utf8',
);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
});

test('a motion generated through the panel onto a character hides its own rig, and one undo shows it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebGL|GPU/i.test(m.text())) {
      errors.push(`${m.text()} @ ${m.location().url}`);
    }
  });

  // The motion service. Counted, so the row cannot pass on the offline stub.
  let generateCalls = 0;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  await page.route(`${MOTION_SERVICE}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(request.url());
    if (url.pathname === '/health') {
      return route.fulfill({ status: 200, headers: cors, json: { ok: true } });
    }
    if (url.pathname === '/generate') {
      generateCalls += 1;
      return route.fulfill({
        status: 200,
        headers: cors,
        json: { jobId: 'j_1105', bvh: SOMA_BVH, model: MODEL, unitScale: 0.01 },
      });
    }
    return route.fulfill({ status: 404, headers: cors, body: 'not part of the contract' });
  });

  // The stand-in character — the bind needs something to choose.
  await page.waitForFunction(
    () => {
      const w = window as unknown as Win;
      return Boolean(w.__basher_dag && w.__basher_importGltf && w.__basher_writeOpfsBytes);
    },
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const ref = 'fixtures/rig/standin-character.glb';
    const buf = await (await fetch(`/${ref}`)).arrayBuffer();
    await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
    await w.__basher_importGltf!(buf, ref);
  });
  await page.waitForFunction(
    () => {
      const w = window as unknown as Win;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    undefined,
    { timeout: 120_000 },
  );

  // The director's gesture: a prompt, through the panel.
  await page.getByTestId('top-toolbar-assets').click();
  await page.getByTestId('generate-kind-motion').click();
  await page.getByTestId('generate-prompt').fill('a figure walks forward');
  await page.getByTestId('generate-submit').click();

  // Landed and bound: a retarget exists once the cook's result reached the bind.
  await page.waitForFunction(
    () =>
      Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).some(
        (n) => n.type === 'RetargetClip',
      ),
    undefined,
    { timeout: 60_000 },
  );

  const landed = await page.evaluate(() => {
    const { nodes } = (window as unknown as Win).__basher_dag.getState().state;
    const ref = (v: unknown) => (v as { node?: string } | undefined)?.node;
    const objectId = Object.keys(nodes).find(
      (id) =>
        nodes[id].type === 'Object' && nodes[ref(nodes[id].inputs.data) ?? '']?.type === 'Skeleton',
    );
    return {
      producers: Object.values(nodes).filter((n) => n.type === 'MotionGenerate').length,
      retargets: Object.values(nodes).filter((n) => n.type === 'RetargetClip').length,
      objectId,
      hidden: objectId ? nodes[objectId].meta?.hidden === true : null,
    };
  });
  // The generate road, answered by the service — not a dropped file, not the offline stub.
  expect(generateCalls, 'the panel never reached the motion service').toBe(1);
  expect(landed.producers).toBe(1);
  // The bind happened — otherwise a hidden-or-not reading below says nothing about binding.
  expect(landed.retargets).toBe(1);
  // The generated motion still stands as an Object…
  expect(landed.objectId, 'the generate road stood no Object for the skeleton').toBeDefined();
  // …and the bind hid it, so no second rig stands beside the character.
  expect(landed.hidden).toBe(true);
  // What the armature band DRAWS, not what the DAG says. -1 when the seam was never written: a
  // missing band must not read as "nothing drawn".
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Win).__basher_armature?.skeletonObjects?.length ?? -1,
      ),
    )
    .toBe(0);

  // One undo takes the bind, and with it the hide.
  await page.evaluate(() => (window as unknown as Win).__basher_dag.getState().undo());
  const afterUndo = await page.evaluate((id) => {
    const { nodes } = (window as unknown as Win).__basher_dag.getState().state;
    return {
      retargets: Object.values(nodes).filter((n) => n.type === 'RetargetClip').length,
      exists: Boolean(nodes[id]),
      hidden: nodes[id]?.meta?.hidden === true,
    };
  }, landed.objectId!);
  expect(afterUndo).toEqual({ retargets: 0, exists: true, hidden: false });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Win).__basher_armature?.skeletonObjects?.length ?? -1,
      ),
    )
    .toBe(1);

  expect(errors).toEqual([]);
});
