// #630 — a registry null means three different things, and now it says which.
//
// ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────────────────
//
// `getForRead` returns null for three unrelated reasons, and the correct response differs
// for each: LOOK ELSEWHERE (a glTF ref — the asset clone owns those buffers), WAIT (a baked
// miss — the bytes are in OPFS behind an async read), and THERE GENUINELY IS NONE (a
// procedural miss — the registry builds those synchronously, so a null means `build`
// refused). Collapsing them makes a loading mesh indistinguishable from an empty one.
//
// Nothing enforced the distinction. It was recoverable only by re-inspecting `ref.kind` at
// each call site, which means the rule was restated everywhere it was needed — and the one
// consumer that did restate it kept a private copy of the switch that would have agreed
// with the registry only until someone added a geometry kind.
//
// ── WHAT THIS SUITE ASSERTS, AND WHY IT IS TWO CASES AND NOT ONE ──────────────────────
//
// A suite that checked only "a baked miss reports pending" would pass against an
// implementation that reported `pending` for every empty result. The claim is that the
// reasons DIFFER, so the reasons have to be compared against each other, from the same
// call, in the same run. Each case below is paired with a case that must not equal it.
//
// The malformed procedural descriptor is built the way one really arises rather than by
// forging an invalid type: an `array` modifier whose source cannot build synchronously
// makes the whole array unbuildable, and `build` returns null. That is a real null from a
// real path, so the case cannot pass by testing a shape production never produces.

import { beforeEach, describe, expect, it } from 'vitest';
import { availabilityOf, clear, getForRead, prime, readGeometry } from './geometryRegistry';
import { arrayGeometryRef, boxGeometryRef } from './modifierGeometry';
import type { GeometryDescriptor, GeometryRef } from '../nodes/types';
import { BoxGeometry } from 'three';

const gltfRef: GeometryRef = {
  key: 'gltf|asset-1|Mesh0',
  descriptor: { kind: 'gltf', assetRef: 'asset-1', childName: 'Mesh0' },
};

const bakedRef: GeometryRef = {
  key: 'baked|hash-1',
  descriptor: { kind: 'baked', hash: 'hash-1', vertexCount: 24 },
};

/** An `array` whose source is a glTF ref: the source cannot build synchronously, so the
 *  array is unbuildable and `build` returns null — a real procedural miss. */
const unbuildableProceduralRef = arrayGeometryRef(gltfRef, 3, [1, 0, 0]);

describe('#630 — a registry read says WHY it is empty', () => {
  beforeEach(() => {
    clear();
  });

  it('reports the geometry when there is one', () => {
    const result = readGeometry(boxGeometryRef([1, 1, 1], null));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.geometry).toBeInstanceOf(BoxGeometry);
  });

  it('distinguishes a baked miss from a malformed procedural descriptor', () => {
    const baked = readGeometry(bakedRef);
    const procedural = readGeometry(unbuildableProceduralRef);

    // Both are empty. Before this change both were exactly `null` and a caller had no way
    // to tell them apart without re-deriving the rule.
    expect(getForRead(bakedRef)).toBeNull();
    expect(getForRead(unbuildableProceduralRef)).toBeNull();

    // The whole point: they are not the same answer.
    expect(baked.status).not.toBe(procedural.status);
    expect(baked.status).toBe('pending'); // the bytes exist; wait for the OPFS read
    expect(procedural.status).toBe('none'); // waiting will never help
  });

  it('distinguishes a glTF ref from both of them', () => {
    const gltf = readGeometry(gltfRef);
    expect(gltf.status).toBe('elsewhere'); // the asset clone owns these buffers
    expect(gltf.status).not.toBe(readGeometry(bakedRef).status);
    expect(gltf.status).not.toBe(readGeometry(unbuildableProceduralRef).status);
  });

  it('a baked ref stops being pending once it is primed — the reason tracks reality', () => {
    expect(readGeometry(bakedRef).status).toBe('pending');
    prime(bakedRef, new BoxGeometry(1, 1, 1));
    // If this still said `pending` the reason would be a static property of the KIND rather
    // than an answer about this read, which is the failure mode a kind-keyed lookup has.
    expect(readGeometry(bakedRef).status).toBe('ok');
  });

  it('narrowing to a bare geometry agrees with the typed result, because one defines the other', () => {
    const ref = boxGeometryRef([2, 2, 2], null);
    const typed = readGeometry(ref);
    const bare = getForRead(ref);
    // Same cache, same instance — `getForRead` is a view of `readGeometry`, not a second
    // path to the resource that happens to agree today.
    expect(typed.status).toBe('ok');
    if (typed.status !== 'ok') throw new Error('unreachable');
    expect(bare).toBe(typed.geometry);
  });

  it('every geometry kind declares an availability class', () => {
    // The exhaustiveness is enforced by the compiler (`never`), which a runtime test cannot
    // observe. What it CAN observe is that the classes are actually distinct — a switch that
    // returned one label for everything would typecheck and make the tri-state a fiction.
    expect(availabilityOf('box')).toBe('procedural');
    expect(availabilityOf('baked')).toBe('primed');
    expect(availabilityOf('gltf')).toBe('clone');
    expect(
      new Set(
        ['box', 'sphere', 'array', 'mirror', 'baked', 'gltf'].map((k) =>
          availabilityOf(k as GeometryDescriptor['kind']),
        ),
      ).size,
    ).toBe(3);
  });
});
