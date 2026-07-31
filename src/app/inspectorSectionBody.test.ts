// #458 — the shared section-body table.
//
// Three groups of assertions:
//
//  1. The table is complete and every control it names is reachable.
//  2. Row suppression moved from ONE global key filter to PER-SECTION
//     `omitRowKeys`. That is only safe because each suppressed key routes to
//     exactly the section that suppresses it — a claim about `paramToSection`,
//     pinned here rather than asserted in a comment.
//  3. Possession is asked of the node's SCHEMA, not of its live params. Each
//     case below is a control that WOULD have vanished had the predicate read
//     the params object: an `.optional()` param that never materializes, a
//     param added without a version bump (so old saves lack it), and a section
//     whose node owns no param of that name at all.

import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDagState } from '../core/dag/state';
import type { DagState } from '../core/dag/state';
import { SECTION_IDS, paramToSection, type SectionId } from './inspectorSections';
import {
  SECTION_CONTROLS,
  SectionBody,
  controlOwnedRowKeys,
  declaredParamKeys,
  makeSectionCtx,
  sectionRendersCustomControl,
  type ControlKey,
  type SectionControlRenderers,
  type SectionCtx,
} from './inspectorSectionBody';
import { getNodeType, listNodeTypes } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';

// The registry is populated by a side-effecting boot step in the real app.
beforeAll(() => {
  __reseedAllNodesForTests();
});

/** A one-node state whose params are EMPTY — the state every assertion below
 *  cares about, because it is the one where "is the key on the instance?" and
 *  "does the type declare it?" disagree. */
function stateWithNode(id: string, type: string, params: Record<string, unknown> = {}): DagState {
  return {
    ...emptyDagState(),
    nodes: { [id]: { id, type, version: 1, params, inputs: {} } },
  };
}

function ctxFor(type: string, params: Record<string, unknown> = {}, canApply = false) {
  return makeSectionCtx(stateWithNode('n', type, params).nodes.n, 'n', canApply);
}

describe('#458 SECTION_CONTROLS — shape', () => {
  it('covers every section id (exhaustive, not partial)', () => {
    expect(Object.keys(SECTION_CONTROLS).sort()).toEqual([...SECTION_IDS].sort());
  });

  it('names each control exactly once, so no table row is unreachable', () => {
    const keys = Object.values(SECTION_CONTROLS).flatMap((cs) => cs.map((c) => c.key));
    expect(keys.length).toBe(new Set(keys).size);
    // Guard the guard: a table that lost its entries would satisfy the two
    // assertions above vacuously.
    expect(keys.length).toBeGreaterThanOrEqual(13);
  });

  it('places the two transform controls BELOW the rows and everything else above', () => {
    const after = Object.values(SECTION_CONTROLS)
      .flat()
      .filter((c) => c.placement === 'after')
      .map((c) => c.key);
    expect(after.sort()).toEqual(['applyTransform', 'setOrigin']);
  });
});

describe('#458 per-section row suppression is equivalent to the global filter it replaces', () => {
  // RE-ANCHORED AT #394 P6b, AND THIS ONE HAD EXPIRED SILENTLY.
  //
  // It used to ask the routing question against a SYNTHETIC section list — a bare
  // `[sectionId]` — because that was the router's whole input. Routing is now per NODE, so
  // that call answers `null` for every key, and both assertions passed for free:
  // `expect([sectionId, null]).toContain(null)` and `expect(null).not.toBe(other)` are
  // unfalsifiable. The suite stayed green while the check measured nothing.
  //
  // The invariant is unchanged and is now asked of REAL nodes, which is strictly stronger:
  // a synthetic list could never say whether any shipped node actually homes a suppressed
  // key in the wrong card.
  //
  // INVARIANT: if a control anywhere suppresses key K, then every node that homes K must
  // home it in a section that ALSO suppresses it. Otherwise K renders as a raw row in a
  // card where nothing filters it — beside the control that exists to replace it.

  /** Every section whose controls omit `key`. */
  const suppressors = (key: string): SectionId[] =>
    SECTION_IDS.filter((s) => SECTION_CONTROLS[s].some((c) => (c.omitRowKeys ?? []).includes(key)));

  it('never homes a suppressed key in a section that does not suppress it', () => {
    const suppressed = new Set(
      Object.values(SECTION_CONTROLS)
        .flat()
        .flatMap((c) => c.omitRowKeys ?? []),
    );
    let examined = 0;
    for (const nodeType of listNodeTypes()) {
      const declared = (getNodeType(nodeType)?.inspectorSections ?? []) as readonly SectionId[];
      for (const key of declaredParamKeys(nodeType)) {
        if (!suppressed.has(key)) continue;
        const home = paramToSection(key, declared, nodeType);
        if (home === null) continue; // unrouted: the raw bucket, nothing to suppress against
        examined++;
        expect(
          suppressors(key),
          `${nodeType}.${key} is homed in '${home}', which does not suppress it`,
        ).toContain(home);
      }
    }
    // THE COMPANION THE OLD FORM LACKED. Every assertion above is inside a filtered loop,
    // so the check is only worth what the loop iterated. If a refactor empties the subject
    // again — no suppressed key homed anywhere — this fails LOUDLY instead of passing on
    // nothing, which is exactly how the previous version went blind.
    expect(examined).toBeGreaterThanOrEqual(10);
  });

  it('omits exactly the five original keys plus the nine the lens control authors', () => {
    const omitted = Object.values(SECTION_CONTROLS)
      .flat()
      .flatMap((c) => c.omitRowKeys ?? []);
    expect(omitted.sort()).toEqual([
      // #387 — the nine keys CameraLensControls writes. They are listed rather than
      // suppressed wholesale because a CameraData's `projection`/`lookAt`/`roll` route
      // to the SAME section and the control does not author them: under whole-section
      // suppression those three would render nowhere, silently.
      'dofEnabled',
      'extendAfter',
      'extendBefore',
      'fStop',
      'far',
      'focusDistance',
      'focusOnTarget',
      'fov',
      'modifiers',
      'near',
      'points',
      'sensorSize',
      // Was a `node.type === 'MaterialOverride'` skip in the caller. It routes
      // to no section, so only the pre-grouping skip keeps it off screen.
      'slotIndex',
      'zoom',
    ]);
  });

  it('reports the slot index as control-owned so it never reaches the unrouted bucket', () => {
    const ctx = ctxFor('MaterialOverride');
    expect([...controlOwnedRowKeys(['material'], ctx)]).toEqual(['slotIndex']);
    // And not for a node that does not own one — the skip must not swallow an
    // unrelated node's param of the same name.
    expect([...controlOwnedRowKeys(['material'], ctxFor('BoxData'))]).toEqual([]);
  });
});

describe('#458 possession is asked of the schema, not of the live params', () => {
  it('offers the slot selector to a MaterialOverride that has no slotIndex yet', () => {
    // `slotIndex` is `.optional()` with no default, so it is absent until a
    // slot is chosen — with the selector this assertion is about. Reading the
    // params object would make the control unreachable by construction.
    expect(ctxFor('MaterialOverride').ownsParam('slotIndex')).toBe(true);
    expect(sectionRendersCustomControl('material', ctxFor('MaterialOverride'))).toBe(true);
  });

  it('offers Set Origin to a Group saved before `pivot` existed', () => {
    // `pivot` was added to Group WITHOUT a version bump, and loading a project
    // does not re-parse per-type param schemas, so an old Group has no such key.
    expect(ctxFor('Group').ownsParam('pivot')).toBe(true);
    expect(sectionRendersCustomControl('transform', ctxFor('Group'))).toBe(true);
  });

  it('renders the environment control for a Scene whose params are empty', () => {
    // The Scene owns envSource/envIntensity/envRotationY/envBackground — there
    // is no `environment` param to possess. Declaring the section is the
    // assertion of ownership.
    expect(sectionRendersCustomControl('environment', ctxFor('Scene'))).toBe(true);
  });

  it('offers the extend + F-Modifier controls to the three channels that own them', () => {
    for (const type of [
      'KeyframeChannelNumber',
      'KeyframeChannelVec2',
      'KeyframeChannelVec3',
    ] as const) {
      expect(sectionRendersCustomControl('animate', ctxFor(type))).toBe(true);
    }
    // ...and to no other channel kind: Color/Quat/Text/Image declare `animate`
    // but own no extend rules, so the section is plain rows for them.
    for (const type of [
      'KeyframeChannelColor',
      'KeyframeChannelQuat',
      'KeyframeChannelText',
      'KeyframeChannelImage',
    ] as const) {
      expect(sectionRendersCustomControl('animate', ctxFor(type))).toBe(false);
    }
  });

  it('picks the glTF editor over the readout only when materials were captured', () => {
    const withMaterials = ctxFor('GltfChild', {
      assetRef: 'a',
      childName: 'c',
      materials: [{ name: 'm' }],
    });
    const without = ctxFor('GltfChild', { assetRef: 'a', childName: 'c', materials: [] });
    const active = (c: ReturnType<typeof ctxFor>): ControlKey[] =>
      SECTION_CONTROLS.material.filter((x) => x.applies(c)).map((x) => x.key);
    expect(active(withMaterials)).toEqual(['gltfMaterialEditor']);
    expect(active(without)).toEqual(['gltfMaterialReadout']);
    // The whole-asset node keeps the read-only readout.
    expect(active(ctxFor('GltfAsset', { assetRef: 'a' }))).toEqual(['gltfMaterialReadout']);
  });

  it('names no node type anywhere in the table', () => {
    // The table decides by possession. A node-type gate here is the failure the
    // dispatcher exists to prevent — a fused type named in a predicate stops
    // matching the day that kind splits, and the section renders empty.
    const source = Object.values(SECTION_CONTROLS)
      .flat()
      .map((c) => c.applies.toString())
      .join('\n');
    expect(source).not.toMatch(/Camera|Mesh|Scene|Gltf|Group|MaterialOverride|Keyframe/);
  });
});

// --- What the dispatcher actually emits -------------------------------------
//
// SectionBody is a plain function, so it can be CALLED and its returned element
// tree read directly — no DOM, no renderer. Each control is stubbed with a
// string naming it, so these assertions are about which controls the shared
// dispatch emits and in what order, which is the thing both call sites depend
// on and the thing that used to differ between them.

const STUB_RENDERERS = Object.fromEntries(
  Object.values(SECTION_CONTROLS)
    .flat()
    .map((c) => [c.key, (ctx: SectionCtx) => `${c.key}(${ctx.paramsNodeId},${ctx.objectNodeId})`]),
) as SectionControlRenderers;

/** Flatten the emitted tree to the strings the stubs produced, in render order. */
function emitted(
  sectionId: Parameters<typeof SectionBody>[0]['sectionId'],
  ctx: SectionCtx,
  rows: readonly (readonly [string, unknown])[] = [],
): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const kids = (n as { props?: { children?: unknown } } | null)?.props?.children;
    if (kids !== undefined) walk(kids);
  };
  walk(
    SectionBody({
      sectionId,
      ctx,
      // The cases here are written as `[key, value]` pairs because that is the shape a
      // single-node section has; `SectionBody` takes named rows since #518 so a section
      // fed by several nodes can carry each row's provenance and its own React identity.
      rows: rows.map(([key, value]) => ({ key, value })),
      renderers: STUB_RENDERERS,
      renderRow: ({ key }) => `row:${key}`,
    }),
  );
  return out;
}

describe('#458 the shared dispatcher emits the same body for a data half as for a whole node', () => {
  /** The linked half of a split: params on the data node, pose on the Object. */
  const dataHalf = (type: string, params: Record<string, unknown> = {}) =>
    makeSectionCtx({ id: 'data', type, version: 1, params, inputs: {} }, 'obj', false);

  it('renders a CurveData curve section as the control plus its non-point rows', () => {
    const rows: [string, unknown][] = [
      ['points', []],
      ['closed', false],
      ['resolution', 8],
    ];
    expect(emitted('curve', dataHalf('CurveData'), rows)).toEqual([
      'curvePoints(data,obj)',
      // `points` is owned by the control above and must not double-render.
      'row:closed',
      'row:resolution',
    ]);
  });

  it('renders a data half that declares `camera` as the lens control (the #387 shape)', () => {
    // The case this whole change exists for. Before it, the linked-data block
    // dispatched only `curve`, so this section rendered NOTHING — a titled,
    // empty card, with every automated check green. There is no camera data
    // node yet; the dispatcher is asked the question a release early, because
    // by the time one exists the answer has to already be right.
    expect(emitted('camera', dataHalf('PerspectiveCamera'), [['fov', 50]])).toEqual([
      'cameraLens(data,obj)',
    ]);
  });

  it('renders the lens control ABOVE the camera params it does not author (#387)', () => {
    // The assertion is the ROW SET, not the card's presence — and that distinction is
    // the whole point. A CameraData declares only `camera`, so its `projection`,
    // `lookAt` and `roll` route here, and CameraLensControls authors none of them.
    // Restore `suppressesAllRows` on this section and the three rows below vanish while
    // the card stays non-empty (the control is still there), which is why the earlier
    // instance of this bug was detectable only in a browser.
    const rows: [string, unknown][] = [
      ['fov', 28],
      ['projection', 'Perspective'],
      ['lookAt', [0, 0, 0]],
      ['roll', 0],
    ];
    expect(emitted('camera', dataHalf('PerspectiveCamera'), rows)).toEqual([
      'cameraLens(data,obj)',
      // `fov` is absent: the control owns it. The other three are not owned, so they
      // fall through as labelled generic rows.
      'row:projection',
      'row:lookAt',
      'row:roll',
    ]);
  });

  it('hands the lens control BOTH ids, not one twice', () => {
    // The lens reads its params from the data half and its pose from the
    // Object. Collapsing the two would resolve the pose off a poseless node —
    // which returns a fallback pose rather than an error, so the panel would
    // show a plausible wrong focus distance and nothing would report it.
    const [lens] = emitted('camera', dataHalf('PerspectiveCamera'));
    expect(lens).toBe('cameraLens(data,obj)');
    expect(lens).not.toBe('cameraLens(data,data)');
    expect(lens).not.toBe('cameraLens(obj,obj)');
  });

  it('puts the transform controls BELOW the rows', () => {
    const ctx = makeSectionCtx(
      { id: 'g', type: 'Group', version: 1, params: {}, inputs: {} },
      'g',
      true,
    );
    expect(emitted('transform', ctx, [['position', [0, 0, 0]]])).toEqual([
      'row:position',
      'applyTransform(g,g)',
      'setOrigin(g,g)',
    ]);
  });

  it('suppresses every row in a section one control owns outright', () => {
    expect(emitted('environment', dataHalf('Scene'), [['envIntensity', 1]])).toEqual([
      'sceneEnvironment(data,obj)',
    ]);
  });
});
