// #635 (ns-1) — the four answers a UV read can give, and the two that must never merge.
//
// The load-bearing assertion is the last one: `loading` and `none` are DISTINGUISHABLE at
// the type. Collapsed into one null, an in-flight OPFS read is indistinguishable from a mesh
// that has no UVs, and the consumer renders untextured and calls it correct — a defect that
// has already shipped once in the file that reads this one.
//
// REF: src/app/uvAttributes.ts; src/app/geometryRegistry.ts; issues #635, #630, #633.

import { BufferAttribute, BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { arrayGeometryRef, boxGeometryRef, sphereGeometryRef } from './modifierGeometry';
import { getForRead, prime } from './geometryRegistry';
import { read } from './attributeStore';
import { UV_MAP } from '../nodes/attributes';
import { readMeshUVs } from './uvAttributes';
import { cornerCountOf } from './faceCount';
import type { GeometryRef } from '../nodes/types';

const bakedRef = (hash: string): GeometryRef => ({
  key: `baked|${hash}`,
  descriptor: { kind: 'baked', hash, vertexCount: 3 },
});

const gltfRef: GeometryRef = {
  key: 'gltf|asset|child',
  descriptor: { kind: 'gltf', assetRef: 'asset', childName: 'child' },
};

/** A triangle with positions and no `uv` attribute at all. */
function uvlessTriangle(): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  return geom;
}

describe('#635 a built geometry yields a CORNER-domain UV attribute', () => {
  it('lifts the uv buffer off the tessellation, at the corner domain', () => {
    const result = readMeshUVs(boxGeometryRef([1, 1, 1], null));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.attribute.kind).toBe('resident');
    if (result.attribute.kind !== 'resident') return;

    const attribute = read(result.attribute.key)?.[UV_MAP];
    expect(attribute).toBeDefined();
    expect(attribute!.domain).toBe('corner');
    expect(attribute!.type).toBe('float2');
    // A box's six quads carry 24 rim corners, and a UV per corner is what makes a seam
    // expressible at all. It is also the split render vertex count, which is why the SPHERE
    // row below is the one that says this is gathered through the rims rather than copied.
    expect(attribute!.count).toBe(24);
    expect(attribute!.data.length).toBe(48);
  });

  it('still hands back the island projection the UV editor draws', () => {
    const result = readMeshUVs(sphereGeometryRef(1, 8, 4, null));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.islands.triangleCount).toBeGreaterThan(0);
  });

  it('🔴 A SPHERE SEPARATES THE CORNER COUNT FROM THE RENDER VERTEX COUNT — #776', () => {
    // THE DISCRIMINATING ROW, and the reason the box row above cannot stand alone. This lift
    // declared `uv.count` — the SPLIT RENDER VERTEX count — and called it a corner count. A box
    // has 24 of each and the label passed every test it had. An 8x4 sphere has 45 render
    // vertices `(w + 1)(h + 1)` and 8 * 4 = 32 polygons whose rims total 112 corners, so the
    // old producer declared 45 elements at a domain with 112 — breaking the model's own rule
    // that an attribute carries one element per element of its domain.
    const ref = sphereGeometryRef(1, 8, 4, null);
    const result = readMeshUVs(ref);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.attribute.kind !== 'resident') {
      throw new Error('the sphere did not reach the minting arm');
    }
    const attribute = read(result.attribute.key)![UV_MAP];
    expect(attribute.count).toBe(112);
    expect(attribute.count).toBe(cornerCountOf(ref.descriptor));
    expect(attribute.data.length).toBe(224);

    // And every value is one a render vertex actually carries — a gather, not a resampling.
    const uv = getForRead(ref)!.getAttribute('uv')!;
    const carried = new Set<string>();
    for (let v = 0; v < uv.count; v++) carried.add(`${uv.getX(v)},${uv.getY(v)}`);
    for (let c = 0; c < attribute.count; c++)
      expect(carried.has(`${attribute.data[c * 2]},${attribute.data[c * 2 + 1]}`)).toBe(true);
  });

  it('names the refusal for a descriptor with no rims of its own — #777', () => {
    // An Array has no rims in its own vertex numbering, so a UV cannot be placed on one of its
    // corners. The ISLANDS still arrive, which is the half that used to be lost with them: this
    // arm returned `none` before #776, the status meaning "there are genuinely no UVs".
    const arrayed = arrayGeometryRef(boxGeometryRef([1, 1, 1], null), 3, [2, 0, 0]);
    const result = readMeshUVs(arrayed);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.islands.triangleCount).toBeGreaterThan(0);
    expect(result.attribute.kind).toBe('not-derivable');
    expect(result.attribute.kind === 'not-derivable' && result.attribute.why).toContain('#777');
  });

  it('keys two equal geometries onto one attribute entry', () => {
    // ⚠️ WRITTEN AS TWO ASSERTIONS RATHER THAN ONE BOOLEAN, BECAUSE THE BOOLEAN WENT VACUOUS.
    // This row read `a.attributeKey === b.attributeKey` in one `&&` chain. #776 renamed the
    // field, and `undefined === undefined` is `true` — so it kept passing while comparing two
    // properties that no longer existed. `npm run typecheck` cannot see a test file (#472); the
    // changed-file `tsc` sweep is what caught it, and the shape below is what makes a rename
    // red instead of silently agreeing.
    const a = readMeshUVs(boxGeometryRef([1, 1, 1], null));
    const b = readMeshUVs(boxGeometryRef([1, 1, 1], null));
    expect(a.status === 'ok' && a.attribute.kind === 'resident' && a.attribute.key).toBeTruthy();
    if (a.status !== 'ok' || b.status !== 'ok') return;
    if (a.attribute.kind !== 'resident' || b.attribute.kind !== 'resident') return;
    expect(a.attribute.key).toBe(b.attribute.key);
  });
});

describe('#635 absence says WHY', () => {
  it('answers LOADING for bytes that exist but have not been read in', () => {
    expect(readMeshUVs(bakedRef('not-primed-yet')).status).toBe('loading');
  });

  it('answers ELSEWHERE for buffers that live in a loaded asset clone', () => {
    expect(readMeshUVs(gltfRef).status).toBe('elsewhere');
  });

  it('answers NONE for a geometry that is built and genuinely has no UVs', () => {
    const ref = bakedRef('primed-without-uvs');
    prime(ref, uvlessTriangle());
    expect(readMeshUVs(ref).status).toBe('none');
  });

  it('KEEPS LOADING AND NONE APART — the collapse this type exists to stop', () => {
    // Same shape of emptiness, opposite correct response: one says wait, the other says
    // render untextured. A single null cannot carry that difference, and a consumer that
    // guesses gets it wrong exactly half the time and silently.
    const midLoad = readMeshUVs(bakedRef('still-in-flight'));
    const genuinelyNone = readMeshUVs(bakedRef('primed-without-uvs-2'));
    prime(bakedRef('primed-without-uvs-2'), uvlessTriangle());

    expect(midLoad.status).toBe('loading');
    expect(readMeshUVs(bakedRef('primed-without-uvs-2')).status).toBe('none');
    expect(genuinelyNone.status).not.toBe(readMeshUVs(bakedRef('primed-without-uvs-2')).status);
  });

  it("🔴 a PRIMED BAKED mesh WITH uvs refuses for its OWN reason, not the derived kinds' — #776", () => {
    // The arm the first draft of #776 got wrong. A primed baked geometry reaches the minting
    // road — the registry HAS built it — and has no polygon rims for a reason that is nothing
    // to do with #777: its authoritative bytes live in OPFS and the descriptor carries a vertex
    // count. Minting one message here instead of propagating the layout's own would have named
    // #777 at this arm, sending a reader to an issue about copy offsets.
    const ref = bakedRef('primed-with-uvs');
    const uvd = new BufferGeometry();
    uvd.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    uvd.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    prime(ref, uvd);

    const result = readMeshUVs(ref);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.attribute.kind).toBe('not-derivable');
    if (result.attribute.kind !== 'not-derivable') return;
    expect(result.attribute.why).toContain('OPFS');
    expect(result.attribute.why).not.toContain('#777');
  });

  it('never awaits — the read is synchronous on every arm', () => {
    // The pressure at this seam is to make the resolver async and "just await the UVs",
    // which would turn every read-side consumer into a suspense boundary. Every arm above
    // returned a value, not a promise; this states it as an assertion.
    for (const result of [
      readMeshUVs(boxGeometryRef([2, 2, 2], null)),
      readMeshUVs(bakedRef('never-primed')),
      readMeshUVs(gltfRef),
    ]) {
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof result.status).toBe('string');
    }
  });
});
