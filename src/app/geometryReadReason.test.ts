// #630 — a registry null means several different things, and now it says which.
// #708 — and the reason now COMPOSES: a recipe rooted at a buffer inherits its source's.
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
import { arrayGeometryRef, boxGeometryRef, mirrorGeometryRef } from './modifierGeometry';
import type { GeometryRef } from '../nodes/types';
import { BoxGeometry } from 'three';

const gltfRef: GeometryRef = {
  key: 'gltf|asset-1|Mesh0',
  descriptor: { kind: 'gltf', assetRef: 'asset-1', childName: 'Mesh0' },
};

const bakedRef: GeometryRef = {
  key: 'baked|hash-1',
  descriptor: { kind: 'baked', hash: 'hash-1', vertexCount: 24 },
};

/**
 * An `array` whose source is a glTF ref. `get` on a gltf ref always returns null and clone
 * loading puts nothing in the registry, so this build can never succeed — a real null from a
 * real path, not a forged invalid type.
 *
 * 🔴 IT WAS CALLED `recipeOverCloneRef` UNTIL #708, AND THAT NAME WAS FALSE. The
 * classification composes now: this is `unreachable`, not `procedural`. Its STATUS is
 * unchanged (`none` either way), which is exactly why the rename matters — the row went on
 * passing while the name it passed under stopped being true.
 */
const recipeOverCloneRef = arrayGeometryRef(gltfRef, 3, [1, 0, 0]);

/** An `array` over a BAKED source — the case #708 exists for. Buildable, but only once the
 *  OPFS read lands, so the honest answer before that is "wait", not "there is none". */
const recipeOverPrimedRef = arrayGeometryRef(bakedRef, 3, [1, 0, 0]);

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

  it('distinguishes a baked miss from a recipe the registry can never reach', () => {
    const baked = readGeometry(bakedRef);
    const procedural = readGeometry(recipeOverCloneRef);

    // Both are empty. Before this change both were exactly `null` and a caller had no way
    // to tell them apart without re-deriving the rule.
    expect(getForRead(bakedRef)).toBeNull();
    expect(getForRead(recipeOverCloneRef)).toBeNull();

    // The whole point: they are not the same answer.
    expect(baked.status).not.toBe(procedural.status);
    expect(baked.status).toBe('pending'); // the bytes exist; wait for the OPFS read
    expect(procedural.status).toBe('none'); // waiting will never help
  });

  it('distinguishes a glTF ref from both of them', () => {
    const gltf = readGeometry(gltfRef);
    expect(gltf.status).toBe('elsewhere'); // the asset clone owns these buffers
    expect(gltf.status).not.toBe(readGeometry(bakedRef).status);
    expect(gltf.status).not.toBe(readGeometry(recipeOverCloneRef).status);
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
    // returned one label for everything would typecheck and make the state a fiction.
    //
    // #708 — it takes the DESCRIPTOR, not the kind. That is not a widening for convenience:
    // a generator's class is its SOURCE's, and a bare kind cannot reach `.source`. Passing
    // the kind was what made the un-composed answer askable in the first place.
    expect(availabilityOf(boxGeometryRef([1, 1, 1], null).descriptor)).toBe('procedural');
    expect(availabilityOf(bakedRef.descriptor)).toBe('primed');
    expect(availabilityOf(gltfRef.descriptor)).toBe('clone');
    // All four classes are reachable from real handles — a class nothing can produce is a
    // fiction in the other direction.
    expect(
      new Set(
        [
          boxGeometryRef([1, 1, 1], null),
          bakedRef,
          gltfRef,
          recipeOverCloneRef,
          recipeOverPrimedRef,
        ].map((r) => availabilityOf(r.descriptor)),
      ).size,
    ).toBe(4);
  });

  // ── #708 — THE COMPOSITION, AND EVERY ROW WAS OBSERVED TO MOVE ──────────────────────
  //
  // Each row below was run against the pre-change tree first. `array over baked`,
  // `mirror over baked` and the two-deep nesting ALL read `procedural`/`none` there — the
  // registry declaring that waiting would not help about geometry that becomes available by
  // waiting, which the priming row at the end disproves in one call.
  describe('#708 — a recipe inherits its source, not its own kind', () => {
    it('a generator over a primed source is pending, not none', () => {
      expect(availabilityOf(recipeOverPrimedRef.descriptor)).toBe('primed');
      expect(readGeometry(recipeOverPrimedRef).status).toBe('pending');

      const mirrored = mirrorGeometryRef(bakedRef, 'x', 0);
      expect(availabilityOf(mirrored.descriptor)).toBe('primed');
      expect(readGeometry(mirrored).status).toBe('pending');
    });

    it('the inheritance is transitive, so nesting cannot launder it', () => {
      // Two levels. A rule applied only at the outermost hop would read `procedural` here
      // and the row would be green for the wrong reason at one level of nesting.
      const nested = arrayGeometryRef(mirrorGeometryRef(bakedRef, 'x', 0), 2, [1, 0, 0]);
      expect(availabilityOf(nested.descriptor)).toBe('primed');
      expect(readGeometry(nested).status).toBe('pending');
    });

    it('a generator over a CLONE source is unreachable — not clone, and not procedural', () => {
      // Not `clone`: nothing loads an array of a glTF child into an asset clone, and
      // `resolveMeshUVSpace` reads `assetRef` straight off any descriptor whose status is
      // `elsewhere`. Handed this one it would find none and hang on a loading state.
      expect(availabilityOf(recipeOverCloneRef.descriptor)).toBe('unreachable');
      expect(readGeometry(recipeOverCloneRef).status).toBe('none');
      expect(readGeometry(recipeOverCloneRef).status).not.toBe('elsewhere');
    });

    it('a generator over a procedural source is unchanged — the control', () => {
      const overBox = arrayGeometryRef(boxGeometryRef([1, 1, 1], null), 3, [2, 0, 0]);
      expect(availabilityOf(overBox.descriptor)).toBe('procedural');
      expect(readGeometry(overBox).status).toBe('ok');
    });

    it('and the pending answer comes true: priming the SOURCE builds the recipe', () => {
      // The row that makes `pending` a claim rather than a label. Before #708 this read
      // `none` first — "waiting will not help" — and then `ok`, in the same test.
      expect(readGeometry(recipeOverPrimedRef).status).toBe('pending');
      prime(bakedRef, new BoxGeometry(1, 1, 1));
      const after = readGeometry(recipeOverPrimedRef);
      expect(after.status).toBe('ok');
      if (after.status !== 'ok') throw new Error('unreachable');
      // 3 copies of a box's 24 position entries — it really built, it did not just resolve.
      expect(after.geometry.getAttribute('position').count).toBe(72);
    });
  });
});
