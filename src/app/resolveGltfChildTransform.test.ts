import { describe, it, expect } from 'vitest';
import {
  resolveGltfChildTrs,
  resolveAllChildTrs,
  type ChildTrs,
  type ChildOverride,
  type BakedChannel,
} from './resolveGltfChildTransform';

const base: ChildTrs = {
  position: [1, 1, 1],
  rotation: [10, 10, 10],
  scale: [2, 2, 2],
};

const clipTrack: ChildTrs = {
  position: [5, 5, 5],
  rotation: [50, 50, 50],
  scale: [3, 3, 3],
};

const manual: ChildTrs = {
  position: [9, 9, 9],
  rotation: [90, 90, 90],
  scale: [4, 4, 4],
};

function override(over: ChildOverride['overridden']): ChildOverride {
  return { ...manual, overridden: over };
}

const allFalse = { position: false, rotation: false, scale: false };
const allTrue = { position: true, rotation: true, scale: true };

describe('resolveGltfChildTrs — precedence matrix (manual flag → clip → base)', () => {
  // The 8 combinations of {manual override present, clip present} are really a
  // matrix over: childNode present×overridden + clipTrack present×absent. We
  // enumerate the meaningful precedence outcomes per field.

  it('1. no override, no clip → base', () => {
    expect(resolveGltfChildTrs({ base, clipTrack: undefined, childNode: undefined })).toEqual(base);
  });

  it('2. no override, clip present → clip', () => {
    expect(resolveGltfChildTrs({ base, clipTrack, childNode: undefined })).toEqual(clipTrack);
  });

  it('3. childNode present but NOT overridden, no clip → base', () => {
    // The value-equality trap: childNode TRS is `manual` (differs from base),
    // but overridden is all-false, so base must win — NOT the manual value.
    expect(
      resolveGltfChildTrs({ base, clipTrack: undefined, childNode: override(allFalse) }),
    ).toEqual(base);
  });

  it('4. childNode present but NOT overridden, clip present → clip', () => {
    // overridden all-false → manual does NOT win; clip beats base.
    expect(resolveGltfChildTrs({ base, clipTrack, childNode: override(allFalse) })).toEqual(
      clipTrack,
    );
  });

  it('5. childNode overridden, no clip → manual', () => {
    expect(
      resolveGltfChildTrs({ base, clipTrack: undefined, childNode: override(allTrue) }),
    ).toEqual(manual);
  });

  it('6. childNode overridden, clip present → manual (manual beats clip)', () => {
    expect(resolveGltfChildTrs({ base, clipTrack, childNode: override(allTrue) })).toEqual(manual);
  });

  it('7. override value EQUALS base but flag set → manual still wins (back-to-base trap)', () => {
    // Director dragged the bone back to its base pose. overridden=true, so the
    // override layer must persist and the clip must NOT resurface.
    const backToBase: ChildOverride = { ...base, overridden: allTrue };
    expect(resolveGltfChildTrs({ base, clipTrack, childNode: backToBase })).toEqual(base);
    // ...and crucially NOT the clip:
    expect(resolveGltfChildTrs({ base, clipTrack, childNode: backToBase })).not.toEqual(clipTrack);
  });

  it('8. no childNode at all but clip present → clip (pre-7.7 path)', () => {
    expect(resolveGltfChildTrs({ base, clipTrack, childNode: undefined })).toEqual(clipTrack);
  });
});

describe('resolveGltfChildTrs — per-component mix', () => {
  it('manual position + clip rotation + base scale resolves each independently', () => {
    const mixed: ChildOverride = {
      position: [9, 9, 9],
      rotation: [99, 99, 99], // present but NOT overridden → clip should win
      scale: [99, 99, 99], // present but NOT overridden, no clip → base should win
      overridden: { position: true, rotation: false, scale: false },
    };
    const clipRotOnly: ChildTrs = {
      position: [5, 5, 5],
      rotation: [50, 50, 50],
      scale: [3, 3, 3],
    };
    const result = resolveGltfChildTrs({
      base,
      clipTrack: clipRotOnly,
      childNode: mixed,
    });
    expect(result.position).toEqual([9, 9, 9]); // manual (overridden)
    expect(result.rotation).toEqual([50, 50, 50]); // clip (not overridden, clip present)
    expect(result.scale).toEqual([3, 3, 3]); // clip wins over base too (clip present, scale not overridden)
  });

  it('manual position + NO clip → base for the unoverridden components', () => {
    const mixed: ChildOverride = {
      position: [9, 9, 9],
      rotation: [99, 99, 99],
      scale: [99, 99, 99],
      overridden: { position: true, rotation: false, scale: false },
    };
    const result = resolveGltfChildTrs({ base, clipTrack: undefined, childNode: mixed });
    expect(result.position).toEqual([9, 9, 9]); // manual
    expect(result.rotation).toEqual([10, 10, 10]); // base (no clip, not overridden)
    expect(result.scale).toEqual([2, 2, 2]); // base
  });
});

describe('resolveAllChildTrs — all children at once (one precedence rule)', () => {
  // P7.10 (#114): `clip: TransformClipValue | null` → `tracks: Record<.>`.
  // Caller now pre-samples (GltfAssetR's useFrame at live time; static
  // resolvers at their resolution time) and passes the materialized map.
  it('resolves each name via the per-child rule', () => {
    const childByName: Record<string, ChildOverride> = {
      bone: { ...base, overridden: allFalse },
      moved: override(allTrue),
    };
    const tracks = {
      bone: clipTrack,
      moved: clipTrack,
    };
    const result = resolveAllChildTrs({ names: ['bone', 'moved'], childByName, tracks });
    expect(result.bone).toEqual(clipTrack); // not overridden → clip
    expect(result.moved).toEqual(manual); // overridden → manual
  });

  it('omits names with neither a child node nor a clip track (keeps native TRS)', () => {
    const result = resolveAllChildTrs({
      names: ['orphan'],
      childByName: {},
      tracks: {},
    });
    expect(result.orphan).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('child node with no clip resolves to its base (seeded) TRS when not overridden', () => {
    const childByName: Record<string, ChildOverride> = {
      bone: { ...base, overridden: allFalse },
    };
    const result = resolveAllChildTrs({ names: ['bone'], childByName, tracks: null });
    expect(result.bone).toEqual(base);
  });

  it('clip-only name (pre-7.7, no child node) resolves to the clip track', () => {
    const result = resolveAllChildTrs({
      names: ['legacy'],
      childByName: {},
      tracks: { legacy: clipTrack },
    });
    expect(result.legacy).toEqual(clipTrack);
  });
});

// ---------------------------------------------------------------------------
// P7.12 #108 — the baked-channel band (manual → baked → clip → base).
// Presence-based (R-4): a field is present iff a baked channel contributed it;
// the win is NEVER decided by value-equality against clip or base.
// ---------------------------------------------------------------------------

describe('resolveGltfChildTrs — baked-channel band (P7.12, presence-based)', () => {
  const bakedTrs: ChildTrs = {
    position: [7, 7, 7],
    rotation: [70, 70, 70],
    scale: [6, 6, 6],
  };
  const bakedAll: BakedChannel = { ...bakedTrs };

  it('baked present, no manual → baked beats clip and base', () => {
    const result = resolveGltfChildTrs({
      base,
      clipTrack,
      childNode: undefined,
      bakedChannel: bakedAll,
    });
    expect(result).toEqual(bakedTrs);
  });

  it('baked == base value STILL wins over clip (presence, NOT value-equality)', () => {
    // The whole point of copy-on-write: once a bone is baked, its track is the
    // KeyframeChannel — a baked value that happens to equal the base pose must
    // NOT let the clip resurface. (The exact R-4 trap, baked-band edition.)
    const bakedEqualsBase: BakedChannel = {
      position: [...base.position] as ChildTrs['position'],
      rotation: [...base.rotation] as ChildTrs['rotation'],
      scale: [...base.scale] as ChildTrs['scale'],
    };
    const result = resolveGltfChildTrs({
      base,
      clipTrack,
      childNode: undefined,
      bakedChannel: bakedEqualsBase,
    });
    expect(result).toEqual(base);
    // crucially NOT the clip — the baked band suppressed it:
    expect(result).not.toEqual(clipTrack);
  });

  it('manual override still beats baked (manual > baked > clip > base)', () => {
    const result = resolveGltfChildTrs({
      base,
      clipTrack,
      childNode: override(allTrue),
      bakedChannel: bakedAll,
    });
    expect(result).toEqual(manual);
  });

  it('per-component mix: manual position, baked rotation, clip scale, base where none', () => {
    const mixedChild: ChildOverride = {
      position: [9, 9, 9],
      rotation: [99, 99, 99],
      scale: [99, 99, 99],
      overridden: { position: true, rotation: false, scale: false },
    };
    // baked supplies only rotation; clip supplies scale; position is manual.
    const bakedRotOnly: BakedChannel = { rotation: [70, 70, 70] };
    const result = resolveGltfChildTrs({
      base,
      clipTrack,
      childNode: mixedChild,
      bakedChannel: bakedRotOnly,
    });
    expect(result.position).toEqual([9, 9, 9]); // manual
    expect(result.rotation).toEqual([70, 70, 70]); // baked (present) beats clip
    expect(result.scale).toEqual(clipTrack.scale); // baked absent for scale → clip
  });

  it('baked absent for a field → falls through to clip, then base', () => {
    const bakedPosOnly: BakedChannel = { position: [7, 7, 7] };
    const withClip = resolveGltfChildTrs({
      base,
      clipTrack,
      childNode: undefined,
      bakedChannel: bakedPosOnly,
    });
    expect(withClip.position).toEqual([7, 7, 7]); // baked
    expect(withClip.rotation).toEqual(clipTrack.rotation); // clip
    const noClip = resolveGltfChildTrs({
      base,
      clipTrack: undefined,
      childNode: undefined,
      bakedChannel: bakedPosOnly,
    });
    expect(noClip.position).toEqual([7, 7, 7]); // baked
    expect(noClip.rotation).toEqual(base.rotation); // base (no clip, no baked field)
  });

  it('no bakedChannel arg at all → unchanged 3-band behavior (compile-staging back-compat)', () => {
    // Existing callers that do NOT pass bakedChannel must resolve identically to
    // pre-7.12 (manual → clip → base).
    expect(resolveGltfChildTrs({ base, clipTrack, childNode: undefined })).toEqual(clipTrack);
    expect(resolveGltfChildTrs({ base, clipTrack: undefined, childNode: undefined })).toEqual(base);
  });
});

describe('resolveAllChildTrs — baked band threaded by name (P7.12)', () => {
  it('a baked bone uses its baked TRS; an untouched bone keeps the clip', () => {
    const childByName: Record<string, ChildOverride> = {
      edited: { ...base, overridden: allFalse },
      untouched: { ...base, overridden: allFalse },
    };
    const tracks = { edited: clipTrack, untouched: clipTrack };
    const bakedByName = {
      edited: { position: [7, 7, 7], rotation: [70, 70, 70], scale: [6, 6, 6] } as BakedChannel,
    };
    const result = resolveAllChildTrs({
      names: ['edited', 'untouched'],
      childByName,
      tracks,
      bakedByName,
    });
    expect(result.edited).toEqual({
      position: [7, 7, 7],
      rotation: [70, 70, 70],
      scale: [6, 6, 6],
    }); // baked
    expect(result.untouched).toEqual(clipTrack); // clip (no baked entry)
  });

  it('a baked-only bone (no node, no clip) still resolves', () => {
    const bakedByName = {
      lonely: { position: [7, 7, 7], rotation: [70, 70, 70], scale: [6, 6, 6] } as BakedChannel,
    };
    const result = resolveAllChildTrs({
      names: ['lonely'],
      childByName: {},
      tracks: null,
      bakedByName,
    });
    expect(result.lonely).toEqual({
      position: [7, 7, 7],
      rotation: [70, 70, 70],
      scale: [6, 6, 6],
    });
  });
});
