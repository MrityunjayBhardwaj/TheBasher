// #209 — the gizmo on a SELECTED MODIFIER (the last #209 known-limit). A geometry
// modifier inherits its source's transform and renders the modified result there,
// so the gizmo should edit the BASE mesh's transform when a modifier is selected —
// dragging moves the whole modified result. The selection stays on the modifier
// (its stack UI + inspector params); only the gizmo's transform TARGET redirects.
//
// BOUNDARY-PAIR: selecting a MirrorModifier (a) MOUNTS the gizmo (before the fix it
// was inert — the modifier has no position param) seeded at the base's transform,
// and (b) a grab writes the BASE node's `position` param (not the modifier's) → the
// rendered modified mesh moves with it.
//
// REF: src/app/Gizmo.tsx (the targetId redirect via resolveStackBase); vyapti V64; #462.

import { expect, test } from './_fixtures';
import { splitSphereOps } from './_splitSphere';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface GizWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { params: { position?: unknown } }>;
      };
      dispatchAtomic: (ops: Op[], s?: string, l?: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_three: { getState: () => { scene: ThreeSceneLike | null } };
  __basher_modified_vertex_count: (id: string) => number | null;
  __basher_gizmo?: () => { position: [number, number, number] } | null;
  __basher_gizmo_grab?: (
    mode: 'translate' | 'rotate' | 'scale',
    target: [number, number, number],
  ) => void;
}
interface ThreeSceneLike {
  traverse: (cb: (o: ThreeObjLike) => void) => void;
}
interface ThreeObjLike {
  type: string;
  position: { x: number; y: number; z: number };
  geometry?: { attributes?: { position?: { count: number } } };
}

const BOX = 'giz_box';
const MIR = 'giz_mirror';

// #462: the modifier SOURCE is a SPLIT sphere — an Object posed over a SphereData. It
// was a fused `SphereMesh` (put there by #365 Slice 2, when a split Object as a modifier
// target was the still-undecided #377 path), and that node's `evaluate` has thrown since
// the sphere split, so this case failed rather than testing anything.
//
// The retarget SHARPENS what (b) proves. `position` now lives on the Object, one edge
// away from the SphereData that owns the geometry, so `resolveStackBase` has to walk
// modifier → Object and the grab has to land on the pose half. On the fused node both
// halves were the same node, and a redirect to either would have passed identically.
//
// The mirror merges 2× the source, whatever the sphere's vert count is; the count is a
// rendezvous marker to locate the rendered mesh, so it is derived at runtime rather
// than hardcoded (the sphere-agnostic form of the old `=== 48`).

/** The modifier's source: a split sphere at x=1 — the BASE transform (a) asserts and (b)
 *  moves. The Object (`BOX`) is what the modifier's `target` socket takes. */
const sphereSource = () => splitSphereOps({ objectId: BOX, position: [1, 0, 0] });

/** The world-space x of the rendered mirror mesh (its inherited transform), located
 *  by its runtime-derived merged vertex count. */
function mirrorMeshX(
  page: import('@playwright/test').Page,
  mergedCount: number,
): Promise<number | null> {
  return page.evaluate((want) => {
    const w = window as unknown as GizWindow;
    const scene = w.__basher_three.getState().scene;
    let x: number | null = null;
    scene?.traverse((o) => {
      if (o.type === 'Mesh' && o.geometry?.attributes?.position?.count === want) x = o.position.x;
    });
    return x;
  }, mergedCount);
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
  // NOTE: __basher_gizmo / __basher_gizmo_grab don't exist until the gizmo MOUNTS
  // (after a manip-bearing node is selected) — wait for them post-selection, not here.
  await page.waitForFunction(() => {
    const w = window as unknown as GizWindow;
    return Boolean(
      w.__basher_dag &&
      w.__basher_three &&
      w.__basher_selection &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('selecting a modifier mounts the gizmo at the BASE transform; a grab moves the base (and the result)', async ({
  page,
}) => {
  await page.evaluate(
    ({ box, mir, ops }) => {
      const w = window as unknown as GizWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(ops as Op[]),
          {
            type: 'addNode',
            nodeId: mir,
            nodeType: 'MirrorModifier',
            params: { axis: 'x', offset: 2, muted: false },
          },
          {
            type: 'connect',
            from: { node: box, socket: 'out' },
            to: { node: mir, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: mir, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'box → mirror → scene',
      );
      w.__basher_selection.getState().select(mir); // select the MODIFIER
    },
    { box: BOX, mir: MIR, ops: sphereSource() },
  );

  // Wait for the mirror to build, then capture its merged vertex count (2× the
  // sphere source) as the rendezvous marker for locating the rendered mesh.
  await page.waitForFunction(
    (mir) => (window as unknown as GizWindow).__basher_modified_vertex_count(mir) != null,
    MIR,
    { timeout: 15_000 },
  );
  const mergedCount = await page.evaluate(
    (mir) => (window as unknown as GizWindow).__basher_modified_vertex_count(mir)!,
    MIR,
  );

  // (a) The gizmo MOUNTED (it was inert on a modifier before) and seeded at the
  // BASE box's transform [1,0,0] — not the modifier (which has no position). The
  // grab seam itself only appears once the gizmo has mounted.
  await page.waitForFunction(
    () => {
      const w = window as unknown as GizWindow;
      return typeof w.__basher_gizmo_grab === 'function' && w.__basher_gizmo?.() != null;
    },
    undefined,
    { timeout: 10_000 },
  );
  const proxy = await page.evaluate(
    () => (window as unknown as GizWindow).__basher_gizmo!()!.position,
  );
  expect(proxy.map((n) => Math.round(n))).toEqual([1, 0, 0]);

  // (b) A grab writes the BASE node's position (not the modifier's).
  await page.evaluate(() =>
    (window as unknown as GizWindow).__basher_gizmo_grab!('translate', [5, 0, 0]),
  );
  await expect
    .poll(() =>
      page.evaluate(
        (box) =>
          (window as unknown as GizWindow).__basher_dag.getState().state.nodes[box].params.position,
        BOX,
      ),
    )
    .toEqual([5, 0, 0]);
  // The modifier's own params are untouched — the write did NOT land on it.
  const mirParams = await page.evaluate(
    (mir) =>
      (window as unknown as GizWindow).__basher_dag.getState().state.nodes[mir].params.position,
    MIR,
  );
  expect(mirParams).toBeUndefined();

  // …and the rendered modified mesh followed (it inherits the base transform):
  // base moved +4 in x → the mesh's rendered x moved with it.
  await expect.poll(() => mirrorMeshX(page, mergedCount).then((x) => x && Math.round(x))).toBe(5);
});
