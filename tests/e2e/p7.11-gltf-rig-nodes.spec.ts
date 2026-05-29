// P7.11 — glTF skeleton → DAG rig nodes (issue #100). The Lokāyata gate.
//
// A dropped skinned glTF character's rig participates in the DAG as a PURE
// read-only `Skeleton` projection (`GltfSkeleton`), deform-faithfully. This
// spec PROVES the headline by OBSERVATION (never by reading the Op log):
//
//   (1) PROJECTION IN-APP — after dropping `skinned-bar.glb`, add a
//       `GltfSkeleton` node, connect the `GltfAsset.out`, and evaluate it.
//       Its output is a real `Skeleton` value with the rig's bones
//       (count + names), produced by the live evaluator (not a unit stub).
//   (2) H40 BOUNDARY-PAIR — the projected `bones[i].name` (PRODUCER side)
//       equals the rendered `SkinnedMesh.skeleton.bones[i].name` (CONSUMER
//       side, sanitized), index-by-index. BOTH sides observed via the
//       `__basher_gltf_skin` seam's `boneName(i)`. This is the trap the prior
//       P7 work hit: verifying only the evaluator, never the render surface.
//   (3) DEFORM-FAITHFUL UNDER PLAYBACK — driving real render time advances the
//       bone-matrix palette: a bone ROTATION delta (H46 — limbs rotate;
//       position is a constant bind offset → exact-zero false-negative) AND a
//       skin-bound VERTEX delta (H45 — channel-agnostic proof the skin moved).
//       The render skeleton the projection mirrors is the SAME one that
//       deforms — so the projection is faithful to what renders.
//
// The cross-vocabulary retarget proof (a foreign-named clip bridged by a
// NON-IDENTITY nameMap, + falsification) is the REQUIRED F6b proof and lives,
// per the plan's allowance, as a pure unit test in
// `src/core/import/retarget.test.ts` (the bridge is pure — a running app adds
// nothing). The plumbing (projection → retarget target) is F5 in
// `projectGltfSkeleton.test.ts`. This e2e owns the OBSERVED projection + H40.
//
// Staging mirrors p7.6/p7.7: the renderer loads bytes from OPFS, so we write
// the fixture bytes to OPFS AND import its structure under the SAME assetRef.
//
// REF: PLAN.md 7.11 Wave F (F6a); CONTEXT D-01/D-02; RESEARCH.md §B1/§B7
// (render skeleton in skin.joints[] order); SceneFromDAG.tsx __basher_gltf_skin
// seam (boneName/boneRotation added in Wave F); H40 boundary-pair; H45/H46.

import { test, expect } from './_fixtures';

const ASSET_REF = 'assets/skinned-bar.glb';
const FIXTURE_URL = '/assets/skinned-bar.glb';
const TIP_VERTEX = 4; // far-end vertex weighted to Bone1 (gen-skinned-fixture.mjs)

interface SkinHandle {
  boneCount: number;
  bound: boolean;
  vertex: (i: number) => [number, number, number];
  boneName: (i: number) => string | null;
  boneRotation: (i: number) => [number, number, number] | null;
}
interface BoneSpecLite {
  name: string;
  parent: number;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string }>; outputs: { scene?: { node: string } } };
      dispatch: (op: unknown) => void;
      dispatchAtomic?: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_evaluate: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown };
  __basher_importGltf?: (
    buffer: ArrayBuffer,
    assetRef: string,
  ) => Promise<{ gltfAssetId: string; transformClipIds: string[] }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinHandle | null;
}

/** sanitizeBoneName parity (threeAdapter.ts:41) — the render side carries the
 *  RAW glTF node name; the projection sanitises `[].:/` → `_`. The H40
 *  boundary-pair compares sanitized-render vs projected. */
function sanitize(name: string): string {
  return name.replace(/[[\].:/]/g, '_');
}

async function stageSkinnedBar(page: import('@playwright/test').Page) {
  await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
    },
    { url: FIXTURE_URL, ref: ASSET_REF },
  );
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    { timeout: 15_000 },
  );
}

/** Add a GltfSkeleton node connected to the dropped GltfAsset's `out`, and
 *  return both the projected bones (evaluator) and the rendered bone names
 *  (seam) so the caller can assert the H40 boundary-pair. */
async function projectAndReadBothSides(
  page: import('@playwright/test').Page,
  gltfAssetId: string,
): Promise<{ projected: BoneSpecLite[]; rendered: (string | null)[] }> {
  return page.evaluate((assetId) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const skelId = 'p711_gltf_skeleton';
    // Add the node + connect the GltfAsset.out → GltfSkeleton.asset in one
    // atomic dispatch (or two sequential dispatches if atomic is unavailable).
    const addOp = {
      type: 'addNode',
      nodeId: skelId,
      nodeType: 'GltfSkeleton',
      params: { skinIndex: 0 },
    };
    const connectOp = {
      type: 'connect',
      from: { node: assetId, socket: 'out' },
      to: { node: skelId, socket: 'asset' },
    };
    if (dag.dispatchAtomic) {
      dag.dispatchAtomic([addOp, connectOp], 'e2e', 'p7.11 add GltfSkeleton');
    } else {
      dag.dispatch(addOp);
      dag.dispatch(connectOp);
    }

    // PRODUCER side: evaluate the GltfSkeleton node.
    const out = w.__basher_evaluate(skelId).value as {
      kind: string;
      bones: { name: string; parent: number }[];
    };
    const projected = out.bones.map((b) => ({ name: b.name, parent: b.parent }));

    // CONSUMER side: the rendered SkinnedMesh skeleton bone names (raw).
    const skin = w.__basher_gltf_skin!()!;
    const rendered: (string | null)[] = [];
    for (let i = 0; i < skin.boneCount; i++) rendered.push(skin.boneName(i));

    return { projected, rendered };
  }, gltfAssetId);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_importGltf && w.__basher_writeOpfsBytes && w.__basher_time && w.__basher_evaluate,
    );
  });
});

test('P7.11 F6a-1 — a dropped glTF rig projects bones via a GltfSkeleton node', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  const { gltfAssetId } = await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      return w.__basher_importGltf!(buf, ref);
    },
    { url: FIXTURE_URL, ref: ASSET_REF },
  );
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    { timeout: 15_000 },
  );

  const { projected } = await projectAndReadBothSides(page, gltfAssetId);

  // skinned-bar's skin has 2 joints (Bone0, Bone1) in skin.joints[] = [1,0]
  // order. The projection emits them in that order.
  expect(projected).toHaveLength(2);
  expect(projected.map((b) => b.name)).toEqual(['Bone0', 'Bone1']);
  expect(projected[0].parent).toBe(-1);
  expect(projected[1].parent).toBe(0);

  // No loader / GLTFLoader skin errors during the drop (B12).
  expect(errors.filter((e) => /draco|gltf|skin|skeleton/i.test(e))).toEqual([]);
});

test('P7.11 F6a-2 — H40 boundary-pair: projected bone names == rendered skeleton bone names', async ({
  page,
}) => {
  const { gltfAssetId } = await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      return w.__basher_importGltf!(buf, ref);
    },
    { url: FIXTURE_URL, ref: ASSET_REF },
  );
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    { timeout: 15_000 },
  );

  const { projected, rendered } = await projectAndReadBothSides(page, gltfAssetId);

  // BOTH sides observed. The render skeleton is in skin.joints[] order, the
  // SAME spine the projection emits → index-by-index name equality after
  // sanitising the raw render names (research #6 — the dedup-suffix divergence
  // site; latent here since skinned-bar has unique names).
  expect(rendered.length).toBe(projected.length);
  const renderedSanitized = rendered.map((n) => (n == null ? null : sanitize(n)));
  for (let i = 0; i < projected.length; i++) {
    expect(renderedSanitized[i]).toBe(projected[i].name);
  }
});

test('P7.11 F6a-3 — deform-faithful: bone rotation + skin vertex move under playback', async ({
  page,
}) => {
  await stageSkinnedBar(page);

  // The render skeleton the GltfSkeleton mirrors is the SAME one that deforms.
  // Drive REAL render time (NOT the pure evaluator — Lokāyata) and observe.
  const at = async (seconds: number) =>
    page.evaluate(
      ({ s, tip }) => {
        const w = window as unknown as BasherWindow;
        w.__basher_time!.getState().setTime(s);
        return new Promise<{
          rot: [number, number, number] | null;
          tip: [number, number, number];
        }>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const skin = w.__basher_gltf_skin!()!;
              resolve({ rot: skin.boneRotation(1), tip: skin.vertex(tip) });
            }),
          );
        });
      },
      { s: seconds, tip: TIP_VERTEX },
    );

  const t0 = await at(0);
  const tMid = await at(0.5);

  expect(t0.rot).not.toBeNull();
  expect(tMid.rot).not.toBeNull();

  // H46 — a ROTATION delta on the animated child bone (not position).
  const rotDelta = Math.max(
    ...[0, 1, 2].map((k) => Math.abs((tMid.rot![k] ?? 0) - (t0.rot![k] ?? 0))),
  );
  expect(rotDelta).toBeGreaterThan(1e-3);

  // H45 — a skin-bound VERTEX moved (channel-agnostic proof the skin deformed).
  const vtxDelta = Math.max(...[0, 1, 2].map((k) => Math.abs(tMid.tip[k] - t0.tip[k])));
  expect(vtxDelta).toBeGreaterThan(1e-4);
});
