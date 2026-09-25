// #1091 — flatten on a `MaterialOverride` must reach a BAKED mesh, not only the native road.
//
// ── WHY A BAKED MESH THAT CAPTURED A MAP ─────────────────────────────────────────────
//
// Flatten means "ignore what this was made of and draw the override alone". On a baked
// primitive that is almost invisible: its captured spec is a frozen standard material with no
// maps, so a map-aware composition already draws every one of the override's six scalars. The
// difference only shows on a bake that captured something composition keeps — a texture map.
// Applying the child of a clone-road import captures the live material, map included, so that
// is the fixture: `uv-transform-quad.gltf` carries a base-colour texture, and the native
// importer refuses it (KHR_texture_transform), so it arrives on the clone road and its Apply
// bakes.
//
// ── THE FLAG'S STATES, AND THE ONE THIS TIER CANNOT REACH ────────────────────────────
//
// The override is added without naming `ignoreSourceMaterial`, then set true, then false. The
// first step is NOT an absent flag: `addNode` parses params, so the schema's default writes
// `false` before anything draws. A value with the key truly absent comes only from other
// producers of a `MaterialValue`, and `flattens` — the one predicate both roads branch on — is
// held for true, false and absent by `primitiveMaterialInputs.test.ts` (#1076). What this spec
// holds is that the baked road branches on that predicate at all: it fails true if flatten is
// ignored, and fails either composition step if it flattens without being asked. Read on the
// drawn three.js material, the only tier that sees a renderer.
//
// Measured before the fix (same steps): flatten true still drew `MeshStandardMaterial` with
// its map. After: `MeshPhysicalMaterial`, no map, the override's colour.
//
// REF: src/viewport/SceneFromDAG.tsx (`BakedMeshR` → `FlattenedBakedMeshR`),
//      src/app/material/flattenMaterial.ts, tests/e2e/p131-material-flatten.spec.ts (the native
//      half); issues #1091, #1076, #131.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { importedChildren } from './_importedChild';

const ASSET_REF = 'assets/uv-transform-quad.gltf';
const FIXTURE_URL = '/assets/uv-transform-quad.gltf';
const OVR = 'p1091_ovr';
const OVR_COLOR = '#ff8800';

interface DrawnMaterial {
  readonly type: string;
  readonly hasMap: boolean;
  readonly color: string;
}

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; inputs?: Record<string, unknown> }>;
        outputs: { scene?: { node: string } };
      };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
  __basher_three: { getState: () => { scene: unknown } };
  __basher_importGltf: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_writeOpfsBytes: (ref: string, bytes: Uint8Array) => Promise<void>;
  __basher_gltf_meshes?: () => { hasMap: boolean }[];
}

/**
 * The material of every VISIBLE mesh drawn under the top-level scene child named `name` (the pick
 * wrapper's id). #1108 — the bake now stays under the import's Group, and a nested object carries
 * no name (#501), so the spec reads under that Group; the clone it holds keeps the applied child
 * suppressed, which the visibility walk leaves out.
 */
async function drawn(page: Page, name: string): Promise<DrawnMaterial[] | null> {
  return page.evaluate((n) => {
    const scene = (window as unknown as BasherWindow).__basher_three.getState().scene as {
      getObjectByName: (n: string) => { traverse: (f: (o: unknown) => void) => void } | undefined;
    } | null;
    const root = scene?.getObjectByName(n);
    if (!root) return null;
    const out: DrawnMaterial[] = [];
    root.traverse((o) => {
      const m = o as {
        isMesh?: boolean;
        visible: boolean;
        parent: { visible: boolean; parent: unknown } | null;
        material?: { type: string; map?: unknown; color?: { getHexString(): string } };
      };
      if (!m.isMesh || !m.material) return;
      for (let p = m as { visible: boolean; parent: unknown } | null; p; ) {
        if (!p.visible) return;
        p = p.parent as { visible: boolean; parent: unknown } | null;
      }
      out.push({
        type: m.material.type,
        hasMap: Boolean(m.material.map),
        color: m.material.color ? `#${m.material.color.getHexString()}` : '',
      });
    });
    return out;
  }, name);
}

/** The world-space scale each mesh under `name` is drawn at (the length of each matrix axis). */
async function drawnScale(page: Page, name: string): Promise<number[][] | null> {
  return page.evaluate((n) => {
    const scene = (window as unknown as BasherWindow).__basher_three.getState().scene as {
      getObjectByName: (n: string) => { traverse: (f: (o: unknown) => void) => void } | undefined;
    } | null;
    const root = scene?.getObjectByName(n);
    if (!root) return null;
    const out: number[][] = [];
    root.traverse((o) => {
      const m = o as {
        isMesh?: boolean;
        visible: boolean;
        parent: unknown;
        updateWorldMatrix: (p: boolean, c: boolean) => void;
        matrixWorld: { elements: number[] };
      };
      if (!m.isMesh) return;
      for (let p = m as { visible: boolean; parent: unknown } | null; p; ) {
        if (!p.visible) return;
        p = p.parent as { visible: boolean; parent: unknown } | null;
      }
      m.updateWorldMatrix(true, false);
      const e = m.matrixWorld.elements;
      out.push([0, 4, 8].map((i) => Math.hypot(e[i], e[i + 1], e[i + 2])));
    });
    return out;
  }, name);
}

async function setBakedScale(page: Page, id: string, scale: [number, number, number]) {
  await page.evaluate(
    ({ nodeId, v }) => {
      (window as unknown as BasherWindow).__basher_dag
        .getState()
        .dispatch({ type: 'setParam', nodeId, paramPath: 'scale', value: v });
    },
    { nodeId: id, v: scale },
  );
}

async function setFlatten(page: Page, value: boolean) {
  await page.evaluate(
    ({ ovr, v }) => {
      (window as unknown as BasherWindow).__basher_dag
        .getState()
        .dispatch({ type: 'setParam', nodeId: ovr, paramPath: 'ignoreSourceMaterial', value: v });
    },
    { ovr: OVR, v: value },
  );
}

test('#1091: flatten on an override over a baked mesh draws the override alone, and only when true', async ({
  page,
}) => {
  // A whole-test budget, not a per-assertion one: an import staged through OPFS, a live clone,
  // an Apply that writes a baked buffer, then three material remounts. Measured locally at 52 s
  // under load, past the 30 s local default, and the default killed the run mid-poll with every
  // reading so far correct. `slow` triples whichever budget the config sets, so CI keeps its own.
  test.slow();
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_importGltf && w.__basher_three?.getState().scene);
  });

  // Stage the clone-road import: bytes into OPFS where the clone loads them, then the graph.
  await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await (await fetch(url)).arrayBuffer();
      await w.__basher_writeOpfsBytes(ref, new Uint8Array(buf));
      await w.__basher_importGltf(buf, ref);
    },
    { url: FIXTURE_URL, ref: ASSET_REF },
  );
  // Apply reads the LIVE clone, which mounts after the child exists in the graph.
  await page.waitForFunction(() => {
    const f = (window as unknown as BasherWindow).__basher_gltf_meshes;
    const s = f ? f() : [];
    return s.length === 1 && s[0].hasMap;
  });
  const children = await importedChildren(page, ASSET_REF);
  expect(children).toHaveLength(1);

  const applied = (await page.evaluate(async (id) => {
    const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
    return mod.dispatchApplyTransform(id, 'all');
  }, children[0].objectId)) as { ok: boolean; reason?: string; bakedId?: string };
  expect(applied, applied.reason).toMatchObject({ ok: true });
  const bakedId = applied.bakedId!;
  const dataType = await page.evaluate((id) => {
    const nodes = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    const d = (nodes[id].inputs?.data as { node: string } | undefined)?.node;
    return d ? nodes[d].type : null;
  }, bakedId);
  expect(dataType, 'the Apply baked (the subject is the baked road)').toBe('BakedData');

  // #1108 — the bake is held by the import's Group, the top-level node the spec reads under.
  const holder = await page.evaluate((id) => {
    const dag = (window as unknown as BasherWindow).__basher_dag.getState().state;
    const holders = Object.entries(dag.nodes).filter(([, n]) =>
      Object.values(n.inputs ?? {})
        .flat()
        .some((e) => (e as { node?: string } | undefined)?.node === id),
    );
    const sceneKids = (dag.nodes[dag.outputs.scene!.node].inputs?.children ?? []) as {
      node: string;
    }[];
    return holders.map(([key, n]) => ({
      id: key,
      type: n.type,
      topLevel: sceneKids.some((e) => e.node === key),
    }));
  }, bakedId);
  expect(holder, 'one top-level Group holds the bake').toEqual([
    expect.objectContaining({ type: 'Group', topLevel: true }),
  ]);
  const holderId = holder[0].id;

  // Baseline: the bake captured the map.
  await expect
    .poll(() => drawn(page, holderId))
    .toEqual([expect.objectContaining({ hasMap: true })]);

  // Wrap the baked object in an override that does not name the flag (the schema writes false).
  await page.evaluate(
    ({ id, ovr, color, parentId }) => {
      const dag = (window as unknown as BasherWindow).__basher_dag.getState();
      dag.dispatchAtomic(
        [
          {
            type: 'disconnect',
            from: { node: id, socket: 'out' },
            to: { node: parentId, socket: 'children' },
          },
          {
            type: 'addNode',
            nodeId: ovr,
            nodeType: 'MaterialOverride',
            params: { color, roughness: 0.9, metalness: 0 },
          },
          {
            type: 'connect',
            from: { node: id, socket: 'out' },
            to: { node: ovr, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: ovr, socket: 'out' },
            to: { node: parentId, socket: 'children' },
          },
        ],
        'user',
        'e2e wrap baked mesh in override',
      );
    },
    { id: bakedId, ovr: OVR, color: OVR_COLOR, parentId: holderId },
  );

  // UNNAMED (false by default) → composition: the override tints, the captured map survives.
  await expect
    .poll(() => drawn(page, holderId))
    .toEqual([{ type: 'MeshStandardMaterial', hasMap: true, color: OVR_COLOR }]);

  // TRUE → flatten: a new material from the override alone; the captured map is gone.
  await setFlatten(page, true);
  await expect
    .poll(() => drawn(page, holderId))
    .toEqual([{ type: 'MeshPhysicalMaterial', hasMap: false, color: OVR_COLOR }]);

  // #489 — the flattened arm draws the baked Object's scale too, as the captured arm does. It used
  // to keep its own identity-scale copy, so scaling a flattened baked mesh changed nothing on screen.
  const [unscaled] = (await drawnScale(page, holderId)) ?? [];
  expect(unscaled, 'the flattened baked mesh is drawn').toBeTruthy();
  await setBakedScale(page, bakedId, [2, 2, 2]);
  const doubled = unscaled.map((s) => s * 2);
  const near = (got: number[][] | null) =>
    got?.length === 1 && got[0].every((s, i) => Math.abs(s - doubled[i]) < 1e-6);
  await expect.poll(async () => near(await drawnScale(page, holderId))).toBe(true);

  // FALSE → composition again, map restored: the flag is the only lever.
  await setFlatten(page, false);
  await expect
    .poll(() => drawn(page, holderId))
    .toEqual([{ type: 'MeshStandardMaterial', hasMap: true, color: OVR_COLOR }]);
  // …and the captured arm keeps drawing the same scale.
  await expect.poll(async () => near(await drawnScale(page, holderId))).toBe(true);
});
