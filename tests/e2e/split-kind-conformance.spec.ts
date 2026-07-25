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
// Both roads run for all four kinds. What varies is phrasing: which scene socket the band
// mounts in (which is the band, literally — `SplitBand`'s members ARE the socket names),
// and how the rendered value is read back, since a mesh reports a material colour, a light
// reports an intensity and a curve reports the vertex count of the polyline it draws.
// There is deliberately no skip field and no per-kind early return; a kind that could not
// answer would have to be answered differently, not excluded.
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

interface DispatchResult {
  ok: boolean;
  reason?: string;
}

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params: Record<string, unknown> }>;
        outputs: { scene?: { node: string } };
      };
      dispatchAtomic: (ops: unknown[], source: string, intent: string) => unknown;
    };
  };
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
 * curve records that its render cannot follow at all (#474) — still an answer, still
 * asserted, never a skip. See `HeldExpectation`.
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
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
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
 * `SplitBand`'s members ARE the scene socket names ('children' / 'lights'), so the band
 * chooses where the pair mounts with no second mapping to keep in step — and a third band
 * is already a compile error at `channelPathForBand`, which is where it should be decided.
 */
async function buildRow(page: Page, kind: SplitKindName) {
  const spec = SPLIT_KINDS[kind];
  const objectId = `n_conf_${kind}`;
  const dataId = dataIdFor(objectId);
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
      'fewer than 4 split kinds — the descriptor has drifted and every row below is vacuous',
    ).toBeGreaterThanOrEqual(4);
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

      // THE OFFER — the surface counts the selected Object's bare channels.
      await expect(
        page.getByTestId('nla-push-down'),
        `${kind}: push-down is dead for ${objectId}, whose ${param} is visibly keyframed. The ` +
          `enumeration behind the button is addressing the Object by exact id and cannot see ` +
          `the data half's channel — and zero channels is a legitimate answer, so it says nothing`,
      ).toBeEnabled();

      // THE ACCEPT — the mutator enumerates them again, and must find the same set.
      const accepted = await page.evaluate(
        (id) => (window as unknown as BasherWindow).__basher_nlaPushDown!(id),
        objectId,
      );
      expect(
        accepted.ok,
        `${kind}: the surface OFFERED push-down and the mutator REFUSED it: ${accepted.reason}. ` +
          `Offer and accept are running different enumerations`,
      ).toBe(true);

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
