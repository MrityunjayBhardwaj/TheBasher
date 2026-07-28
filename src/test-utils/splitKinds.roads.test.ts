// The unit-tier conformance roads, run for EVERY split kind.
//
// Two roads live here, both asked the same way of all four kinds:
//
//   R3  read == render — the value a read surface reports for a data param is the
//       value the renderer composes from. The READ half is band-uniform (the resolver
//       reaches Object→data and data→poser for everyone); only the RENDER half differs.
//
//   R4  the overlay lands where the renderer looks — a channel written at the band's
//       channel path is visible in the value the renderer reads. This is the road that
//       would have caught the light band's freeze: rebasing a light's shading channel
//       under `data.` writes a path the flat LightValue does not have, `writeAt` no-ops
//       on the missing intermediate, and the animated intensity silently sticks at base
//       while every unit test stays green.
//
// THE BAND MAY CHOOSE HOW A ROAD ASKS, NEVER WHETHER IT RUNS. Both roads run for all
// four kinds; `renderedValueForBand` and `channelPathForBand` phrase them per band, and
// both are closed by a `never` so a fifth band has to decide rather than inherit.
//
// WHY THE OBSERVABLE PARAM DIFFERS PER KIND: it has to survive to the evaluated value
// under the same path, or the assertion would have to re-derive the transform and could
// then drift from the thing it is checking. `size` becomes an opaque GeometryRef,
// `resolution` is consumed into `samples`, `points` is rewritten from `{id,co}[]` to
// `co[]` — so the box and sphere ride their material leaf, the curve rides `closed`, and
// the light rides `intensity`.
//
// REF: src/test-utils/splitKinds.ts; src/app/objectDataBand.ts; issue #471.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { emptyDagState, type DagState } from '../core/dag/state';
import { evaluate } from '../core/dag/evaluator';
import type { EvalCtx, Op } from '../core/dag/types';
import { snapshotRegistry } from '../core/dag/registry';
import { migrateProjectFormat } from '../core/project/migrations';
import { PROJECT_FORMAT_VERSION } from '../core/project/schema';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { resolveDataParamOwner } from '../app/resolveDataParamOwner';
import { addChannelMutator } from '../agent/mutators/builders/addChannel';
import { validatePlan } from '../agent/mutators/validate';
import { overlayChannels } from '../nodes/overlayChannels';
import type { KeyframeChannelValue } from '../nodes/types';
import { resolveEvaluatedParam } from '../app/resolveEvaluatedParam';
import { channelPathForBand, renderReachForBand } from '../app/objectDataBand';
import { resolveCameraPoseAt } from '../app/activeCamera';
import {
  dataIdFor,
  renderedValueForBand,
  rowDataParams,
  splitOps,
  SPLIT_KINDS,
  SPLIT_KIND_NAMES,
  type SplitKindName,
} from './splitKinds';

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/**
 * A minimal channel value carrying `value` at `paramPath`.
 *
 * `valueType` is irrelevant here and deliberately so: at weight 1 with the default
 * 'replace' blend the fold returns the channel value whatever the type, which is what
 * lets one road cover a colour, a boolean and a number without four variants. The
 * TYPED fold (partial weights, combine mode, colour snapping) is exercised by
 * foldChannel's own tests — this road is asking WHERE the value lands, not how it blends.
 */
function channelAt(paramPath: string, value: unknown): KeyframeChannelValue {
  return {
    kind: 'KeyframeChannel',
    name: 'conformance road',
    target: '',
    paramPath,
    mute: false,
    weight: 1,
    blendMode: 'replace',
    order: 0,
    valueType: 'number',
    sample: () => value,
  } as unknown as KeyframeChannelValue;
}

/**
 * A keyframe value of the right SHAPE for a channel value type.
 *
 * The routing road below asks where a channel's TARGET is sent, which keys off the
 * param's root name and never off the value — but the mutator validates the keyframe's
 * shape against `valueType`, so the value still has to be well-formed. Deriving it from
 * the type keeps the descriptor from carrying a field that means nothing.
 *
 * (Worth stating plainly, since it surfaced here: the curve's `closed` is a boolean and
 * there is no boolean channel type, so it cannot be keyframed at all. That is a real
 * property of the curve, not a gap in this road — the road still asks, and gets an
 * answer, about where a channel on it would be sent.)
 */
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

/** Build a split pair of `kind` with its base observable value written on the data half. */
function buildKind(kind: SplitKindName): { state: DagState; objectId: string; dataId: string } {
  const objectId = `n_${kind}`;
  const dataId = dataIdFor(objectId);
  const dataParams = rowDataParams(kind);
  let state = emptyDagState();
  for (const op of splitOps(kind, { objectId }, { data: dataParams })) {
    state = applyOp(state, op as Op).next;
  }
  return { state, objectId, dataId };
}

describe.each(SPLIT_KIND_NAMES)('conformance roads — %s', (kind) => {
  const spec = SPLIT_KINDS[kind];
  const param = spec.observableDataParam;
  const [base, overlaid] = spec.distinctValues;

  beforeEach(() => {
    __reseedAllNodesForTests();
  });

  it('the fixture actually holds its base value (guard the guard)', () => {
    // If the base value did not survive being written onto the data node, both roads
    // below would be comparing a default against a default and passing for free.
    const { state, dataId } = buildKind(kind);
    const rendered = renderedValueForBand(
      spec.band,
      evaluate(state, `n_${kind}`, { ctx: CTX }).value,
    );
    expect(
      spec.readRendered(rendered),
      `${spec.dataType}: "${param}" = ${JSON.stringify(base)} did not survive to the ` +
        `evaluated value — the fixture is measuring a default, not the node`,
    ).toEqual(base);
    expect(state.nodes[dataId]).toBeDefined();
  });

  it('R3 — a read of the Object reports what the renderer composes from', () => {
    const { state, objectId } = buildKind(kind);

    // READ: a caller naturally names the OBJECT; the param lives on the data half. The
    // resolver reaches through the split for it (band-uniform — the same reach for all
    // four kinds).
    const read = resolveEvaluatedParam(state, objectId, param, CTX);

    // RENDER: the value the renderer for this band actually consumes.
    const rendered = renderedValueForBand(spec.band, evaluate(state, objectId, { ctx: CTX }).value);

    expect(
      read?.value,
      `${spec.dataType}: reading "${param}" off the Object returned ` +
        `${JSON.stringify(read?.value)}, the renderer sees ` +
        `${JSON.stringify(spec.readRendered(rendered))}`,
    ).toEqual(spec.readRendered(rendered));
    // And both are the real authored value, not a shared fallback they happen to agree on.
    expect(read?.value).toEqual(base);
  });

  it('R4 — a channel written at the band path is visible to the renderer', () => {
    // ONE road, asked in the phrasing its band requires — never skipped for a band.
    // `renderReachForBand` decides the phrasing, and it is pinned as an equality in
    // objectDataBand.test.ts precisely so a band cannot quietly choose the easier
    // question: routing the camera down the 'evaluated-value' arm below would PASS
    // (the recomposed CameraValue is flat and accepts the overlay) while never asking
    // whether the rendered camera moved.
    if (renderReachForBand(spec.band) === 'params-resolver') {
      // The camera. Nothing renders from its evaluated value: `cameraPoseFromNode`
      // builds a CameraPose from RAW params and `resolveCameraPoseAt` applies channels
      // itself, keyed on the node id. So the question has to be put to that resolver,
      // with a real channel node — and it must target the DATA half, because that is
      // where the split moved the param and where `addChannel` will route it.
      const { state, objectId, dataId } = buildKind(kind);
      const withChannel = applyOp(state, {
        type: 'addNode',
        nodeId: 'n_ch',
        nodeType: 'KeyframeChannelNumber',
        params: {
          target: dataId,
          paramPath: param,
          keyframes: [
            { time: 0, value: overlaid, easing: 'linear' },
            { time: 1, value: overlaid, easing: 'linear' },
          ],
        },
      } as Op).next;

      const posed = resolveCameraPoseAt(withChannel, objectId, 1);
      expect(
        posed.fov,
        `${spec.dataType}: a channel on "${param}" targets the data half, but the pose ` +
          `resolver every render road funnels through reports ${posed.fov}. ` +
          `${JSON.stringify(base)} means the resolver reads the pair but not its ` +
          `channels; 45 means it read neither and returned DEFAULT_CAMERA_POSE. Either ` +
          `way this param animates in the inspector and freezes on screen`,
      ).toEqual(overlaid);
      // And not either value a broken road hands back for free.
      expect(posed.fov).not.toEqual(base);
      expect(posed.fov).not.toEqual(45);
      return;
    }

    const { state, objectId } = buildKind(kind);
    const renderBase = renderedValueForBand(
      spec.band,
      evaluate(state, objectId, { ctx: CTX }).value,
    );

    // Before overlaying: the renderer sees the authored base. Without this the road
    // could pass on a value that was already the overlaid one.
    expect(spec.readRendered(renderBase)).toEqual(base);

    const path = channelPathForBand(spec.band, param);
    const withChannel = overlayChannels(renderBase, [channelAt(path, overlaid)], 1, 0);

    expect(
      spec.readRendered(withChannel),
      `${spec.dataType}: a channel on "${param}" was written to "${path}" for the ` +
        `${spec.band} band, but the renderer still reads ` +
        `${JSON.stringify(spec.readRendered(withChannel))} — the overlay landed somewhere ` +
        `nothing reads, so this param would animate in the inspector and freeze on screen`,
    ).toEqual(overlaid);
  });
});

// ── R9 — the migration ladder ────────────────────────────────────────────────────
//
// The per-kind byte-identity migration tests already live in migrations.test.ts and are
// much stronger than anything a matrix could restate: they check that a migrated project
// renders byte-identically to the fused original, that channels re-target to the right
// half, and they carry live controls. Restating them here would duplicate coverage rather
// than add it — so this road asks only what those tests structurally CANNOT, because they
// are written per kind and a fifth kind has no test yet.
//
// The trap it guards is documented in migrations.ts and is silent, permanent data loss: a
// new kind whose split is folded into an EXISTING version's migration never runs for any
// project already saved past that version. Those are precisely the projects most likely
// to exist.
describe('R9 — every kind owns its own step on the migration ladder', () => {
  beforeEach(() => {
    __reseedAllNodesForTests();
  });

  it('each kind has a migration registered at its version', () => {
    // The ladder THROWS on a gap ("No migration registered for formatVersion N"), so
    // stepping an empty project from each kind's version is the whole assertion.
    for (const kind of SPLIT_KIND_NAMES) {
      const from = SPLIT_KINDS[kind].migratesFromVersion;
      expect(
        () =>
          migrateProjectFormat({
            formatVersion: from,
            state: { nodes: {}, edges: [], outputs: {} },
          }),
        `no migration step is registered at formatVersion ${from}, which ${kind} claims ` +
          `performs its split — a project saved at that version would never split`,
      ).not.toThrow();
    }
  });

  it('no two kinds share a migration step', () => {
    const versions = SPLIT_KIND_NAMES.map((k) => SPLIT_KINDS[k].migratesFromVersion);
    expect(
      new Set(versions).size,
      `two kinds claim the same format version (${versions.join(', ')}). Folding a later ` +
        `kind into an earlier kind's step means every project already saved past that ` +
        `version silently never splits — the one failure mode this ladder exists to avoid`,
    ).toBe(versions.length);
  });

  it("each kind's split has already happened by the current format version", () => {
    for (const kind of SPLIT_KIND_NAMES) {
      expect(SPLIT_KINDS[kind].migratesFromVersion).toBeLessThan(PROJECT_FORMAT_VERSION);
    }
  });

  it('migrating a project already at the current version changes nothing (idempotent)', () => {
    const current = { formatVersion: PROJECT_FORMAT_VERSION, state: { nodes: {}, edges: [] } };
    expect(migrateProjectFormat(current)).toEqual(current);
  });

  it('every fused predecessor a kind names is still a registered type', () => {
    // The relics stay registered so old projects can be loaded and migrated at all. A
    // descriptor naming a type that no longer exists would mean its migration source is
    // unloadable — and nothing else would say so.
    const snap = snapshotRegistry();
    for (const kind of SPLIT_KIND_NAMES) {
      for (const fused of SPLIT_KINDS[kind].fusedTypes) {
        expect(
          snap[fused],
          `${kind} migrates from "${fused}", which is not registered — a project ` +
            `containing one could not be loaded to be migrated`,
        ).toBeDefined();
      }
    }
  });
});

// ── R10 — a write aimed at the wrong half ────────────────────────────────────────
//
// A data param written onto the Object is ACCEPTED and changes nothing: the Object's
// schema is non-strict, so it STRIPS the unknown key and `safeParse` succeeds. Every
// door into the graph has this shape — the agent's `dag.exec`, a channel authored
// against the Object, an imported clip carrying the wrong target. The write road's job
// is to route the caller's id to the half that owns the param, and to surface it when
// it cannot.
describe.each(SPLIT_KIND_NAMES)('R10 — wrong-half write — %s', (kind) => {
  const spec = SPLIT_KINDS[kind];
  const param = spec.observableDataParam;
  const paramRoot = param.split('.')[0];
  const [base, overlaid] = spec.distinctValues;

  beforeEach(() => {
    __reseedAllNodesForTests();
  });

  it('the owner resolves to the data half', () => {
    // The seam `addChannel` and the param mutators route through. A kind missing here
    // gets channels that target the Object: they animate in the inspector and never paint.
    const { state, objectId, dataId } = buildKind(kind);
    expect(
      resolveDataParamOwner(state, objectId, paramRoot),
      `${spec.dataType}: "${paramRoot}" named on the Object did not resolve to the data ` +
        `half, so a channel on it would target a node that does not own it`,
    ).toBe(dataId);
  });

  it('addChannel routes the channel onto the data half', () => {
    // The agent names the Object — that is what `identify` hands it as "the cube". A
    // channel left targeting the Object animates in the inspector and never paints,
    // because the render overlay only collects channels targeting the data node. There
    // is an existing test for exactly this, written for the CUBE; the other three kinds
    // had none, which is the shape of gap this matrix exists to close.
    const { state, objectId, dataId } = buildKind(kind);
    const plan = validatePlan(
      addChannelMutator,
      {
        target: objectId,
        paramPath: param,
        valueType: spec.channelValueType,
        initialKeyframe: { time: 0, value: keyframeValueFor(spec.channelValueType) },
      },
      state,
      'roads',
    );
    expect(plan.ok, plan.ok ? '' : plan.reason).toBe(true);
    if (!plan.ok) return;
    const op = plan.ops[0] as { type: string; params: { target: string } };
    expect(op.type).toBe('addNode');
    expect(
      op.params.target,
      `${spec.dataType}: a channel on "${param}" was authored against the Object and left ` +
        `there — it would animate in the inspector and never render`,
    ).toBe(dataId);
  });

  it('writing the data param onto the Object is surfaced and changes nothing', () => {
    const { state, objectId } = buildKind(kind);
    const result = applyOp(state, {
      type: 'setParam',
      nodeId: objectId,
      paramPath: param,
      value: overlaid,
    });
    expect(
      result.reportable?.badge,
      `${spec.dataType}: a "${param}" write aimed at the Object was accepted silently — ` +
        `it changes nothing and nothing says so`,
    ).toBe('stripped-write');
    expect(result.next.nodes[objectId].params).toEqual(state.nodes[objectId].params);
  });

  it('CONTROL: the same write on the data half lands and is not flagged', () => {
    // Without this the test above would also pass if the detector fired on everything.
    const { state, dataId } = buildKind(kind);
    const result = applyOp(state, {
      type: 'setParam',
      nodeId: dataId,
      paramPath: param,
      value: overlaid,
    });
    expect(result.reportable).toBeUndefined();
    const rendered = renderedValueForBand(
      spec.band,
      evaluate(result.next, `n_${kind}`, { ctx: CTX }).value,
    );
    expect(spec.readRendered(rendered)).toEqual(overlaid);
    expect(spec.readRendered(rendered)).not.toEqual(base);
  });
});

describe('the roads cover every kind', () => {
  it('runs for every split kind', () => {
    // Guard the guard, one level up: `describe.each` over an empty list is zero tests
    // and a green suite. 5 with the camera (#387); 4 before it.
    expect(SPLIT_KIND_NAMES.length).toBeGreaterThanOrEqual(5);
  });
});
