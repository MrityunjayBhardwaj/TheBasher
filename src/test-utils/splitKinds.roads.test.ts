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
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { overlayChannels } from '../nodes/overlayChannels';
import type { KeyframeChannelValue } from '../nodes/types';
import { resolveEvaluatedParam } from '../app/resolveEvaluatedParam';
import { channelPathForBand } from '../app/objectDataBand';
import {
  dataIdFor,
  renderedValueForBand,
  splitOps,
  SPLIT_KINDS,
  SPLIT_KIND_NAMES,
  type SplitKindName,
} from './splitKinds';

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** `('material.base.color', v)` → `{ material: { base: { color: v } } }`. */
function nest(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  let out: unknown = value;
  for (let i = parts.length - 1; i >= 0; i--) out = { [parts[i]]: out };
  return out as Record<string, unknown>;
}

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

/** Build a split pair of `kind` with its base observable value written on the data half. */
function buildKind(kind: SplitKindName): { state: DagState; objectId: string; dataId: string } {
  const spec = SPLIT_KINDS[kind];
  const objectId = `n_${kind}`;
  const dataId = dataIdFor(objectId);
  const dataParams = {
    ...spec.baseDataParams,
    ...nest(spec.observableDataParam, spec.distinctValues[0]),
  };
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

describe('the roads cover every kind', () => {
  it('runs for all four split kinds', () => {
    // Guard the guard, one level up: `describe.each` over an empty list is zero tests
    // and a green suite.
    expect(SPLIT_KIND_NAMES.length).toBeGreaterThanOrEqual(4);
  });
});
