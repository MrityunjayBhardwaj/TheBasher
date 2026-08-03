// #536 S2b — the seam's contract, at the tier where each clause can be stated alone.
//
// The behavioural gate for this slice already existed and was already red before a line of
// it was written: eight browser specs that say "an animated / held-edit material colour must
// reach the screen" (conformance R5/R6 box+sphere, p522 ×2, p422, p149). That is the
// end-to-end proof. This file is the part those cannot say — each of the three properties
// the repair has to have SEPARATELY, so a future change that keeps the screen correct while
// breaking one of them (silently losing dedup, or churning every frame) still reds.
//
// REF: src/app/overlayWithIdentity.ts; src/app/objectDataBand.ts (`identityFieldsForBand`);
//      src/nodes/overlayChannels.ts + src/app/overlayTransients.ts (the primitives whose
//      filters `writtenPaths` mirrors); hetvabhasa H261; issue #536.

import { describe, expect, it } from 'vitest';
import { repairInvalidatedIdentity, overlayWithIdentity } from './overlayWithIdentity';
import { channelPathForBand } from './objectDataBand';
import { arrayGeometryRef, boxGeometryRef, sphereGeometryRef } from './modifierGeometry';
import type { KeyframeChannelValue } from '../nodes/types';
import type { TransientEdit } from './stores/transientEditStore';

const NODE = 'n_box';

/** A split box's evaluated value, shaped the way `ObjectR` reads it (`value.data.*`). */
function baseValue() {
  return {
    kind: 'SceneChild' as const,
    position: [0, 0, 0],
    data: {
      kind: 'MeshData',
      geometry: { kind: 'box', size: [1, 1, 1] },
      material: { base: { color: '#c81e5a' } },
      materialKey: 'MINTED-BY-EVALUATION',
    },
  };
}

function channel(paramPath: string, value: unknown, mute = false): KeyframeChannelValue {
  return { paramPath, sample: () => value, mute } as unknown as KeyframeChannelValue;
}

function transient(paramPath: string, value: unknown, nodeId = NODE): Map<string, TransientEdit> {
  return new Map([[`${nodeId}:${paramPath}`, { nodeId, paramPath, value } as TransientEdit]]);
}

const NO_TRANSIENTS = new Map<string, TransientEdit>();
const NO_CHANNELS: KeyframeChannelValue[] = [];

// The paths under test, DERIVED the way production derives them. Spelling `data.material`
// here would make this file agree with a hardcoded bug.
const MATERIAL = channelPathForBand('children', 'material');
const MATERIAL_KEY = channelPathForBand('children', 'materialKey');
const POSITION = 'position';

describe('#536 S2b — a write into the material clears the identity minted for it', () => {
  it('clears the key when an animated channel writes the colour', () => {
    const out = overlayWithIdentity(
      'children',
      baseValue(),
      NODE,
      [channel(`${MATERIAL}.base.color`, '#1e9ac8')],
      NO_TRANSIENTS,
      0,
    );
    expect(out.data.material).toEqual({ base: { color: '#1e9ac8' } });
    // The whole defect in one assertion: the value moved, so the name for it must not be
    // the one minted for the value it no longer holds.
    expect(out.data.materialKey).toBeNull();
  });

  it('clears the key when a HELD edit writes the colour', () => {
    // The transient road is the one the director is on while dragging a swatch, and it is a
    // separate filter inside the seam (`edit.nodeId === nodeId`), so it needs its own case
    // rather than being assumed to follow from the channel one.
    const out = overlayWithIdentity(
      'children',
      baseValue(),
      NODE,
      NO_CHANNELS,
      transient(`${MATERIAL}.base.color`, '#1e9ac8'),
      0,
    );
    expect(out.data.material).toEqual({ base: { color: '#1e9ac8' } });
    expect(out.data.materialKey).toBeNull();
  });

  it('clears the key when the whole material region is replaced at once', () => {
    const out = overlayWithIdentity(
      'children',
      baseValue(),
      NODE,
      [channel(MATERIAL, { base: { color: '#00ff00' } })],
      NO_TRANSIENTS,
      0,
    );
    expect(out.data.materialKey).toBeNull();
  });

  it('does NOT clear the key for a write that lands elsewhere — dedup is not collateral', () => {
    // Property 2. An animated position must not cost two objects their shared material
    // instance. This is the case that is invisible on screen when it regresses: the picture
    // stays correct and the sharing quietly stops.
    const out = overlayWithIdentity(
      'children',
      baseValue(),
      NODE,
      [channel(POSITION, [5, 0, 0])],
      NO_TRANSIENTS,
      0,
    );
    expect(out.position).toEqual([5, 0, 0]);
    expect(out.data.materialKey).toBe('MINTED-BY-EVALUATION');
  });

  it('does NOT clear the key for a MUTED material channel — it mirrors the primitive it wraps', () => {
    // `overlayChannels` drops muted channels, so nothing is written and nothing is
    // invalidated. If the seam's written-path set stopped mirroring that filter, this case
    // would clear a key for a write that never happened.
    const out = overlayWithIdentity(
      'children',
      baseValue(),
      NODE,
      [channel(`${MATERIAL}.base.color`, '#1e9ac8', true), channel(POSITION, [5, 0, 0])],
      NO_TRANSIENTS,
      0,
    );
    expect(out.data.material).toEqual({ base: { color: '#c81e5a' } });
    expect(out.data.materialKey).toBe('MINTED-BY-EVALUATION');
  });

  it("does NOT clear the key for ANOTHER node's held edit", () => {
    // The transient store is global; `overlayTransients` writes only the edits targeting
    // this node. The seam's filter has to agree, or one object being dragged would strip the
    // identity off every other object in the scene.
    const out = overlayWithIdentity(
      'children',
      baseValue(),
      NODE,
      [channel(POSITION, [5, 0, 0])],
      transient(`${MATERIAL}.base.color`, '#1e9ac8', 'n_other'),
      0,
    );
    expect(out.data.materialKey).toBe('MINTED-BY-EVALUATION');
  });

  it('is not fooled by the sibling field sharing a character prefix', () => {
    // `materialKey` starts with `material`. A `startsWith` containment check would treat a
    // write to the KEY as a write to the region it identifies — the two fields sit side by
    // side precisely because of #536 S1, so this pair is the likeliest way to get it wrong.
    const out = overlayWithIdentity(
      'children',
      baseValue(),
      NODE,
      [channel(MATERIAL_KEY, 'SOMETHING-ELSE')],
      NO_TRANSIENTS,
      0,
    );
    expect(out.data.materialKey).toBe('SOMETHING-ELSE');
  });
});

describe('#536 S2b — the static scene pays nothing', () => {
  it('returns the base BY REFERENCE when nothing is written', () => {
    // Property 1, and it is not a micro-optimisation: both call sites skip their per-frame
    // setState on reference equality, so a seam that always cloned would re-render every
    // node in the scene every frame.
    const base = baseValue();
    expect(overlayWithIdentity('children', base, NODE, NO_CHANNELS, NO_TRANSIENTS, 0)).toBe(base);
    expect(
      overlayWithIdentity(
        'children',
        base,
        NODE,
        [channel(`${MATERIAL}.base.color`, '#1e9ac8', true)],
        NO_TRANSIENTS,
        0,
      ),
    ).toBe(base);
  });

  it('never mutates the base', () => {
    const base = baseValue();
    overlayWithIdentity(
      'children',
      base,
      NODE,
      [channel(`${MATERIAL}.base.color`, '#1e9ac8')],
      NO_TRANSIENTS,
      0,
    );
    expect(base.data.materialKey).toBe('MINTED-BY-EVALUATION');
    expect(base.data.material).toEqual({ base: { color: '#c81e5a' } });
  });
});

describe('#536 S2b — the band decides, and a band with no minted identity is untouched', () => {
  it('leaves a lights-band value alone', () => {
    // A recomposed LightValue is FLAT and carries no minted identity, so the same write must
    // not be rebased or repaired here. This is the case that would break if the seam had
    // spelled `data.` instead of deriving it — the reason `identityFieldsForBand` is keyed
    // on the band and not on the value's kind.
    const light = { kind: 'Light', intensity: 1, materialKey: 'SHOULD-NOT-BE-TOUCHED' };
    const out = overlayWithIdentity(
      'lights',
      light,
      NODE,
      [channel('intensity', 5)],
      NO_TRANSIENTS,
      0,
    );
    expect(out.intensity).toBe(5);
    expect(out.materialKey).toBe('SHOULD-NOT-BE-TOUCHED');
  });

  it('does not stamp an identity field onto a value that has none', () => {
    // A curve renders in the children band and has no material at all. Clearing must be a
    // repair of something present, never the creation of a null field on a value whose type
    // does not have one.
    const curve = {
      kind: 'SceneChild',
      data: { kind: 'CurveData', closed: false, material: { base: { color: '#fff' } } },
    };
    const out = overlayWithIdentity(
      'children',
      curve,
      NODE,
      [channel(`${MATERIAL}.base.color`, '#1e9ac8')],
      NO_TRANSIENTS,
      0,
    );
    expect('materialKey' in out.data).toBe(false);
  });
});

// #536 S3 — the rule, reachable by a writer that patches AFTER the overlay has run.
//
// The brand on the renderer's entry point surfaced one: the constraint road spreads the
// overlaid value into a fresh object to apply a derived aim/position. It could have declared
// itself exempt — its writes are transform bands, which invalidate nothing today — but that
// would put a second copy of "does writing rotation invalidate a material key?" in the
// renderer, and the two would drift the first time a constraint writes a keyed band. These
// cases pin the shared rule at both answers, so the exemption stays derived rather than
// asserted.
describe('#536 S3 — a post-overlay writer clears through the same rule', () => {
  it('leaves the key alone when the write is a transform band', () => {
    const out = repairInvalidatedIdentity('children', baseValue(), [POSITION, 'rotation']);
    // The whole reason the constraint road is allowed to skip the repair — derived here, so
    // it is a measurement rather than a claim in a comment.
    expect(out.data.materialKey).toBe('MINTED-BY-EVALUATION');
  });

  it('clears the key when a post-overlay write does reach the material', () => {
    // The case that makes the one above evidence: the same call, the same value, a path that
    // DOES invalidate. Without this, "leaves the key alone" would also pass for a function
    // that never clears anything.
    const out = repairInvalidatedIdentity('children', baseValue(), [`${MATERIAL}.base.color`]);
    expect(out.data.materialKey).toBeNull();
  });

  it('does not treat a write to the KEY as a write to the region it identifies', () => {
    // The segment-wise containment case, restated at this entry point: `materialKey` shares a
    // character prefix with `material`, and a naive startsWith would read one as the other.
    const out = repairInvalidatedIdentity('children', baseValue(), [MATERIAL_KEY]);
    expect(out.data.materialKey).toBe('MINTED-BY-EVALUATION');
  });
});

// ── #537 — THE OTHER HALF OF THE SAME RULE: A HANDLE THE WRITE FEEDS ─────────────────────
//
// The cases above cover the repair whose answer is CLEAR. Geometry is the same defect with
// a different repair, and it is the one that shipped: `channelPathForBand('children','size')`
// writes `data.size`, but `MeshDataValue` has no `size` — it carries a `GeometryRef`, and the
// renderer draws through `getForAttach(data.geometry)`. The write lands somewhere real,
// reads back fine, and is ignored.
//
// MEASURED before writing these, three subjects and a control in one browser run: a box's
// `size` FROZEN, a sphere's `radius` FROZEN, an ArrayModifier's own `count` FROZEN, an
// animated `position` on the same road MOVING. So this is not a `size` bug — it is every
// param that becomes a DESCRIPTOR FIELD instead of a leaf, and the repair belongs at the
// handle rather than at any one param.
//
// Clearing cannot work here: the material seam has a documented fallback that re-derives
// identity from the spec it holds, while a null geometry ref draws NOTHING. So the repair is
// a REBUILD — fold the written params into the descriptor and re-mint through the same
// builder the evaluator used, which keeps one spelling of a geometry key rather than two.

const SIZE = channelPathForBand('children', 'size');
const RADIUS = channelPathForBand('children', 'radius');
const COUNT = channelPathForBand('children', 'count');
const GEOMETRY = channelPathForBand('children', 'geometry');

/** A split box whose geometry is a REAL handle, minted the way the evaluator mints it. */
function boxValue() {
  return {
    kind: 'SceneChild' as const,
    position: [0, 0, 0],
    data: {
      kind: 'MeshData',
      geometry: boxGeometryRef([1, 1, 1]),
      material: { base: { color: '#c81e5a' } },
      materialKey: 'MINTED-BY-EVALUATION',
    },
  };
}

describe('#537 — a write that feeds a geometry handle rebuilds it', () => {
  it('rebuilds the box handle when an animated channel writes `size`', () => {
    const out = overlayWithIdentity(
      'children',
      boxValue(),
      NODE,
      [channel(SIZE, [4, 4, 4])],
      NO_TRANSIENTS,
      0,
    );
    // Both halves, and the key is the load-bearing one: the registry is content-keyed, so a
    // patched descriptor under the pre-edit key would hand back the pre-edit BufferGeometry —
    // the material bug (H261) arriving through the geometry door.
    expect(out.data.geometry.descriptor).toEqual({ kind: 'box', size: [4, 4, 4] });
    expect(out.data.geometry.key).toBe(boxGeometryRef([4, 4, 4]).key);
  });

  it('rebuilds through the SAME builder the evaluator uses, not a second spelling', () => {
    // The claim that keeps one key format in the repo. Stated against the builder's own
    // output rather than against a literal, so a change to the key spelling moves both.
    const out = overlayWithIdentity(
      'children',
      boxValue(),
      NODE,
      [channel(SIZE, [2, 3, 4])],
      NO_TRANSIENTS,
      0,
    );
    expect(out.data.geometry).toEqual(boxGeometryRef([2, 3, 4]));
  });

  it('rebuilds a sphere from its three params, including a HELD edit', () => {
    // Sphere is the multi-param case: a write to one field must keep the other two, or an
    // animated radius silently resets the segment counts.
    const base = {
      kind: 'SceneChild' as const,
      position: [0, 0, 0],
      data: {
        kind: 'MeshData',
        geometry: sphereGeometryRef(1, 32, 16),
        material: null,
        materialKey: null,
      },
    };
    const out = overlayWithIdentity('children', base, NODE, NO_CHANNELS, transient(RADIUS, 3), 0);
    expect(out.data.geometry).toEqual(sphereGeometryRef(3, 32, 16));
  });

  it('rebuilds a modifier handle from the modifier’s OWN param (`count`)', () => {
    // The subject the issue did not name and the browser found: an ArrayModifier's params
    // become fields of a RECURSIVE descriptor, so they take this road too. The nested
    // `source` handle must survive untouched — it is another producer's identity.
    const source = boxGeometryRef([1, 1, 1]);
    const base = {
      kind: 'SceneChild' as const,
      position: [0, 0, 0],
      data: {
        kind: 'ModifiedData',
        geometry: arrayGeometryRef(source, 2, [2, 0, 0]),
        material: null,
      },
    };
    const out = overlayWithIdentity('children', base, NODE, [channel(COUNT, 5)], NO_TRANSIENTS, 0);
    expect(out.data.geometry).toEqual(arrayGeometryRef(source, 5, [2, 0, 0]));
    // The source's KEY, not its reference — everything is a deep clone by this point, so
    // object identity says nothing. The key is the part that matters anyway: it is another
    // producer's minted identity, and rebuilding it here would overwrite that with a guess.
    expect(out.data.geometry.descriptor.source.key).toBe(source.key);
  });

  it('never rebuilds a modifier’s SOURCE from a param write (the nested handle is not ours)', () => {
    // The `source` exclusion, which is the one field of a recursive descriptor that must be
    // left alone. `size` is a real param name and a real field of the source's OWN
    // descriptor, so a rebuild that walked into `source` would happily re-mint the box from
    // a channel authored on a different node — silently repointing this modifier at geometry
    // its producer never agreed to.
    const source = boxGeometryRef([1, 1, 1]);
    const base = {
      kind: 'SceneChild' as const,
      position: [0, 0, 0],
      data: {
        kind: 'ModifiedData',
        geometry: arrayGeometryRef(source, 2, [2, 0, 0]),
        material: null,
      },
    };
    const out = overlayWithIdentity(
      'children',
      base,
      NODE,
      [channel(SIZE, [9, 9, 9])],
      NO_TRANSIENTS,
      0,
    );
    expect(out.data.geometry).toEqual(arrayGeometryRef(source, 2, [2, 0, 0]));
  });

  it('leaves the handle UNCHANGED when the write feeds nothing it builds from', () => {
    // Property 2 of this seam, restated for geometry: animating a position must not move a
    // geometry key, or two objects sharing a build would stop sharing the moment one moved.
    //
    // ⚠️ Written as `toBe` first, and that was wrong for a reason worth keeping: once ANY
    // write happens the primitives hand back a DEEP CLONE, so no sub-object survives by
    // reference and the assertion failed on an unchanged handle. Reference stability at this
    // seam lives entirely in the `patched === base` early return (its own case above), not
    // here. Which means "did not re-mint" and "re-minted an identical descriptor" are
    // indistinguishable at this tier by construction — equal key, equal content, different
    // object — so this pins the observable half and the guard against pointless re-minting is
    // the `writeFeeds` check itself, not this test.
    const base = boxValue();
    const before = base.data.geometry;
    const out = overlayWithIdentity(
      'children',
      base,
      NODE,
      [channel(POSITION, [5, 0, 0]), channel(`${MATERIAL}.base.color`, '#1e9ac8')],
      NO_TRANSIENTS,
      0,
    );
    expect(out.data.geometry).toEqual(before);
  });

  it('does not treat a write to the HANDLE itself as a param that feeds it', () => {
    // The dual of the `materialKey` vs `material` case above. Nothing writes `data.geometry`
    // today; if something did, it is handing over a whole ref and must not have it rebuilt
    // from a descriptor field named after it.
    const base = boxValue();
    const replacement = boxGeometryRef([9, 9, 9]);
    const out = overlayWithIdentity(
      'children',
      base,
      NODE,
      [channel(GEOMETRY, replacement)],
      NO_TRANSIENTS,
      0,
    );
    expect(out.data.geometry).toEqual(replacement);
  });

  it('leaves a value with no handle alone (a light, in its own band)', () => {
    // The lights band recomposes flat and carries no geometry at all. A repair that assumed
    // every band had a handle would stamp one on, which is the [[H260]] shape: a per-kind
    // assumption sitting beside a per-band rule.
    const light = { kind: 'SceneLight' as const, intensity: 1, color: '#fff' };
    const out = overlayWithIdentity(
      'lights',
      light,
      NODE,
      [channel('intensity', 4)],
      NO_TRANSIENTS,
      0,
    );
    expect(out).toEqual({ kind: 'SceneLight', intensity: 4, color: '#fff' });
  });
});

// ⚠️ BOTH CASES BELOW ARE NON-DISCRIMINATING TODAY, and that is recorded rather than
// glossed. They were written expecting to guard the mute/owner filters for geometry the way
// the material cases do, and neither could be made to red: removing the mute filter from
// `writtenPaths` leaves them green (the muted path is in the set but was never written, so
// the fold reads `undefined` and falls back to the descriptor), and removing the fallback
// leaves them green too (the path never enters `written` while the filter is intact, so
// `rebuildGeometryRef` takes its empty-values early return). The property is guarded twice
// over, by two mechanisms that each cover for the other.
//
// They are kept because they pin the BEHAVIOUR at this entry point for a future change that
// bypasses `writtenPaths` and reads the clone directly — the obvious "simplification" — which
// is exactly when a muted channel would start re-minting keys. But they are documentation of
// intent, not evidence, and a write-up that counted them as falsified coverage would be
// claiming a guard that no perturbation demonstrated.
describe('#537 — the handle repair mirrors the primitives it wraps', () => {
  it('does NOT rebuild for a MUTED size channel', () => {
    // The same filter the material half is pinned against, restated for geometry because it
    // is reached through a different branch of the repair. `overlayChannels` drops muted
    // channels, so nothing was written and nothing is invalidated — a rebuild here would
    // re-mint a key from a value the director explicitly switched off, and (with no eviction)
    // cache a geometry nobody asked to see.
    const base = boxValue();
    const out = overlayWithIdentity(
      'children',
      base,
      NODE,
      [channel(SIZE, [4, 4, 4], true), channel(POSITION, [5, 0, 0])],
      NO_TRANSIENTS,
      0,
    );
    expect(out.position).toEqual([5, 0, 0]);
    expect(out.data.geometry).toEqual(boxGeometryRef([1, 1, 1]));
  });

  it("does NOT rebuild from ANOTHER node's held edit", () => {
    // The transient store is global. Without the node filter, dragging one object's size
    // would re-mint every other object's geometry in the scene.
    const base = boxValue();
    const out = overlayWithIdentity(
      'children',
      base,
      NODE,
      [channel(POSITION, [5, 0, 0])],
      transient(SIZE, [9, 9, 9], 'n_other'),
      0,
    );
    expect(out.data.geometry).toEqual(boxGeometryRef([1, 1, 1]));
  });
});
