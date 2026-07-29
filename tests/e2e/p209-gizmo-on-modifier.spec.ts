// #209 — the gizmo on a SELECTED MODIFIER (the last #209 known-limit). A modifier has no
// pose of its own; the OBJECT that wears the stack's result owns it (#415), so the gizmo
// should edit that object's transform when a modifier is selected — dragging moves the
// whole modified result. The selection stays on the modifier (its stack UI + inspector
// params); only the gizmo's transform TARGET redirects.
//
// BOUNDARY-PAIR: selecting a MirrorModifier (a) MOUNTS the gizmo (before the fix it
// was inert — the modifier has no position param) seeded at the OBJECT's transform,
// and (b) a grab writes the OBJECT's `position` param (not the modifier's) → the
// rendered modified mesh moves with it.
//
// REF: src/app/Gizmo.tsx (the targetId redirect via resolveStackObject); vyapti V64;
//      #462; issue #415.

import { expect, test } from './_fixtures';
import { splitSphereDataId, splitSphereOps } from './_splitSphere';
import { modifierChainOps } from './_modifierStack';

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

// #462/#415: the modifier SOURCE is a SPLIT sphere, and the stack sits BETWEEN the
// SphereData and the Object (`SphereData → Mirror → Object`).
//
// ⚠️ #415 REVERSED THE WALK THIS SPEC IS ABOUT, and the reversal is the whole reason the
// case still discriminates. Pre-flip the modifier sat downstream of the Object, so the
// gizmo found the pose by walking DOWN the `target` chain to the base. On the data lane
// walking down lands on the SphereData — which has NO transform at all — so the redirect
// had to reverse and walk UP through `out` to the Object that wears the result.
//
// That is exactly the kind of change an assertion can sleep through, so note what does
// NOT save this spec: (b) asserts the grab writes `nodes[BOX].params.position`, and BOX
// is the Object id BOTH BEFORE AND AFTER the flip — that assertion is constant across the
// transition ([[H218]]). What actually catches a wrong direction is (a): a gizmo pointed
// at the data node finds no `position` param, so it never mounts and the proxy read
// fails. Direction is proven by the MOUNT, not by the write.
//
// The mirror merges 2× the source, whatever the sphere's vert count is; the count is a
// rendezvous marker to locate the rendered mesh, so it is derived at runtime rather
// than hardcoded (the sphere-agnostic form of the old `=== 48`).

/** The modifier's source: a split sphere at x=1 — the Object's transform is what (a)
 *  asserts and (b) moves. The SphereData (`DATA`) is what the modifier's `target` takes. */
const DATA = splitSphereDataId(BOX);
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
    ({ box, mir, ops, chain }) => {
      const w = window as unknown as GizWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(ops as Op[]),
          ...(chain as Op[]),
          // The OBJECT is the scene child — the modifier is a property of it (#415).
          {
            type: 'connect',
            from: { node: box, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'sphere data → mirror → object → scene',
      );
      w.__basher_selection.getState().select(mir); // select the MODIFIER
    },
    {
      box: BOX,
      mir: MIR,
      ops: sphereSource(),
      chain: modifierChainOps({
        objectId: BOX,
        dataId: DATA,
        modifiers: [
          {
            id: MIR,
            nodeType: 'MirrorModifier',
            params: { axis: 'x', offset: 2, muted: false },
          },
        ],
      }),
    },
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
  // OBJECT's transform [1,0,0] — not the modifier (which has no position) and not the
  // SphereData (which has none either). The grab seam only appears once it has mounted,
  // which is what makes this the assertion that catches a wrong walk direction.
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

  // POSSESSION (H218) — the modifier really is on the data lane. Without this, (a) and
  // (b) would both hold on a chain wired the OLD way, and this spec would report that the
  // flip worked while measuring a graph the flip never touched.
  const wiring = await page.evaluate(
    ({ box, mir }) => {
      const nodes = (window as unknown as GizWindow).__basher_dag.getState().state.nodes as Record<
        string,
        { inputs?: Record<string, { node?: string } | undefined> }
      >;
      return {
        modTarget: nodes[mir]?.inputs?.target?.node,
        objectData: nodes[box]?.inputs?.data?.node,
      };
    },
    { box: BOX, mir: MIR },
  );
  expect(wiring).toEqual({ modTarget: DATA, objectData: MIR });

  // (b) A grab writes the OBJECT's position (not the modifier's, and not the data's).
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
