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
import { BoxGeometry, Group, Mesh } from 'three';
import { registerGltfClone, __clearGltfCloneRegistryForTests } from './asset/gltfCloneRegistry';

const gltfRef: GeometryRef = {
  key: 'gltf|asset-1|Mesh0',
  descriptor: { kind: 'gltf', assetRef: 'asset-1', childName: 'Mesh0' },
};

const bakedRef: GeometryRef = {
  key: 'baked|hash-1',
  descriptor: { kind: 'baked', hash: 'hash-1', vertexCount: 24 },
};

/**
 * An `array` whose source is a glTF ref — buildable, but only once the asset clone mounts.
 *
 * 🔴 THIS DOC HAS NOW BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND BOTH TIMES THE ROW KEPT
 * PASSING. Until #708 the name said `procedural` while the classification composed. Until
 * #367 the doc said "`get` on a gltf ref always returns null … so this build can never
 * succeed", which was true of the registry rather than of the world: the registry declined a
 * handle it had. Now `get` delegates to the mounted clone, so the build succeeds the moment
 * the asset is there, and the class is `mounting` — a WAIT, like the baked road.
 *
 * The lesson the two corrections share is why this is written out rather than deleted: a
 * status assertion cannot notice that the REASON attached to it has stopped being true.
 */
const recipeOverCloneRef = arrayGeometryRef(gltfRef, 3, [1, 0, 0]);

/** An `array` over a BAKED source — the case #708 exists for. Buildable, but only once the
 *  OPFS read lands, so the honest answer before that is "wait", not "there is none". */
const recipeOverPrimedRef = arrayGeometryRef(bakedRef, 3, [1, 0, 0]);

/** Mount a clone carrying `Mesh0`, so a `gltf` ref — and any recipe over it — can resolve. */
function mountAssetClone(): void {
  const group = new Group();
  const mesh = new Mesh(new BoxGeometry(1, 1, 1));
  mesh.name = 'Mesh0';
  group.add(mesh);
  group.updateMatrixWorld(true);
  registerGltfClone('asset-1', group);
}

describe('#630 — a registry read says WHY it is empty', () => {
  beforeEach(() => {
    clear();
    __clearGltfCloneRegistryForTests();
  });

  it('reports the geometry when there is one', () => {
    const result = readGeometry(boxGeometryRef([1, 1, 1], null));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.geometry).toBeInstanceOf(BoxGeometry);
  });

  it('distinguishes a baked miss from a recipe waiting on an asset mount', () => {
    const baked = readGeometry(bakedRef);
    const overClone = readGeometry(recipeOverCloneRef);

    // Both are empty. Before #630 both were exactly `null` and a caller had no way to tell
    // them apart without re-deriving the rule.
    expect(getForRead(bakedRef)).toBeNull();
    expect(getForRead(recipeOverCloneRef)).toBeNull();

    // 🔴 #367 MOVED THIS ROW'S DISTINCTION DOWN A LEVEL, and it is worth being exact about
    // what survived. These two used to differ in STATUS — `pending` against `none` — because
    // a recipe over a clone could never build. It can now, so both are honestly a WAIT and
    // the status is deliberately the same.
    expect(baked.status).toBe('pending');
    expect(overClone.status).toBe('pending');

    // What still differs is WHAT IS BEING WAITED ON, which is the thing a caller acts on:
    // an OPFS read that the loader hook must kick off, versus an asset clone the renderer
    // mounts. The `availability` field is where that lives, and asserting it here is what
    // stops "both are pending" from collapsing into one undifferentiated answer.
    //
    // Narrowed rather than asserted through: `availability` is declared only on the three
    // EMPTY arms of `GeometryReadResult`, which is the discriminated union doing its job —
    // a caller cannot read a reason off a result that carries a geometry.
    if (baked.status === 'ok' || overClone.status === 'ok') throw new Error('expected empties');
    expect(baked.availability).toBe('primed');
    expect(overClone.availability).toBe('mounting');
    expect(baked.availability).not.toBe(overClone.availability);
  });

  it('🔴 `none` now has NO producer, and that is a measurement rather than an omission', () => {
    // The row above used to contrast a WAIT with a permanent absence. It no longer can, and
    // the reason is worth pinning: `recipeOverCloneRef` WAS the only natural producer of
    // `none`, which is exactly what this file's header describes — "an `array` modifier whose
    // source cannot build synchronously makes the whole array unbuildable". #367 gave that
    // source a road, so the case it illustrated is gone.
    //
    // MEASURED before writing this, rather than assumed: every malformed descriptor that
    // could be constructed still built. An array of count 0, of -3, of NaN; a box with a NaN
    // extent; a sphere with a negative radius — all `ok`. `three` constructs a geometry for
    // each, and `arrayCopies` (#755) floors the count rather than refusing it.
    //
    // So the class is kept and the arm is kept, and this row says why: `procedural` still
    // MEANS "the registry builds these synchronously, so a null is a refusal", and the day
    // `build` grows a real refusal that meaning is already correct and already wired. Deleting
    // the arm would be reading "nothing reaches it today" as "nothing can", which is the
    // inference this file exists to refuse. What is NOT claimed is that some caller sees
    // `none` in production — nothing does.
    const box = boxGeometryRef([1, 1, 1], null);
    for (const count of [0, -3, Number.NaN]) {
      expect(readGeometry(arrayGeometryRef(box, count, [1, 0, 0])).status).toBe('ok');
    }
    // The class itself is still declared and still procedural — the half that a future
    // refusal needs, asserted independently of whether anything refuses today.
    expect(availabilityOf(box.descriptor)).toBe('procedural');
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

    it('a generator over a CLONE source is mounting — not clone, and not procedural', () => {
      // Still not `clone`: the array's buffers are built BY THE REGISTRY out of a source it
      // reads through the clone, so "look in the clone for this geometry" would be false, and
      // a consumer that reads `assetRef` off an `elsewhere` descriptor would find none here.
      //
      // And no longer `unreachable` (#367): `get` delegates, so the build succeeds once the
      // asset mounts. Answering `none` — "waiting will not help" — would be a statement the
      // very next row disproves.
      expect(availabilityOf(recipeOverCloneRef.descriptor)).toBe('mounting');
      expect(readGeometry(recipeOverCloneRef).status).toBe('pending');
      expect(readGeometry(recipeOverCloneRef).status).not.toBe('elsewhere');
    });

    it('and THAT pending answer comes true: mounting the CLONE builds the recipe (#367)', () => {
      // The row that makes `mounting` a claim rather than a label, mirroring the baked one
      // below. This is the whole of #367 at the registry level: an imported mesh flowing into
      // the operator chain, which is the thing that could not happen before.
      expect(readGeometry(recipeOverCloneRef).status).toBe('pending');
      mountAssetClone();
      const after = readGeometry(recipeOverCloneRef);
      expect(after.status).toBe('ok');
      if (after.status !== 'ok') throw new Error('unreachable');
      // 3 copies of a box's 24 position entries — it really built, it did not just resolve.
      expect(after.geometry.getAttribute('position').count).toBe(72);
    });

    it('a BARE gltf ref resolves through the clone too, and says `elsewhere` until it mounts', () => {
      // The leaf case the composition rows above are built on, pinned separately so a change
      // to one cannot silently carry the other. `elsewhere` is preserved for the unmounted
      // read: the buffers genuinely are somewhere else, and that is what the UV road keys on.
      expect(readGeometry(gltfRef).status).toBe('elsewhere');
      expect(getForRead(gltfRef)).toBeNull();
      mountAssetClone();
      const after = readGeometry(gltfRef);
      expect(after.status).toBe('ok');
      if (after.status !== 'ok') throw new Error('unreachable');
      expect(after.geometry.getAttribute('position').count).toBe(24);
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
