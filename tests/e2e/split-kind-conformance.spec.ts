// The split-kind conformance matrix, browser tier — every kind is asked the same two
// questions, and the rows come from the registry-backed descriptor rather than from
// whatever anybody remembered to write a spec for.
//
// WHY ONLY TWO ROADS HERE
// Ten roads make up the matrix. Six of them already have per-kind coverage somewhere in
// this suite — root and nested render (split-light-observation), constraint reach (p422),
// declared sections (p6-w4-inspector-sections) — and the unit tier owns read-equals-render,
// migration, wrong-half write and the channel-path rule. Re-asking those here would either
// duplicate them or require deleting working specs, which is a second blast radius for no
// new coverage. The suite already runs ~110 minutes; the two roads below are the ones with
// nothing sweeping them per kind:
//
//   R5 the TRANSIENT road   — a held (dragged, uncommitted) edit on the DATA half must
//                             repaint the object. #400: it did not, and the resolver was
//                             fine, so nothing outside the viewport could see it.
//   R8 the MANAGEMENT road  — what a management surface OFFERS must equal what it ACCEPTS.
//                             #386: a split light's keyframed intensity lives on its
//                             LightData while the user selects the Object, so an exact-id
//                             enumeration reported "nothing to push down" for an object
//                             that was visibly animating. Zero is a legitimate answer, so
//                             it failed silently.
//
// WHY R5 IS PROBED AT THREE.JS AND NOT AT THE RESOLVER
// `resolveEvaluatedParam` reaches Object→data on its own road. Asserting the transient
// through it would stay green with the viewport's reach deleted — an unfalsifiable test
// that reads like coverage. The only probe that can fail for the right reason is the live
// three.js object. That is why this road is in the browser tier at all.
//
// THE ROW MAY CHOOSE HOW A ROAD ASKS, NEVER WHETHER IT RUNS
// Both roads run for all five kinds. What varies is phrasing: which scene socket the band
// mounts in (which is the band, literally — `SplitBand`'s members ARE the socket names),
// and how the rendered value is read back, since a mesh reports a material colour, a light
// reports an intensity, a curve reports the vertex count of the polyline it draws and a
// camera reports the field of view its frustum is drawn with. There is deliberately no skip
// field and no per-kind early return; a kind that could not answer would have to be
// answered differently, not excluded.
//
// TWO KINDS ANSWER NO, AND THEY ANSWER DIFFERENT ROADS
// The curve's render cannot follow a held edit (#474) and the camera's cannot either, for
// an unrelated reason (#484); the camera additionally refuses push-down altogether (#480).
// Each NO still builds the fixture, still applies the stimulus, and asserts the outcome as
// an EQUALITY against the issue — so the day any of the three is fixed, the row goes red
// and says which one.
//
// REF: src/test-utils/splitKinds.ts (the rows); src/app/objectDataBand.ts (the band rule);
//      src/viewport/SceneFromDAG.tsx (useDataParamTransients / useLightShadingTransients);
//      src/app/nodeChannels.ts + src/timeline/NlaLanePane.tsx + dispatchMutator.ts (R8's
//      two sides); issues #471, #387.

import { test, expect, type Page } from './_fixtures';
import {
  dataIdFor,
  rowDataParams,
  splitOps,
  SPLIT_KINDS,
  SPLIT_KIND_NAMES,
  type SplitKindName,
} from '../../src/test-utils/splitKinds';
import { splitSphereOps } from './_splitSphere';

interface DispatchResult {
  ok: boolean;
  reason?: string;
}

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          {
            type: string;
            params: Record<string, unknown>;
            // #388 — the baked row reads its data id off the EDGE rather than deriving it,
            // because the Apply road mints the pair itself and picks its own fresh data id.
            inputs?: Record<string, { node: string } | undefined>;
          }
        >;
        outputs: { scene?: { node: string } };
      };
      dispatchAtomic: (ops: unknown[], source: string, intent: string) => unknown;
    };
  };
  /** The honest did-it-draw seam — no group fallback, unlike `__basher_mesh_world_position`. */
  __basher_mesh_world_bounds?: (nodeId: string) => number[] | null;
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_transient?: {
    getState: () => {
      set: (nodeId: string, paramPath: string, value: unknown) => void;
      clearAll: () => void;
    };
  };
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_dispatchMutator?: (name: string, spec: unknown, intent: string) => DispatchResult;
  __basher_nlaPushDown?: (targetId: string) => DispatchResult;
}

/**
 * How the RENDERED value of a kind's observable param is read off the live three.js scene.
 *
 * A per-kind table rather than a descriptor field, because these are Playwright-side reads
 * and `splitKinds.ts` is deliberately free of anything browser-shaped — the moment it is
 * not, every spec importing it drags the DAG module graph in.
 *
 * `signature` is whatever quantity the held edit is supposed to move; `expectHeld` says what
 * must become of it, given what it rested at. Three kinds name the value they expect. The
 * curve records that its render cannot follow at all (#474), and the camera that its pose
 * road consults no transient at all (#484) — still answers, still asserted, never a skip.
 * See `HeldExpectation`.
 *
 * Note what none of them do: re-derive the expected value from the param. The curve's
 * vertex count is a function of `resolution` and `closed`, and computing it here would mean
 * re-implementing the sampler inside the test — which is precisely the drift between an
 * instrument and the thing it measures that these roads exist to catch.
 */
interface RenderProbe {
  /** Read the quantity the held edit moves, from the live scene. Null until mounted. */
  signature: (page: Page, objectId: string) => Promise<number | string | null>;
  /** What `signature` must read once the held edit is applied, given its resting value. */
  expectHeld: (resting: number | string) => HeldExpectation;
  /** What the probe measures, for the failure message. */
  what: string;
}

/**
 * What the road expects of a kind once the held edit is applied.
 *
 * `reaches: false` is NOT an opt-out, and the difference matters. The road still runs, still
 * applies the held edit, and still asserts an outcome — the outcome is just that the render
 * does not follow, which is the true answer for that kind today and is recorded against an
 * issue. A skip would render the cell as covered while nothing ran; this renders it as
 * "asked, answered no", and it goes RED the day somebody fixes the gap, which is exactly
 * when the row should be revisited.
 */
type HeldExpectation =
  | { reaches: true; value: number | string }
  | { reaches: false; why: string; issue: string };

/** The colour of the first material under the Object's group — the mesh bands' side A. */
async function materialColor(page: Page, objectId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const scene = (window as unknown as BasherWindow).__basher_three?.getState().scene as {
      getObjectByName: (n: string) => unknown;
    } | null;
    const grp = scene?.getObjectByName(id) as {
      traverse: (f: (o: unknown) => void) => void;
    } | null;
    if (!grp) return null;
    let color: string | null = null;
    grp.traverse((o) => {
      const mesh = o as { isMesh?: boolean; material?: { color?: { getHexString: () => string } } };
      if (color === null && mesh.isMesh && mesh.material?.color) {
        color = `#${mesh.material.color.getHexString()}`;
      }
    });
    return color;
  }, objectId);
}

/** The vertex count of the polyline the curve draws — CurveLineChrome's BufferGeometry. */
async function curveVertexCount(page: Page, objectId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const scene = (window as unknown as BasherWindow).__basher_three?.getState().scene as {
      getObjectByName: (n: string) => unknown;
    } | null;
    const grp = scene?.getObjectByName(id) as {
      traverse: (f: (o: unknown) => void) => void;
    } | null;
    if (!grp) return null;
    let count: number | null = null;
    grp.traverse((o) => {
      const line = o as {
        isLine?: boolean;
        geometry?: { attributes?: { position?: { count?: number } } };
      };
      const n = line.geometry?.attributes?.position?.count;
      if (count === null && line.isLine && typeof n === 'number') count = n;
    });
    return count;
  }, objectId);
}

/**
 * The intensity of the light this row mounted — the light band's side A.
 *
 * The mesh bands wrap their object in a `<group name={nodeId}>`, so a probe can address
 * them by id. The light band does not: `LightKindR` projects straight onto a three.js
 * light with no name, because nothing in the app needed to address one until now. So the
 * row is identified by KIND instead. `LightData` defaults to a Point light and the default
 * project's key light is Directional (default.ts:34), which makes the row's light the only
 * point light in the scene — and if that ever stops being true, the probe returns null and
 * says so rather than silently reading the wrong light's intensity.
 *
 * Deliberately not "the sole non-ambient light": the default project ships one, so that
 * reading would have measured the KEY LIGHT while the row sat there untested.
 */
async function lightIntensity(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const scene = (window as unknown as BasherWindow).__basher_three?.getState().scene as {
      traverse: (f: (o: unknown) => void) => void;
    } | null;
    if (!scene) return null;
    const found: number[] = [];
    scene.traverse((o) => {
      const l = o as { isPointLight?: boolean; intensity?: number };
      if (l.isPointLight && typeof l.intensity === 'number') found.push(l.intensity);
    });
    return found.length === 1 ? found[0] : null;
  });
}

/**
 * The field of view the camera row's FRUSTUM is currently drawn with.
 *
 * The camera band has no mounted object to read the way the others do — the mesh bands
 * traverse a named group's material, the light band finds a three.js light. What the
 * viewport actually draws for a camera node is its frustum gizmo, whose geometry is a pure
 * function of the resolved pose's `fov` (`CameraHelpers.tsx`, perspectiveFrustumSegments),
 * and `CameraHelper` records that pose on `__basher_frustum_pose` keyed by node id — the
 * DEV observation seam #240 added for exactly this question. Reading the seam rather than
 * measuring the LineSegments' extents keeps the test from re-implementing the frustum
 * math, the same reason the curve row counts vertices instead of re-deriving them.
 *
 * MEASURED sensitive, in this order, before the row below was written: with the row built
 * the seam reads 28 — the fixture's base value, and none of 50 (what a freshly minted
 * CameraData holds) or 45 (`DEFAULT_CAMERA_POSE.fov`, what a failed read returns), so the
 * pose road demonstrably reached the DATA half. Seeding the channel moves it to 1. So the
 * probe tracks this row's camera and is not a constant, which is what the negative
 * expectation below needs in order to mean anything.
 */
async function cameraFrustumFov(page: Page, objectId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const w = window as unknown as { __basher_frustum_pose?: Record<string, { fov?: number }> };
    const fov = w.__basher_frustum_pose?.[id]?.fov;
    return typeof fov === 'number' ? fov : null;
  }, objectId);
}

const RENDER_PROBES: Record<SplitKindName, RenderProbe> = {
  box: {
    signature: materialColor,
    expectHeld: () => ({
      reaches: true,
      value: String(SPLIT_KINDS.box.distinctValues[1]).toLowerCase(),
    }),
    what: "the rendered material's base colour",
  },
  sphere: {
    signature: materialColor,
    expectHeld: () => ({
      reaches: true,
      value: String(SPLIT_KINDS.sphere.distinctValues[1]).toLowerCase(),
    }),
    what: "the rendered material's base colour",
  },
  curve: {
    // MEASURED, not assumed: with the channel seeded and a transient applied to `closed`,
    // the drawn polyline stayed at 65 vertices. `ObjectR` renders the curve from
    // `data.samples`, which `CurveData.evaluate()` bakes out of closed/resolution/points —
    // so an overlay writes `data.closed`, a field the renderer never reads. The curve is
    // the one kind with NO data param that survives to its render verbatim, which is the
    // same property that made `closed` the only sound choice for the read-equals-render
    // road, showing up here with the opposite sign.
    signature: curveVertexCount,
    expectHeld: () => ({
      reaches: false,
      why:
        'every input the curve renderer reads is derived at evaluate time (`samples` is ' +
        'baked from closed/resolution/points), so a transient cannot reach it',
      issue: '#474',
    }),
    what: 'the vertex count of the polyline the viewport draws',
  },
  light: {
    signature: lightIntensity,
    expectHeld: () => ({ reaches: true, value: SPLIT_KINDS.light.distinctValues[1] as number }),
    what: "the mounted light's intensity",
  },
  camera: {
    // MEASURED, not assumed, and measured on BOTH halves: with the channel seeded and a
    // held edit of 85 applied to `fov`, the frustum stayed at 1 — whether the transient was
    // keyed to the CameraData or to the Object. So this is not the wrong-half mistake it
    // would resemble; the camera pose road simply does not consult transients at all.
    // `resolveCameraPoseAt` says so in as many words ("a render is of committed DAG
    // state"), which makes the camera the one kind whose held edit is refused by design
    // rather than by oversight — and the design predates the split, so the answer here is
    // not a regression this slice introduced.
    //
    // It is still a real gap for a director: dragging the focal-length slider on an
    // animated camera moves the number and not the shot.
    signature: cameraFrustumFov,
    expectHeld: () => ({
      reaches: false,
      why:
        'the camera pose is resolved from committed DAG state only — `resolveCameraPoseAt` ' +
        'deliberately applies no transient overlay, so no held lens edit can reach the ' +
        'frustum or the look-through view',
      issue: '#484',
    }),
    what: "the field of view the camera's frustum is drawn with",
  },
  baked: {
    // Same probe as box/sphere — a baked mesh mounts in the `children` band inside a
    // `<group name={nodeId}>` and reports a material colour — but the value reaching it
    // travelled a different road: `ObjectR` recomposes the pair into a `BakedMeshValue`
    // and hands it to `BakedMeshR`, whose material is built from the FLAT
    // `BakedMaterialSpec`. So this row is the one that would catch a recompose that drops
    // the captured spec, which renders as the `#808080` fallback rather than as nothing.
    signature: materialColor,
    expectHeld: () => ({
      reaches: true,
      value: String(SPLIT_KINDS.baked.distinctValues[1]).toLowerCase(),
    }),
    what: "the rendered material's captured baked colour",
  },
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Hygiene, and NOT optional here: the app autosaves to OPFS on an idle debounce
  // (boot.ts:213), and these rows add nodes to the project — the management road also mints
  // an Action, a Strip and a Track. Without this wipe every row would be handed the previous
  // row's leftovers, and worse, would leave them for whatever spec ran next. It is the same
  // block ~70 other specs in this suite open with, for the same reason.
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
    if (typeof localStorage !== 'undefined') localStorage.removeItem('basher.timelineDock.v1');
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene &&
        w.__basher_selection &&
        w.__basher_transient &&
        w.__basher_three?.getState().scene &&
        w.__basher_dispatchMutator &&
        w.__basher_nlaPushDown,
      );
    },
    { timeout: 20_000 },
  );
});

/**
 * Build one conformance row in the live app: the data node, the Object, the `data` edge,
 * and the connect into the band's scene socket.
 *
 * `SplitBand`'s members ARE the scene socket names ('children' / 'lights' / 'camera'), so
 * the band chooses where the pair mounts with no second mapping to keep in step — and a
 * fourth band is already a compile error at `channelPathForBand`, which is where it should
 * be decided.
 *
 * ⚠️ THE CAMERA ROW REPLACES THE PROJECT CAMERA, deliberately. `scene.camera` is a
 * single-cardinality socket, so connecting the row's Object there displaces the seed
 * camera's edge (measured: `scene.camera` goes from `n_camera` to `n_conf_camera`; the
 * `n_camera` node itself survives, merely unwired). That is a feature for these rows — the
 * row's camera becomes the ACTIVE one, which is the state the pose road is interesting in
 * — but it is worth naming, because it is the one band where building a row mutates
 * something the default project already had rather than only adding to it. The per-test
 * OPFS wipe in `beforeEach` is what keeps that from leaking into the next spec.
 */
/**
 * The BAKED row, which is the one kind whose fixture cannot be hand-authored at all.
 *
 * Every other row is a `dispatchAtomic` of `splitOps` + `rowDataParams` — the data params
 * ARE the fixture. Baked's `geometry` is not data, it is a HANDLE: a content-hash key into
 * OPFS. The descriptor says as much ("the handle is synthetic: the conformance roads ask
 * where a value is ROUTED, never whether OPFS holds those bytes"), and that is true of the
 * unit tier — but this tier RENDERS. A synthetic hash addresses bytes that were never
 * written, so `useBakedGeometry` suspends forever, the Suspense boundary never resolves,
 * and the row fails as a 60s timeout waiting for UI that never mounts. Which is exactly
 * how it failed: not at an assertion, at the toolbar.
 *
 * So the fixture drives the LIVE PRODUCER instead. Seed a split sphere carrying the row's
 * resting colour, Apply Transform it, and let the real bake write real bytes and capture
 * the material. The Apply road inherits the source's id on the OBJECT half, so the row
 * still answers to `n_conf_baked` and every probe below addresses it the same way as the
 * other five.
 *
 * ⚠️ The data id must be READ, not derived. Apply mints the pair itself and takes a fresh
 * data id, and the seed sphere's own `__data` is still present when it does — so the baked
 * data node is NOT `dataIdFor(objectId)`. Deriving it would make R8's guard-the-guard
 * ("the channel really did land on the data half") compare against an id that does not
 * exist, and fail for a reason that has nothing to do with push-down.
 */
async function buildBakedRow(page: Page, restingColor: string) {
  const objectId = 'n_conf_baked';

  await page.evaluate(
    ({ ops, obj }) => {
      const dag = (window as unknown as BasherWindow).__basher_dag!.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(ops as unknown[]),
          {
            type: 'connect',
            from: { node: obj, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'conformance baked seed',
      );
    },
    {
      ops: splitSphereOps({ objectId, radius: 0.5, color: restingColor }) as unknown[],
      obj: objectId,
    },
  );

  // The source has to be DRAWING before Apply can bake it — Apply reads the evaluated mesh.
  await page.waitForFunction(
    (id) => {
      // Wait for the SEAM as well as the bounds. It is installed by the viewport and is not
      // in this spec's beforeEach gate, so calling it unguarded throws "not a function"
      // instead of waiting — and worse, it does that only when the viewport failed to
      // mount, turning every render break below into the same unhelpful message.
      const read = (window as unknown as BasherWindow).__basher_mesh_world_bounds;
      return typeof read === 'function' && read(id) !== null;
    },
    objectId,
    { timeout: 20_000 },
  );

  const applied = await page.evaluate(async (id) => {
    const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
    return (await mod.dispatchApplyTransform(id, 'all')) as { ok: boolean; reason?: string };
  }, objectId);
  expect(applied.ok, `baked: Apply Transform failed (${applied.reason}) — no row to test`).toBe(
    true,
  );

  // Wait on POSSESSION, not on the node's type: a split sphere and a baked pair both leave
  // an `Object` at this id, so `type === 'Object'` is constant across the bake and would be
  // satisfied before Apply ran at all.
  await page.waitForFunction(
    (id) => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      const dataId = nodes[id]?.inputs?.data?.node;
      return nodes[id]?.type === 'Object' && nodes[dataId ?? '']?.type === 'BakedData';
    },
    objectId,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    (id) => {
      // Wait for the SEAM as well as the bounds. It is installed by the viewport and is not
      // in this spec's beforeEach gate, so calling it unguarded throws "not a function"
      // instead of waiting — and worse, it does that only when the viewport failed to
      // mount, turning every render break below into the same unhelpful message.
      const read = (window as unknown as BasherWindow).__basher_mesh_world_bounds;
      return typeof read === 'function' && read(id) !== null;
    },
    objectId,
    { timeout: 20_000 },
  );

  const dataId = await page.evaluate(
    (id) =>
      (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id]?.inputs?.data
        ?.node ?? null,
    objectId,
  );
  expect(dataId, 'baked: the pair has no data edge after Apply').not.toBeNull();
  return { objectId, dataId: dataId! };
}

async function buildRow(page: Page, kind: SplitKindName) {
  const spec = SPLIT_KINDS[kind];
  const objectId = `n_conf_${kind}`;
  const dataId = dataIdFor(objectId);
  // Baked answers this road differently because its fixture cannot exist as params — see
  // `buildBakedRow`. Note this is a different FIXTURE, not a skipped road: both R5 and R8
  // still run for baked and still assert an outcome.
  if (kind === 'baked') {
    return buildBakedRow(page, String(SPLIT_KINDS.baked.distinctValues[0]));
  }
  const ops = splitOps(kind, { objectId }, { data: rowDataParams(kind) });

  await page.evaluate(
    ({ ops: rowOps, obj, socket }) => {
      const dag = (window as unknown as BasherWindow).__basher_dag!.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(rowOps as unknown[]),
          { type: 'connect', from: { node: obj, socket: 'out' }, to: { node: sceneId, socket } },
        ],
        'e2e',
        'conformance row',
      );
    },
    { ops: ops as unknown[], obj: objectId, socket: spec.band },
  );

  return { objectId, dataId };
}

test.describe('the split-kind conformance matrix (browser tier)', () => {
  // Guard the guard, first: the probe table has to cover exactly the rows that exist.
  //
  // This is a RUNTIME check even though a `Record<SplitKindName, …>` looks like it makes
  // it a compile-time one. It does not: no test file and no e2e spec is typechecked by the
  // `typecheck` gate (tsconfig.app.json excludes them — issue #472), so the annotation
  // above is documentation and this assertion is the thing that can actually fail. When
  // #388 or #389 adds a kind, THIS is what says the browser tier has not caught up.
  test('every descriptor row has a render probe, and every probe has a row', async () => {
    expect(
      SPLIT_KIND_NAMES.length,
      'fewer than 5 split kinds — the descriptor has drifted and every row below is vacuous',
    ).toBeGreaterThanOrEqual(5);
    expect(
      Object.keys(RENDER_PROBES).sort(),
      'RENDER_PROBES and SPLIT_KINDS disagree — a kind with no probe runs no browser road, ' +
        'and a probe with no kind is measuring something that no longer ships',
    ).toEqual([...SPLIT_KIND_NAMES].sort());
  });

  for (const kind of SPLIT_KIND_NAMES) {
    const spec = SPLIT_KINDS[kind];
    const probe = RENDER_PROBES[kind];
    const param = spec.observableDataParam;
    const held = spec.distinctValues[1];

    test(`R5 ${kind} — a HELD edit on the data half repaints the object`, async ({ page }) => {
      const { objectId, dataId } = await buildRow(page, kind);

      // The param has to be ANIMATED before a held edit can exist at all. That is not a
      // detail of the fixture, it is the shape of the feature: dragging a static param
      // writes it, and only an animated one is diverted into a transient, because writing
      // it would be overruled by its own channel on the next frame (ParamDiamond.tsx:53,
      // routeAnimatedGrab). A row that skipped this step would set a transient nothing ever
      // reads, watch the render not move, and report a product bug that is really a fixture
      // testing an unreachable state — which is exactly what the first draft of this test
      // did. Seeding the channel is also what puts the object on the overlay road at all:
      // OverlayDispatch mounts a bare MeshChild for anything with no channel and no
      // constraint, and that arm applies no overlays by design.
      await seedRowChannel(page, kind, objectId);

      // Rest first. A road that never applies the transient would return this value, so
      // everything below is stated against it rather than against a literal.
      const resting = await expectEventually(page, probe, objectId, (v) => v !== null);
      expect(
        resting,
        `${kind}: nothing mounted for ${objectId} — ${probe.what} could not be read at all, ` +
          `so the transient road below would pass or fail for the wrong reason`,
      ).not.toBeNull();

      const expectation = probe.expectHeld(resting!);
      if (expectation.reaches) {
        expect(
          expectation.value,
          `${kind}: the held value and the resting value agree, so a viewport that ignores ` +
            `held edits entirely would pass this row`,
        ).not.toEqual(resting);
      }

      // The held edit: keyed by the DATA node, which is where the inspector writes it,
      // while the viewport overlays transients keyed by the OBJECT. Bridging those two is
      // the entire road.
      await page.evaluate(
        ({ id, path, value }) =>
          (window as unknown as BasherWindow).__basher_transient!.getState().set(id, path, value),
        { id: dataId, path: param, value: held },
      );

      if (!expectation.reaches) {
        // The road ran, and this kind's answer is NO. Pinned rather than skipped, so the
        // cell cannot read as coverage — and pinned as an EQUALITY, so it reds the moment
        // the gap closes. Give the render the same settling time the positive rows get,
        // or "it did not move" would be indistinguishable from "we did not wait".
        await expectEventually(page, probe, objectId, () => false, 2_000);
        const unmoved = await probe.signature(page, objectId);
        expect(
          unmoved,
          `${kind}: ${probe.what} MOVED under a held edit — which is what we want, and means ` +
            `${expectation.issue} has been fixed. Flip this row to expect the repaint ` +
            `({ reaches: true, … }) and close the issue. (Pinned because ${expectation.why}.)`,
        ).toEqual(resting);
        return;
      }

      const wanted = expectation.value;
      const withHeld = await expectEventually(page, probe, objectId, (v) => v === wanted);
      expect(
        withHeld,
        `${kind}: the held edit on ${dataId}.${param} never reached the render — ${probe.what} ` +
          `stayed at ${JSON.stringify(resting)} instead of ${JSON.stringify(wanted)}. The ` +
          `object is frozen under the director's hand while the inspector shows the new value`,
      ).toEqual(wanted);

      // And it must let go. A transient that survives its own release is the same class of
      // bug pointing the other way — the object stops tracking the committed state.
      await page.evaluate(() =>
        (window as unknown as BasherWindow).__basher_transient!.getState().clearAll(),
      );
      const released = await expectEventually(page, probe, objectId, (v) => v === resting);
      expect(
        released,
        `${kind}: releasing the held edit left ${probe.what} at ${JSON.stringify(withHeld)} — ` +
          `the overlay is not being cleared, so the render no longer follows the committed value`,
      ).toEqual(resting);
    });

    test(`R8 ${kind} — what push-down OFFERS equals what it ACCEPTS`, async ({ page }) => {
      const { objectId, dataId } = await buildRow(page, kind);

      // Author the channel the way a director does: address the OBJECT. `addChannel` routes
      // the target to the owning half, so the channel lands on the data node — which is
      // exactly the divergence this road exists for. The management surface still shows the
      // Object, and must find the channel anyway.
      const channelId = await seedRowChannel(page, kind, objectId);

      // Guard the guard: the channel really did land on the DATA half. If it landed on the
      // Object, the two sides below would agree trivially and this row would prove nothing.
      const channelTarget = await page.evaluate(
        (id) =>
          (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id]?.params
            .target,
        channelId,
      );
      expect(
        channelTarget,
        `${kind}: the channel targets ${String(channelTarget)}, not the data half ${dataId} — ` +
          `offer and accept would then agree for a reason that has nothing to do with the split`,
      ).toBe(dataId);

      await page.evaluate(
        (id) => (window as unknown as BasherWindow).__basher_selection!.getState().select(id),
        objectId,
      );
      await page.getByTestId('floating-toolbar-timeline').click();
      await page.getByTestId('timeline-tab-nla').click();
      await expect(page.getByTestId('nla-pane')).toHaveAttribute('data-active', 'true');

      // Whether push-down reaches this kind at all. Unset means YES, so a kind that has
      // never been asked fails loudly rather than being quietly excused.
      //
      // Both sides below are asserted through THIS ONE expression rather than through a
      // branch, and that is the point of the road: offer and accept must agree, so they
      // have to be compared against the same value. An `if (negative) return` would leave
      // the metadata gate satisfied — `why` present, `issue` present — while nothing ran.
      const answer = spec.roadAnswers?.management;
      const expectOffer = answer?.reaches ?? true;

      // THE OFFER — the surface counts the selected Object's bare channels.
      await expect(
        page.getByTestId('nla-push-down'),
        expectOffer
          ? `${kind}: push-down is dead for ${objectId}, whose ${param} is visibly keyframed. ` +
              `The enumeration behind the button is addressing the Object by exact id and ` +
              `cannot see the data half's channel — and zero channels is a legitimate answer, ` +
              `so it says nothing`
          : `${kind}: push-down is OFFERED for ${objectId}, but this kind cannot be driven by ` +
              `a strip (${answer && !answer.reaches ? answer.why : ''}). Either the guard has ` +
              `been lost — in which case accepting will DELETE the animation — or the gap is ` +
              `fixed and this row should say so`,
      ).toBeEnabled({ enabled: expectOffer });

      // THE ACCEPT — the mutator enumerates them again, and must find the same set.
      const accepted = await page.evaluate(
        (id) => (window as unknown as BasherWindow).__basher_nlaPushDown!(id),
        objectId,
      );
      expect(
        accepted.ok,
        `${kind}: the surface and the mutator disagree — the button says ` +
          `${expectOffer ? 'yes' : 'no'} and the dispatcher says ${accepted.ok ? 'yes' : 'no'}` +
          `${accepted.reason ? ` (${accepted.reason})` : ''}. They are running different ` +
          `enumerations, or one of them has a guard the other lacks`,
      ).toBe(expectOffer);

      if (!expectOffer) {
        const no = answer as { reaches: false; why: string; issue: string };

        // What follows is the NEGATIVE branch, and it returns at the end — but note what it
        // asserts on the way there. Both sides above already ran against the shared
        // expression; below, this kind asserts four further things the positive branch never
        // has to: which refusal fired, that offer and accept explain it identically, and
        // that nothing was destroyed. A `return` that arrives after more assertions than the
        // path it skips is not a skip.

        // WHICH refusal fired. Two independently sufficient ones exist — this kind's own,
        // and "no bare keyframe channels to push down" — and the second is precisely the
        // #386 bug this road hunts: an enumeration blind to the data half refuses too, for
        // the wrong reason, and would satisfy a bare `ok === false`. So the cell would read
        // as covered while the road's real question went unasked. Naming the issue in the
        // reason is what separates them.
        expect(
          accepted.reason ?? '',
          `${kind}: push-down refused, but not for this kind's reason — it said ` +
            `"${accepted.reason}". If that is the empty-enumeration refusal then the channel ` +
            `on the data half is invisible to the mutator, which is a real bug wearing this ` +
            `row's expected answer as a disguise`,
        ).toContain(no.issue);

        // Offer and accept must agree on the SENTENCE, not merely on the verdict. They read
        // it from one expression (`stripDriveRefusal`), and if that ever forks, the button's
        // tooltip and the toast start explaining the same refusal differently.
        const title = await page.getByTestId('nla-push-down').getAttribute('title');
        // The button must HAVE a tooltip before its sentence can be compared with the
        // dispatcher's. Asserted on its own line rather than folded into a fallback on the
        // comparison below, because every value that could stand in for a missing title is
        // either vacuously contained ('' is a substring of everything) or a literal control
        // character. This line used to be the latter, and one NUL byte made the whole file
        // read as binary to grep -- so every repo-wide sweep skipped the matrix silently
        // while git grep still found it (#493).
        expect(
          title,
          `${kind}: the push-down button carries no title, so the refusal it OFFERS cannot ` +
            `be compared with the one the dispatcher ACCEPTS`,
        ).not.toBeNull();
        expect(
          accepted.reason ?? '',
          `${kind}: the button explains the refusal as "${title}" while the dispatcher says ` +
            `"${accepted.reason}" — two sources for one answer`,
        ).toContain(String(title));

        // AND NOTHING WAS DESTROYED. This is the whole reason the refusal exists: push-down
        // is a composite whose destructive half is sound only because the strip it mints
        // drives the same target. A refusal that still deleted the channel would leave the
        // object un-animated with nothing to show for it.
        const wreckage = await page.evaluate((chId) => {
          const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
          const count = (t: string) => Object.values(nodes).filter((n) => n.type === t).length;
          return {
            channelSurvived: Boolean(nodes[chId]),
            actions: count('Action'),
            strips: count('Strip'),
          };
        }, channelId);
        expect(
          wreckage,
          `${kind}: push-down refused and destroyed something anyway — the refusal has to come ` +
            `BEFORE the deletion, or it converts a known limit into data loss (${no.issue})`,
        ).toEqual({ channelSurvived: true, actions: 0, strips: 0 });
        return;
      }

      // And the accept did what the offer promised: an Action + a Strip on the OBJECT (a
      // Strip carries one target, and a data node never gets its own lane), bare channel gone.
      const after = await page.evaluate(() => {
        const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
        const byType = (t: string) => Object.entries(nodes).filter(([, n]) => n.type === t);
        const strips = byType('Strip');
        return {
          actions: byType('Action').length,
          strips: strips.length,
          stripTargets: strips.map(([, n]) => n.params.target),
        };
      });
      expect(after.actions, `${kind}: push-down minted no Action`).toBe(1);
      expect(after.strips, `${kind}: push-down minted no Strip`).toBe(1);
      expect(
        after.stripTargets,
        `${kind}: the Strip targets the data half. A Strip carries ONE target and the ` +
          `management surface addresses the Object, so it must land on the Object`,
      ).toEqual([objectId]);

      const channelGone = await page.evaluate(
        (id) => !(window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id],
        channelId,
      );
      expect(
        channelGone,
        `${kind}: the bare channel survived the push-down, so it now double-drives the param ` +
          `alongside the Strip`,
      ).toBe(true);
    });
  }
});

/**
 * Put ONE keyframe channel on this row's observable param, authored the way a director
 * does it: addressed to the OBJECT, and left to `addChannel` to route to the owning half.
 *
 * Shared by both roads, which need it for different reasons — R8 needs a channel to
 * enumerate, R5 needs the param to be animated before a held edit can exist. Sharing it
 * also means the two rows cannot drift into animating different things.
 */
async function seedRowChannel(page: Page, kind: SplitKindName, objectId: string): Promise<string> {
  const spec = SPLIT_KINDS[kind];
  const channelId = `n_conf_${kind}_channel`;
  const res = await page.evaluate(
    ({ target, path, valueType, id, key }) =>
      (window as unknown as BasherWindow).__basher_dispatchMutator!(
        'mutator.timeline.addChannel',
        {
          target,
          paramPath: path,
          valueType,
          channelId: id,
          initialKeyframe: { time: 0, value: key, easing: 'linear' },
        },
        'conformance row channel',
      ),
    {
      target: objectId,
      path: spec.observableDataParam,
      valueType: spec.channelValueType,
      id: channelId,
      key: keyframeValueFor(spec.channelValueType),
    },
  );
  expect(res.ok, `${kind}: seeding the row's channel failed: ${res.reason}`).toBe(true);
  return channelId;
}

/** A keyframe value of the right SHAPE for a channel value type — the mutator validates it
 *  even though this road only asks WHERE the channel is routed. Mirrors the unit tier's. */
function keyframeValueFor(valueType: 'number' | 'vec3' | 'quat' | 'color'): unknown {
  switch (valueType) {
    case 'number':
      return 1;
    case 'vec3':
      return [1, 2, 3];
    case 'quat':
      return [0, 0, 0, 1];
    case 'color':
      return '#123456';
  }
}

/** Poll a render probe until it satisfies `ok`, then return the last value seen. Returns the
 *  last value either way, so the caller's assertion reports what it actually settled at
 *  rather than a bare timeout. */
async function expectEventually(
  page: Page,
  probe: RenderProbe,
  objectId: string,
  ok: (v: number | string | null) => boolean,
  timeoutMs = 8_000,
): Promise<number | string | null> {
  let last: number | string | null = null;
  const deadline = Date.now() + timeoutMs;
  do {
    last = await probe.signature(page, objectId);
    if (ok(last)) return last;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return last;
}
