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
//   (2) H40 BOUNDARY-PAIR — the rig the evaluator projects and the rig that
//       renders are THE SAME OBJECTS, bone for bone, asserted by the stamped
//       `basherGltfChildId` the two sides share. BOTH sides observed via the
//       `__basher_gltf_skin` seam. This is the trap the prior P7 work hit:
//       verifying only the evaluator, never the render surface.
//
//       🔴 IT USED TO COMPARE NAMES, AND COULD NOT FAIL (#808). The assertion
//       was `sanitize(rendered[i]) === projected[i].name`, run only against
//       `skinned-bar.glb`, whose bones are `Bone0` / `Bone1` — names containing
//       no character either sanitiser touches. On that fixture `sanitize` is a
//       no-op on both sides, so the gate compared a value with itself. And the
//       equality it encoded is FALSE in general: three's GLTFLoader has already
//       REMOVED `:` by the time a bone reaches the render skeleton, while our
//       importer REPLACED it with `_`, so on a Mixamo-named rig the two sides
//       agree on 1 bone of 23 — the one joint with nothing to sanitise. Running
//       today's assertion against such a rig reds.
//
//       The fix is not a better name comparison; there is no function from one
//       spelling to the other (boneNameSpaces.test.ts pins why). It is to assert
//       what actually corresponds. Both sides own the glTF node INDEX: the
//       import derives `nodeNameMap[key]` from it and the renderer stamps the
//       clone object with that same id. Names never enter. The gate now runs
//       against BOTH rigs, and against the Mixamo-named one it asserts that the
//       raw spellings really do differ — so it can never quietly return to
//       comparing a value with itself.
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
  boneChildId: (i: number) => string | null;
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
): Promise<{
  projected: BoneSpecLite[];
  rendered: (string | null)[];
  renderedChildIds: (string | null)[];
  nodeNameMap: Record<string, string>;
}> {
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

    // CONSUMER side: the rendered SkinnedMesh skeleton, read two ways — the raw
    // three.js name (which is NOT ours, and is here only so the gate can prove
    // its fixture actually witnesses the divergence) and the stamped child id
    // (which is the correspondence being asserted).
    const skin = w.__basher_gltf_skin!()!;
    const rendered: (string | null)[] = [];
    const renderedChildIds: (string | null)[] = [];
    for (let i = 0; i < skin.boneCount; i++) {
      rendered.push(skin.boneName(i));
      renderedChildIds.push(skin.boneChildId(i));
    }

    // The map both sides derive from, so the assertion can name the expected id
    // rather than trusting two independent derivations to agree by luck.
    const assetParams = (
      dag.state.nodes[assetId] as { params?: { nodeNameMap?: Record<string, string> } }
    ).params;
    const nodeNameMap = assetParams?.nodeNameMap ?? {};

    return { projected, rendered, renderedChildIds, nodeNameMap };
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

/**
 * The rigs the boundary-pair runs against.
 *
 * `skinned-bar` was the only one, and it is why the gate could not fail: its
 * bones are `Bone0` / `Bone1` / `SkinnedBar`, containing no character either
 * sanitiser touches. It stays, because a rig whose two sides agree letter for
 * letter is still a case worth covering — it just cannot be the ONLY one.
 *
 * The stand-in character is the discriminating fixture (#808 asked for one:
 * "a rig with at least one reserved character in a bone name, generated, not a
 * vendor asset"). It already existed for #850 — 22 of its 23 joints are named
 * `mixamorig:*`, so three.js and our importer disagree about all but `Root`.
 */
const RIGS = [
  {
    label: 'skinned-bar — no reserved characters, both sides spell it the same',
    ref: 'assets/skinned-bar.glb',
    url: '/assets/skinned-bar.glb',
    /** Do the two sides spell at least one bone differently? */
    spellingsDiverge: false,
  },
  {
    label: 'a Mixamo-named stand-in — the two sides disagree on 22 of 23 bones',
    ref: 'fixtures/rig/standin-character.glb',
    url: '/fixtures/rig/standin-character.glb',
    spellingsDiverge: true,
  },
] as const;

for (const rig of RIGS) {
  test(`P7.11 F6a-2 — H40 boundary-pair: the projected rig IS the rendered rig (${rig.label})`, async ({
    page,
  }) => {
    const { gltfAssetId } = await page.evaluate(
      async ({ url, ref }) => {
        const w = window as unknown as BasherWindow;
        const buf = await fetch(url).then((r) => r.arrayBuffer());
        await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
        return w.__basher_importGltf!(buf, ref);
      },
      { url: rig.url, ref: rig.ref },
    );
    await page.waitForFunction(
      () => {
        const w = window as unknown as BasherWindow;
        return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
      },
      { timeout: 15_000 },
    );

    const { projected, rendered, renderedChildIds, nodeNameMap } = await projectAndReadBothSides(
      page,
      gltfAssetId,
    );

    // BOTH sides observed. The render skeleton is in skin.joints[] order, the
    // SAME spine the projection emits, so the pair is index-by-index.
    expect(rendered.length).toBe(projected.length);
    expect(projected.length).toBeGreaterThan(0);

    // THE ASSERTION. Not a name: the stamped child id, which both sides derive
    // from the glTF node INDEX and neither sanitiser can touch. This says the
    // object the renderer is deforming as bone i is the object the DAG addresses
    // as `projected[i].name` — the thing the old name comparison was reaching for
    // and could not express.
    for (let i = 0; i < projected.length; i++) {
      const expectedChildId = nodeNameMap[projected[i].name];
      expect(
        expectedChildId,
        `projected bone ${i} (${projected[i].name}) must be a nodeNameMap key`,
      ).toBeTruthy();
      expect(renderedChildIds[i], `rendered bone ${i} must carry its stamp`).toBe(expectedChildId);
    }

    // AND THE ANTI-VACUITY GUARD, which is the actual subject of #808. A gate
    // whose fixture cannot exhibit the property it names is not a gate. Assert
    // what this rig is FOR, so replacing it with a friendlier one reds here
    // rather than quietly restoring a comparison of a value with itself.
    const differing = projected.filter((b, i) => rendered[i] !== b.name).length;
    if (rig.spellingsDiverge) {
      // Most of them, in fact — every joint whose name carried a colon.
      expect(
        differing,
        'this rig exists BECAUSE the two sides spell bones differently; if they now agree, the fixture has stopped discriminating and the gate is vacuous',
      ).toBeGreaterThan(0);
    } else {
      // Recorded, not asserted as a virtue: on this rig the two spellings agree,
      // which is exactly why it alone proved nothing for eight months.
      expect(differing).toBe(0);
    }
  });
}

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
