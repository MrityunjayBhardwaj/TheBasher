// THE GATE THAT PAYS FOR THE DESCRIPTOR WALK (#1062).
//
// `cornerLayerNamesOf` derives, from a descriptor alone, which named corner layers the built
// mesh will carry — and therefore states a SECOND TIME what each builder in `geometryRegistry`
// actually writes. Two statements of one fact drift, and this drift is the dangerous kind: a
// wrong answer here does not throw, it silently resolves a material's named layer to the wrong
// buffer or to none, and the mesh draws a plausible wrong picture. That is a lying label
// ([[H309]] / [[V176]]) — covered by every behavioural test and wrong.
//
// So the walk is not trusted: for every descriptor kind the sync registry can build, this
// BUILDS the geometry and asserts the walk names exactly the corner-layer buffers the built
// geometry really carries. A builder that starts or stops carrying a layer reds this gate on
// its next run.
//
// 🔴 THE ORDER IS PINNED, NOT JUST THE SET — AND BY DATA, NOT BY LIST POSITION. The name →
// buffer rule is positional (`cornerLayerBufferNames` counts `float2`s up `uv`, `uv1`, …), so
// a walk returning the right names in the wrong order sends every name to the wrong buffer
// while passing any set comparison. Comparing the two lists element-wise does not catch it
// either, and was measured not to: the walk's list is in LAYER order and the built buffers in
// the buffer model's order, which legitimately differ whenever a colour sits between two UV
// sets. So each fixture layer carries a distinct constant, and the buffer the walk predicts
// for it is read back and must hold THAT constant.
//
// ⚠️ ONE ARM THIS TIER CANNOT REACH: the bevel's narrowing. See its own row for the measured
// reason and where it is pinned instead.
//
// REF: src/app/cornerLayerNames.ts (the subject); src/app/meshGeometryData.ts
//      (`cornerLayerBufferNames`, `CORNER_LAYER_SLOTS`); issues #1062, #1117.

import { beforeEach, describe, expect, it } from 'vitest';
import type { GeometryDescriptor, GeometryRef, MeshGeometryData } from '../nodes/types';
import { UV_MAP, UV_PROJECT, COLOR_LAYER, uvLayerName } from '../nodes/attributes';
import * as registry from './geometryRegistry';
import { cornerLayerNamesOf } from './cornerLayerNames';
import { cornerLayerBufferNames, CORNER_LAYER_SLOTS } from './meshGeometryData';

/** The value layer `i` of a fixture mesh is filled with — distinct, and exactly recoverable. */
function fillFor(i: number): number {
  return (i + 1) / 10;
}

/** A unit quad as two triangles — the smallest mesh that carries real corners. */
function quad(
  layerNames: readonly { name: string; type: 'float2' | 'float4' }[],
): MeshGeometryData {
  const corners = 6;
  return {
    points: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    faceSizes: new Uint32Array([3, 3]),
    cornerPoints: new Uint32Array([0, 1, 2, 0, 2, 3]),
    cornerLayers: layerNames.map(({ name, type }, i) => ({
      name,
      type,
      // A DISTINCT CONSTANT PER LAYER, and that is what makes this gate more than a name
      // check: the buffer the walk predicts for a layer is read back and must carry THAT
      // layer's value. A builder copying the right names into the wrong slots passes any
      // set comparison and fails this.
      data: new Float32Array(corners * (type === 'float4' ? 4 : 2)).fill(fillFor(i)),
    })),
    cornerNormals: null,
    faceLayers: [],
  };
}

/**
 * The cube-projection size every `uvProject` case uses.
 *
 * 🔴 NEVER 1. Measured: a size-1 projection over a unit mesh reproduces that mesh's own UVs on
 * all 24 of a box's vertices, so a case built at 1 cannot tell a projection that ran from one
 * that did nothing. At 3 every vertex differs (U in [0.33, 0.67]).
 */
const PROJECTION_SIZE = 3;

function ref(key: string, descriptor: GeometryDescriptor): GeometryRef {
  return { key, descriptor };
}

/** The corner-layer attributes a BUILT geometry really carries, in buffer order. */
function builtCornerSlots(geometry: { attributes: Record<string, unknown> }): readonly string[] {
  // Filtered through the one derived list rather than a spelled one, so a new slot added to
  // the model is picked up here without editing this gate.
  return CORNER_LAYER_SLOTS.filter((slot) => geometry.attributes[slot] !== undefined);
}

describe('#1062 — the descriptor walk agrees with what the builders write', () => {
  beforeEach(() => registry.clear());

  // Every sync-buildable kind, each with the layer set that exercises its carriage rule.
  const CASES: readonly { name: string; ref: GeometryRef }[] = (() => {
    const plainMesh = ref('m-plain', { kind: 'mesh', data: quad([]) });
    const uvMesh = ref('m-uv', {
      kind: 'mesh',
      data: quad([{ name: UV_MAP, type: 'float2' }]),
    });
    // The shape #1062 exists for: two UV sets AND a colour, named as the reader spells them.
    const richMesh = ref('m-rich', {
      kind: 'mesh',
      data: quad([
        { name: UV_MAP, type: 'float2' },
        { name: uvLayerName(1), type: 'float2' },
        { name: COLOR_LAYER, type: 'float4' },
      ]),
    });
    // Interleaved, so a walk that assumes "all UVs then the colour" is caught: the colour sits
    // BETWEEN two UV sets in list order, and must still land in `color` while the second UV
    // set lands in `uv1`.
    const interleaved = ref('m-inter', {
      kind: 'mesh',
      data: quad([
        { name: UV_MAP, type: 'float2' },
        { name: COLOR_LAYER, type: 'float4' },
        { name: uvLayerName(1), type: 'float2' },
      ]),
    });
    return [
      { name: 'box', ref: ref('g-box', { kind: 'box', size: [1, 1, 1] }) },
      {
        name: 'sphere',
        ref: ref('g-sphere', { kind: 'sphere', radius: 1, widthSegments: 8, heightSegments: 6 }),
      },
      { name: 'mesh (no layers)', ref: plainMesh },
      { name: 'mesh (one UV set)', ref: uvMesh },
      { name: 'mesh (two UV sets + colour)', ref: richMesh },
      { name: 'mesh (colour BETWEEN two UV sets)', ref: interleaved },
      {
        name: 'array over a rich mesh',
        ref: ref('d-array', { kind: 'array', source: richMesh, count: 3, offset: [2, 0, 0] }),
      },
      {
        name: 'mirror over a rich mesh',
        ref: ref('d-mirror', { kind: 'mirror', source: richMesh, axis: 'x', offset: 0 }),
      },
      {
        // A bevel carries its source's UV set and refuses anything more (#881). Over a BOX,
        // because a bevel needs closed topology to lay out and declines the open quad above —
        // which the refusal guard caught rather than passing as an empty comparison.
        name: 'bevel over a box',
        ref: ref('d-bevel', {
          kind: 'bevel',
          source: ref('b-src', { kind: 'box', size: [1, 1, 1] }),
          amount: 0.1,
        }),
      },
      {
        name: 'subset over a rich mesh',
        ref: ref('d-subset', {
          kind: 'subset',
          source: richMesh,
          scope: '0',
          domain: 'face',
          keep: true,
        }),
      },
      {
        name: 'uvProject over a mesh with one UV set',
        ref: ref('d-proj', { kind: 'uvProject', source: uvMesh, size: PROJECTION_SIZE }),
      },
      {
        name: 'uvProject over a mesh with NO UV set',
        ref: ref('d-proj-bare', { kind: 'uvProject', source: plainMesh, size: PROJECTION_SIZE }),
      },
    ];
  })();

  it.each(CASES)('$name — the walk names exactly the buffers the build writes', ({ ref: r }) => {
    const built = registry.getForRead(r);
    // A refusal is not a pass. If the builder declined, this case proves nothing and the gate
    // must say so rather than comparing two empty lists and reporting success ([[H736]]).
    expect(built, 'the builder refused this descriptor — the case measures nothing').not.toBeNull();

    const walked = cornerLayerNamesOf(r.descriptor);
    const predicted = cornerLayerBufferNames(walked);
    const actual = builtCornerSlots(built as unknown as { attributes: Record<string, unknown> });

    // Compared as SETS: `predicted` is in the layer LIST's order and `actual` in the buffer
    // model's order, and those differ legitimately whenever a colour sits between two UV
    // sets. Order is pinned by the value check below, which is the stronger question anyway.
    expect([...predicted].sort()).toEqual([...actual].sort());

    // 🔴 AND THE MAPPING ITSELF, BY DATA, for the one kind whose values this fixture knows.
    // Without this the gate only asks "are these the right buffer NAMES" — it would pass a
    // walk that returned the right names in an order that sends every material's named layer
    // to the wrong buffer.
    if (r.descriptor.kind === 'mesh') {
      walked.forEach((layer, i) => {
        const attribute = (
          built as unknown as {
            getAttribute(n: string): { getX(i: number): number } | undefined;
          }
        ).getAttribute(predicted[i]);
        expect(attribute, `no ${predicted[i]} buffer for layer ${layer.name}`).toBeDefined();
        expect(attribute?.getX(0)).toBeCloseTo(fillFor(i), 6);
      });
    }
  });

  it('names a projection for what it authors, never for the layer it replaced', () => {
    // The V515 case stated on its own, because it is the reason names are looked up and never
    // parsed: the projected layer sits in the `uv` buffer under a name with no number in it.
    const uvMesh = ref('p-src', { kind: 'mesh', data: quad([{ name: UV_MAP, type: 'float2' }]) });
    const projected = cornerLayerNamesOf({
      kind: 'uvProject',
      source: uvMesh,
      size: PROJECTION_SIZE,
    });

    expect(projected).toEqual([{ name: UV_PROJECT, type: 'float2' }]);
    // And the source's name is GONE — a material still naming `UVMap` must stop resolving,
    // because that layer is no longer what the mesh draws.
    expect(projected.some((l) => l.name === UV_MAP)).toBe(false);
  });

  it('carries a colour through a projection, in the buffer it belongs in', () => {
    // The projection replaces the first UV set and touches nothing else — so a colour layer
    // survives it, which is what lets a projected mesh still draw its vertex colours.
    const rich = ref('p-rich', {
      kind: 'mesh',
      data: quad([
        { name: UV_MAP, type: 'float2' },
        { name: COLOR_LAYER, type: 'float4' },
      ]),
    });
    const walked = cornerLayerNamesOf({ kind: 'uvProject', source: rich, size: PROJECTION_SIZE });

    expect(walked).toEqual([
      { name: UV_PROJECT, type: 'float2' },
      { name: COLOR_LAYER, type: 'float4' },
    ]);
    expect(cornerLayerBufferNames(walked)).toEqual(['uv', 'color']);
  });

  it('a bevel narrows to the one UV layer it carries, and nothing else', () => {
    // ⚠️ A DECLARED LIMIT, MEASURED RATHER THAN ASSUMED. This arm CANNOT be reached through
    // the conformance cases above, and that was found by falsification: mutating the bevel
    // arm to carry the whole source list left all 15 build-backed cases green. The reason is
    // structural — `buildBevel` REFUSES any source carrying a layer it cannot interpolate
    // (#881), so every descriptor that would distinguish the two answers is one the builder
    // declines to build, and there is no geometry to compare against.
    //
    // So the narrowing is pinned HERE, directly on the walk. It is not decoration: the
    // refusal is #881's to lift, and on the day it is, this arm is already the truthful
    // description of what a bevel draws — and this row is what keeps it honest meanwhile.
    const rich = ref('b-rich', {
      kind: 'mesh',
      data: quad([
        { name: UV_MAP, type: 'float2' },
        { name: uvLayerName(1), type: 'float2' },
        { name: COLOR_LAYER, type: 'float4' },
      ]),
    });
    expect(cornerLayerNamesOf({ kind: 'bevel', source: rich, amount: 0.1 })).toEqual([
      { name: UV_MAP, type: 'float2' },
    ]);
  });

  it('a gltf handle offers NO layer list, which is not the same as no layers', () => {
    // The file's-copy road resolves by NUMBER (`uvLayerIndex`), so this walk must decline
    // rather than invent names three never gave those buffers.
    // The real descriptor shape, uncast: a cast here hid a wrong shape from every tier, since
    // vitest does not type-check and `npm run typecheck` excludes test files.
    expect(cornerLayerNamesOf({ kind: 'gltf', assetRef: 'a', childName: 'c' })).toEqual([]);
  });
});
