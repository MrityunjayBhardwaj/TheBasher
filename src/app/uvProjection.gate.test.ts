// #994 — THE GATE THE ISSUE ASKS FOR, AND IT IS AN ADVERSARIAL ONE.
//
// The operator's entire claim is that it AUTHORS a corner-domain layer rather than lifting one.
// #994 states the falsification and this file runs it, verbatim:
//
//     count render vertices read by more than one loop, then count how many of those carry
//     DIFFERING values. A non-zero second number is the entire point of the operator, and a
//     zero means it has quietly become another lift.
//
// 🔴 THE FIRST NUMBER ALONE PROVES NOTHING, AND THAT IS WHY BOTH ARE ASSERTED. Sharing is the
// OPPORTUNITY, never the event: an 8x6 sphere shares 45 render vertices between loops no matter
// what writes its UVs, and today's lift shares exactly the same 45 while disagreeing at none of
// them. A gate that checked only "are vertices shared?" would be green for a lift.
//
// ⚠️ AND THE SECOND NUMBER ALONE PROVES NOTHING EITHER, WITHOUT A CONTROL THAT READS ZERO. A
// probe with a mis-set tolerance, a mis-walked rim or an off-by-one into the corner array
// reports disagreement everywhere and looks like a triumph. So the same statistic is taken over
// two things that MUST read zero — the UV0 lift ([[V449]] proves it structurally), and this
// operator's own arithmetic with the per-face choice removed — over the identical 45 vertices,
// the identical rims and the identical comparison. Measured when this landed:
//
//     cube projection (#994)                45 shared   22 DISAGREEING
//     CONTROL A — the UV0 lift              45 shared    0
//     CONTROL B — per-face choice removed   45 shared    0
//
// Control B is the sharper of the two, because it is this file's own code with ONE line
// changed. It is also what settles a scoping question #994 left open by offering "planar or box
// projection" as if either would do: a planar projection is a function of position alone, so it
// agrees at every shared vertex by construction and authors nothing. Only the per-face choice
// makes a producer.
//
// REF: src/app/uvProjection.ts (the subject); src/app/uvAttributes.ts (`readMeshUVs` — control
//      A); src/nodes/types.ts (the `uvProject` descriptor); issues #994, #786, #881, #959.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clear,
  getForRead,
  readGeometry,
  availabilityOf,
  drawnByAssetClone,
} from './geometryRegistry';
import { alignedSplitRims } from './builtRims';
import {
  arrayGeometryRef,
  boxGeometryRef,
  sphereGeometryRef,
  uvProjectGeometryRef,
} from './modifierGeometry';
import { projectMeshUVs } from './uvProjection';
import { readMeshUVs } from './uvAttributes';
import { read } from './attributeStore';
import { cornerCountOf, faceCountOf } from './faceCount';
import { pointCountOf } from './pointIdentity';
import { weldedPolygonsOf } from './edgeIdentity';
import { polygonLayoutOf } from './polygonLayout';
import { UV_MAP, UV_PROJECT } from '../nodes/attributes';
import type { GeometryRef } from '../nodes/types';

const SPHERE = () => sphereGeometryRef(1, 8, 6, null);
const BOX = () => boxGeometryRef([1, 1, 1], null);
const SIZE = 2;

/**
 * #994's falsification over an arbitrary corner-domain layer: how many render vertices are read
 * by more than one loop, and how many of those carry differing values.
 *
 * Takes the layer as data rather than reading it off a ref, which is the whole reason a control
 * is possible: the lift, the projection and a deliberately-crippled projection all go through
 * THIS function, so a difference in the answer cannot be a difference in the instrument.
 */
function sharedAndDisagreeing(ref: GeometryRef, uvs: Float32Array) {
  const result = readGeometry(ref);
  expect(result.status, 'the subject did not build').toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  const polygons = alignedSplitRims(ref, result.geometry);
  expect(polygons, 'the rims did not come off the built index').not.toBeNull();

  const perVertex = new Map<number, { u: number; v: number }[]>();
  let corner = 0;
  for (const rim of polygons!) {
    for (const vertex of rim) {
      const seen = perVertex.get(vertex) ?? [];
      seen.push({ u: uvs[corner * 2], v: uvs[corner * 2 + 1] });
      perVertex.set(vertex, seen);
      corner++;
    }
  }
  // The corner total is asserted against the walk rather than assumed: a layer half the length
  // it should be would otherwise read as agreement at every vertex the walk never reached.
  expect(uvs.length, 'the layer does not cover every corner').toBe(corner * 2);

  let shared = 0;
  let disagreeing = 0;
  for (const [, values] of perVertex) {
    if (values.length < 2) continue;
    shared++;
    const first = values[0];
    // 1e-6, not exact equality: these are float32 values read back through a Float32Array, and
    // an exact comparison here would report float noise as authorship — the loudest possible
    // false positive for a gate whose whole subject is a non-zero count.
    if (values.some((x) => Math.abs(x.u - first.u) > 1e-6 || Math.abs(x.v - first.v) > 1e-6))
      disagreeing++;
  }
  return { renderVertices: perVertex.size, corners: corner, shared, disagreeing };
}

/** The projected layer's raw values, through the operator's real road. */
function projected(ref: GeometryRef): Float32Array {
  const verdict = projectMeshUVs(ref);
  expect(verdict.kind, verdict.kind === 'not-derivable' ? verdict.why : '').toBe('resident');
  if (verdict.kind !== 'resident') throw new Error('unreachable');
  const layer = read(verdict.key)?.[UV_PROJECT];
  expect(layer, 'the projection minted no UVProject layer').toBeDefined();
  expect(layer!.domain, 'the projected layer is not at the corner domain').toBe('corner');
  return layer!.data as Float32Array;
}

describe('#994 the cube projection AUTHORS a corner layer', () => {
  beforeEach(() => clear());

  it('🔴 THE FALSIFICATION: corners at one render vertex DISAGREE', () => {
    const ref = uvProjectGeometryRef(SPHERE(), SIZE);
    const stat = sharedAndDisagreeing(ref, projected(ref));

    // Stated exactly rather than as `> 0`, for the reason every census in this repo states its
    // numbers exactly: a floor cannot catch a drop, and a projection that quietly stopped
    // choosing per face on five of the six sides would still clear `> 0`.
    expect(stat).toEqual({ renderVertices: 61, corners: 176, shared: 45, disagreeing: 22 });
  });

  it('🔴 CONTROL A — the UV0 LIFT reads ZERO over the SAME 45 vertices', () => {
    // [[V449]], measured rather than cited. The lift gathers a per-vertex buffer through these
    // same rims, so its value is constant on every loop -> vertex fibre. If this row ever reads
    // non-zero, the instrument above is broken and its 22 means nothing.
    const source = SPHERE();
    const uvRead = readMeshUVs(source);
    expect(uvRead.status).toBe('ok');
    if (uvRead.status !== 'ok' || uvRead.attribute.kind !== 'resident')
      throw new Error('the lift did not reach its minting arm');
    const lifted = read(uvRead.attribute.key)![UV_MAP].data as Float32Array;

    const stat = sharedAndDisagreeing(source, lifted);
    expect(stat.shared, 'the control must have the same OPPORTUNITY as the subject').toBe(45);
    expect(stat.disagreeing).toBe(0);
  });

  it('🔴 CONTROL B — the same arithmetic with the PER-FACE choice removed reads ZERO', () => {
    // This file's own projection, planar: every face onto +Z instead of onto the nearest cube
    // side. One line different from the operator, and it authors nothing — which is what says
    // the 22 above is attributable to the per-face choice and to nothing else in the pipeline.
    const ref = uvProjectGeometryRef(SPHERE(), SIZE);
    const geometry = getForRead(ref)!;
    const position = geometry.getAttribute('position');
    const polygons = alignedSplitRims(ref, geometry)!;
    let corners = 0;
    for (const rim of polygons) corners += rim.length;
    const planar = new Float32Array(corners * 2);
    let at = 0;
    for (const rim of polygons)
      for (const vertex of rim) {
        planar[at * 2] = position.getX(vertex) / SIZE + 0.5;
        planar[at * 2 + 1] = position.getY(vertex) / SIZE + 0.5;
        at++;
      }

    const stat = sharedAndDisagreeing(ref, planar);
    expect(stat.shared).toBe(45);
    expect(stat.disagreeing).toBe(0);
  });

  it('the layer carries exactly as many elements as the corner domain has', () => {
    // The model's own rule — "an attribute at a domain must carry exactly as many elements as
    // that domain has" — and it is the rule the UV0 lift was found BREAKING at #776, silently,
    // for every shape that is not a box. A box has 24 render vertices and 24 loops, so a
    // producer that confused the two passed every test it had; a sphere separates them 61 to
    // 176. Both shapes are asserted here for exactly that reason: the box row alone cannot fail.
    for (const [source, corners] of [
      [BOX(), 24],
      [SPHERE(), 176],
    ] as const) {
      const ref = uvProjectGeometryRef(source, SIZE);
      const verdict = projectMeshUVs(ref);
      expect(verdict.kind).toBe('resident');
      if (verdict.kind !== 'resident') throw new Error('unreachable');
      const layer = read(verdict.key)![UV_PROJECT];
      expect(layer.count).toBe(corners);
      expect(layer.count).toBe(cornerCountOf(ref.descriptor));
    }
  });

  it('⚠️ THE LAYER DOES NOT SURVIVE A DOWNSTREAM OPERATOR, and that is recorded not hidden', () => {
    // #881's subject, measured here rather than described, because a limit nobody has run is a
    // limit that can be wrong. The projected layer is minted on the READ road keyed by the
    // PROJECTED handle — it cannot be in an attribute key, because a key is content-derived and
    // the values need built positions. A downstream modifier gathers its source's attribute
    // KEY, so there is nothing there for it to carry, and asking the array for a projection
    // gets the refusal below rather than a wrong answer.
    //
    // This is the honest state of "it composes as an operator like any other in the chain": the
    // OPERATOR composes — it is a legal source and the array builds over it — while the LAYER
    // stops at the projection. Carriage through a minting kind is #881 and is out of scope of
    // #994 by that issue's own words.
    const projection = uvProjectGeometryRef(BOX(), SIZE);
    const downstream = arrayGeometryRef(projection, 3, [2, 0, 0]);

    // The operator composes: the array is a real handle over the projection and builds.
    expect(downstream.descriptor.kind).toBe('array');
    expect(getForRead(downstream)).not.toBeNull();

    // The layer does not: asked for a projection, the array says what it is instead of
    // answering with the source's values under a shape they do not describe.
    const verdict = projectMeshUVs(downstream);
    expect(verdict.kind).toBe('not-derivable');
    if (verdict.kind === 'not-derivable') expect(verdict.why).toContain("'array'");
  });

  it('a BOX has no shared vertices at all, and the row says so instead of hiding it', () => {
    // Honest negative. A box's buffer is fully split — 24 render vertices for 24 loops — so
    // there is no opportunity to author a disagreement, and the operator authoring nothing
    // OBSERVABLE here is correct rather than a failure. Recorded because "the gate passes on a
    // sphere" invites the assumption that it would pass on anything.
    const ref = uvProjectGeometryRef(BOX(), SIZE);
    expect(sharedAndDisagreeing(ref, projected(ref))).toEqual({
      renderVertices: 24,
      corners: 24,
      shared: 0,
      disagreeing: 0,
    });
  });
});

describe('#994 a projection reshapes NOTHING', () => {
  beforeEach(() => clear());

  it('every topology answer is its SOURCE`s, not merely equal to it', () => {
    const source = SPHERE();
    const ref = uvProjectGeometryRef(source, SIZE);

    expect(faceCountOf(ref.descriptor)).toBe(faceCountOf(source.descriptor));
    expect(pointCountOf(ref.descriptor)).toEqual(pointCountOf(source.descriptor));
    expect(weldedPolygonsOf(ref.descriptor)).toEqual(weldedPolygonsOf(source.descriptor));
    expect(polygonLayoutOf(ref.descriptor)).toEqual(polygonLayoutOf(source.descriptor));

    // 🔑 AND THE LAYOUT IS AN ANSWER, NOT A REFUSAL — the one derived kind for which it is.
    // `array`/`mirror`/`subset` answer `not-yet` here because a copy's rim needs its source's
    // split vertex count. A projection makes no copy, so its split numbering IS its source's.
    expect(polygonLayoutOf(ref.descriptor).kind).toBe('laid-out');
  });

  it('🔑 the registry hands back the SOURCE`s instance, and takes no entry of its own', () => {
    const source = SPHERE();
    const ref = uvProjectGeometryRef(source, SIZE);

    // Identity, not equality. A copy would be a second buffer free to drift, and — measured
    // before this shape was chosen — a shared-attribute copy would be disposed by the geometry
    // sweep while the source was still drawing from those buffers.
    expect(getForRead(ref)).toBe(getForRead(source));

    // And availability is inherited VERBATIM rather than composed.
    expect(availabilityOf(ref.descriptor)).toBe(availabilityOf(source.descriptor));
  });

  it('🔴 VERBATIM, NOT COMPOSED — and only a glTF source can show the difference', () => {
    // ⚠️ THE ROW ABOVE CANNOT MAKE THIS CLAIM, AND THAT WAS MEASURED RATHER THAN NOTICED. It
    // asserts equality over a PROCEDURAL source, where `composedOverSource('procedural')` is
    // itself `'procedural'` — so the two rules agree and the assertion is green under both.
    // Replacing the verbatim inheritance with `composedOverSource` left the whole file passing,
    // which makes that row a fixture that cannot exhibit the property it names.
    //
    // A glTF source separates them, because that is the one input on which the rules differ:
    //   composed → 'mounting'  ("the registry will build this once the asset mounts")
    //   verbatim → 'clone'     ("these buffers ARE the asset clone's")
    // and only the second is true of a projection, which builds nothing and hands the source's
    // own instance back. `drawnByAssetClone` reads this answer, and a false `'mounting'` would
    // let `getForAttach` put buffers into the scene graph that the clone is already drawing.
    const asset: GeometryRef = {
      key: 'gltf|asset-a|Cube',
      descriptor: { kind: 'gltf', assetRef: 'asset-a', childName: 'Cube' },
    };
    const ref = uvProjectGeometryRef(asset, SIZE);

    expect(availabilityOf(asset.descriptor)).toBe('clone');
    expect(availabilityOf(ref.descriptor)).toBe('clone');
    expect(drawnByAssetClone(ref.descriptor)).toBe(true);
    // The composed answer, named as the thing this row exists to exclude.
    expect(availabilityOf(ref.descriptor)).not.toBe('mounting');
  });

  it('two sizes are two layers, and one size is one', () => {
    const source = SPHERE();
    // The size folds into the key for the reason `bevel.amount` does: one cached entry serving
    // both would hand whichever was minted first to the other.
    expect(uvProjectGeometryRef(source, 2).key).not.toBe(uvProjectGeometryRef(source, 4).key);
    expect(uvProjectGeometryRef(source, 2).key).toBe(uvProjectGeometryRef(source, 2).key);

    const two = projected(uvProjectGeometryRef(source, 2));
    const four = projected(uvProjectGeometryRef(source, 4));
    expect(Array.from(two)).not.toEqual(Array.from(four));
  });

  it('the source`s own attribute component rides through, rather than being dropped', () => {
    // `mintTiledModifierAttributes` refuses this kind, and its refusal reads as "this geometry
    // has no attributes" — which would silently drop a source's per-face material assignment.
    // The builder passes the source's key through instead, and this is the row that says so.
    const source = boxGeometryRef([1, 1, 1], 'fixture-attr-key');
    const ref = uvProjectGeometryRef(source, SIZE);
    expect(ref.attributeKey).toBe('fixture-attr-key');
    expect(ref.key).toContain('|a:fixture-attr-key');
  });
});

describe('#994 the states that have no constructor', () => {
  beforeEach(() => clear());

  it('a non-positive cube is refused at the builder, not at the render walk', () => {
    expect(() => uvProjectGeometryRef(SPHERE(), 0)).toThrow(/positive size/);
    expect(() => uvProjectGeometryRef(SPHERE(), -1)).toThrow(/positive size/);
  });

  it('a handle that is not a projection is refused BY NAME', () => {
    // The projection's parameters live on the descriptor, so a handle carrying another kind
    // does not say which cube to project onto. It answers rather than guessing a default.
    const verdict = projectMeshUVs(SPHERE());
    expect(verdict.kind).toBe('not-derivable');
    if (verdict.kind === 'not-derivable') expect(verdict.why).toContain("'sphere'");
  });
});
