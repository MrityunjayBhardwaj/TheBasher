// #1036 — a NAMED FACE GROUP survives a topology change on an IMPORTED mesh, and the point
// domain refuses on its own behalf instead of on the whole set's.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────
//
// `mintTiledModifierAttributes` took all three orders unconditionally and returned `null` if
// any was missing. That was free while no imported mesh could carry an attribute at all; the
// captured face count (#1023/#1025) made one able to, and the cost arrived with it — a named
// FACE group was discarded because the POINT domain could not answer, which is the same
// aggregate-refusing-for-an-unasked-domain shape #825 had already fixed one domain over.
//
// ── THE ROWS, AND WHAT EACH WOULD CATCH ───────────────────────────────────────────────────
//
//   1  the discriminating observation of #734's flagship, on a glTF rather than a box: name
//      faces, change the topology, and read the SAME NAME back. Asserted as the membership
//      pattern and not as "something was minted" — a key can mint while the name is gone.
//   2  the box control, unchanged, so a row going quiet says which of the two moved.
//   3  the precondition proven LIVE: the point order really is absent here. Without this the
//      rows above would pass identically on a source that has one, testing nothing.
//   4  the refusal is NARROW — point refuses, face lays out, on the SAME absent point order,
//      so the fix cannot have opened the point domain by accident.
//   5  `baked` still cannot carry a group, which is the half of the old limit that did NOT
//      lift; pinned so the correction in `ComponentGroupOp.ts` cannot drift from the code.
//
// REF: src/nodes/meshAttributes.ts (`carriageForDomain` point arm, `mintTiledModifierAttributes`);
//      src/nodes/ComponentGroupOp.ts (the corrected limit); issues #1036, #734, #1027, #1023,
//      #1025, #825 (the corner precedent), #717.

import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { AttributeData } from '../nodes/attributes';
import type { GeometryDescriptor, GeometryRef, ObjectData } from '../nodes/types';
import { arrayGeometryRef, boxGeometryRef, refWithAttributeKey } from './modifierGeometry';
import { ComponentGroupOpNode } from '../nodes/ComponentGroupOp';
import { carriageForDomain, mintTiledModifierAttributes } from '../nodes/meshAttributes';
import { resolveComponentSelection, SCOPE_PARAM } from '../nodes/componentSelection';
import { tiledFaceOrder, tiledCornerOrder, faceCountOf } from './faceCount';
import { tiledPointOrder } from './pointIdentity';
import { groupLookupFor } from './componentGroupLookup';
import { insert } from './attributeStore';
import { __clearGltfCloneRegistryForTests, registerGltfClone } from './asset/gltfCloneRegistry';

const ASSET = 'u/imported-named-group.gltf';
const CHILD = 'Imported';
/** A three.js box is 12 triangles, so an imported one is 12 triangular faces. */
const IMPORTED_FACES = 12;

afterEach(() => __clearGltfCloneRegistryForTests());

function mountClone() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.name = CHILD;
  const group = new THREE.Group();
  group.add(mesh);
  registerGltfClone(ASSET, group);
}

function importedRef(): GeometryRef {
  const descriptor: GeometryDescriptor = {
    kind: 'gltf',
    assetRef: ASSET,
    childName: CHILD,
    faceCount: IMPORTED_FACES,
  };
  return { key: `k|${JSON.stringify(descriptor)}`, descriptor };
}

/** Name a group through the PRODUCTION operator and the PRODUCTION resolver. */
function nameAGroup(geometry: GeometryRef, name: string, query: string) {
  const src: ObjectData = { kind: 'MeshData', geometry, material: null } as unknown as ObjectData;
  const params = { name, muted: false, [SCOPE_PARAM]: query };
  // Resolved rather than hand-built: a fabricated selection is what
  // `componentScopeChannel.gate.test.ts` censuses against.
  const selection = resolveComponentSelection(src, params, 'face');
  return ComponentGroupOpNode.evaluate!(
    params as never,
    { target: src } as never,
    {} as never,
    selection as never,
  ) as { geometry?: GeometryRef; attributeKey?: string };
}

/** Membership of `name`, as a compact string, so a wrong pattern reads at a glance. */
function membership(ref: GeometryRef, key: string, name: string): string | null {
  const data = groupLookupFor({ ...ref, attributeKey: key }, 'face')(name);
  return data === null ? null : Array.from(data).join('');
}

describe('#1036 — a named group rides an imported mesh through a topology change', () => {
  it('1 — the flagship observation, on a glTF: name faces, array it, read the name back', () => {
    mountClone();
    const named = nameAGroup(importedRef(), 'arm', '0-2');
    expect(named.attributeKey).toBeDefined();
    expect(membership(named.geometry!, named.attributeKey!, 'arm')).toBe('111000000000');

    const arrayed = arrayGeometryRef(named.geometry!, 3, [2, 0, 0], null);
    expect(faceCountOf(arrayed.descriptor)).toBe(IMPORTED_FACES * 3);
    const minted = mintTiledModifierAttributes(arrayed.descriptor);
    // Was `null` before #1036 — the whole set dropped on the point order's absence.
    expect(minted).not.toBeNull();
    expect(membership(arrayed, minted!, 'arm')).toBe('111000000000111000000000111000000000');
  });

  it('2 — the box control is unchanged', () => {
    const named = nameAGroup(boxGeometryRef([1, 1, 1], null), 'arm', '0-2');
    expect(membership(named.geometry!, named.attributeKey!, 'arm')).toBe('111000');
    const arrayed = arrayGeometryRef(named.geometry!, 3, [2, 0, 0], null);
    const minted = mintTiledModifierAttributes(arrayed.descriptor);
    expect(minted).not.toBeNull();
    expect(membership(arrayed, minted!, 'arm')).toBe('111000111000111000');
  });

  it('3 — the precondition is live: an imported source really has NO point order', () => {
    // Without this row, rows 1 and 2 would pass identically on a source that HAS a point
    // order, and neither would be testing the thing #1036 changed.
    mountClone();
    const arrayed = arrayGeometryRef(importedRef(), 3, [2, 0, 0], null);
    expect(tiledPointOrder(arrayed.descriptor)).toBeNull();
    // …while the two orders the face domain needs both answer, which is what makes the old
    // behaviour a refusal on behalf of an unasked domain rather than a broken descriptor.
    expect(tiledFaceOrder(arrayed.descriptor)).not.toBeNull();
    expect(tiledCornerOrder(arrayed.descriptor)).not.toBeNull();
  });

  it('4 — the refusal is narrow: point refuses, face lays out, same absent point order', () => {
    mountClone();
    const arrayed = arrayGeometryRef(importedRef(), 3, [2, 0, 0], null);
    const faces = tiledFaceOrder(arrayed.descriptor)!;
    const corners = tiledCornerOrder(arrayed.descriptor);

    const point: AttributeData = {
      domain: 'point',
      type: 'int',
      count: 8,
      data: Int32Array.from([5, 5, 5, 5, 5, 5, 5, 5]),
    } as never;
    const face: AttributeData = {
      domain: 'face',
      type: 'int',
      count: IMPORTED_FACES,
      data: Int32Array.from([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    } as never;

    const pointCarriage = carriageForDomain(point, 'array', faces, corners, null);
    expect(pointCarriage.kind).toBe('refused');
    // Named, not generic: the message has to say it is about THIS DATUM'S DOMAIN, or a reader
    // meets it and concludes the geometry is broken.
    if (pointCarriage.kind === 'refused') {
      expect(pointCarriage.why).toContain("'point' domain");
      expect(pointCarriage.why).toContain('face and corner domains are unaffected');
    }
    expect(carriageForDomain(face, 'array', faces, corners, null).kind).toBe('laid-out');
  });

  it('4b — a point attribute is dropped from the set while the face group rides through', () => {
    mountClone();
    const key = 'imported-named-group|both-domains';
    insert(
      key,
      {
        'group:arm': {
          domain: 'face',
          type: 'int',
          count: IMPORTED_FACES,
          data: Int32Array.from([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        },
        point_layer: {
          domain: 'point',
          type: 'int',
          count: 8,
          data: Int32Array.from([5, 5, 5, 5, 5, 5, 5, 5]),
        },
      } as never,
      'evaluate' as never,
    );
    const source = refWithAttributeKey(importedRef(), key);
    const arrayed = arrayGeometryRef(source, 3, [2, 0, 0], null);
    const minted = mintTiledModifierAttributes(arrayed.descriptor);
    expect(minted).not.toBeNull();
    expect(membership(arrayed, minted!, 'arm')).toBe('111000000000111000000000111000000000');
  });

  it('5 — `baked` still cannot carry a group, which is the half that did NOT lift', () => {
    // The `ComponentGroupOp` limit is now one kind wide rather than two. Pinned here so that
    // correction cannot drift from the code: a buffer VERTEX count cannot state a face count.
    const baked: GeometryDescriptor = { kind: 'baked', hash: 'abc', vertexCount: 24 } as never;
    expect(faceCountOf(baked)).toBeNull();
    mountClone();
    expect(faceCountOf(importedRef().descriptor)).toBe(IMPORTED_FACES);
  });
});
