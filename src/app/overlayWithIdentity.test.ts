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
import { clearInvalidatedIdentity, overlayWithIdentity } from './overlayWithIdentity';
import { channelPathForBand } from './objectDataBand';
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
    const out = clearInvalidatedIdentity('children', baseValue(), [POSITION, 'rotation']);
    // The whole reason the constraint road is allowed to skip the repair — derived here, so
    // it is a measurement rather than a claim in a comment.
    expect(out.data.materialKey).toBe('MINTED-BY-EVALUATION');
  });

  it('clears the key when a post-overlay write does reach the material', () => {
    // The case that makes the one above evidence: the same call, the same value, a path that
    // DOES invalidate. Without this, "leaves the key alone" would also pass for a function
    // that never clears anything.
    const out = clearInvalidatedIdentity('children', baseValue(), [`${MATERIAL}.base.color`]);
    expect(out.data.materialKey).toBeNull();
  });

  it('does not treat a write to the KEY as a write to the region it identifies', () => {
    // The segment-wise containment case, restated at this entry point: `materialKey` shares a
    // character prefix with `material`, and a naive startsWith would read one as the other.
    const out = clearInvalidatedIdentity('children', baseValue(), [MATERIAL_KEY]);
    expect(out.data.materialKey).toBe('MINTED-BY-EVALUATION');
  });
});
