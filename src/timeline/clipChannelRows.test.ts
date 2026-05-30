// clipChannelRows — B1 unit tests (Phase 7.12 Wave B, issue #108).
//
// The R5 key-discrimination test is the load-bearing one: a clip is keyed by
// childName (the NAME), never the GltfChild dagId. Querying by the dagId MUST
// yield zero rows — that mismatch is the exact #108 symptom in reverse (a
// silent-empty timeline on a clearly-animated bone).

import { describe, it, expect } from 'vitest';
import { clipRowsForChild, clipRowChannelId, type ClipKeyframe } from './clipChannelRows';

// A 2-key TRS clip for a single bone named `bone_1`, mirroring the shape
// gltfImportChain.buildClipKeyframes produces (targetNodeId = the NAME key).
const fixture: ClipKeyframe[] = [
  {
    targetNodeId: 'bone_1',
    time: 0,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  },
  {
    targetNodeId: 'bone_1',
    time: 1.5,
    position: [0, 2, 0],
    rotation: [0, 90, 0],
    scale: [1, 1, 1],
  },
  // A second bone's keys — must NOT leak into bone_1's rows.
  {
    targetNodeId: 'bone_2',
    time: 0.5,
    position: [5, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  },
];

describe('clipRowsForChild', () => {
  it('projects a TRS clip track into 3 component rows (position/rotation/scale)', () => {
    const rows = clipRowsForChild({ clipKeyframes: fixture, childName: 'bone_1' });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.channelId)).toEqual([
      'clip:bone_1:position',
      'clip:bone_1:rotation',
      'clip:bone_1:scale',
    ]);
  });

  it('carries the right keyframe times (only this bone, sorted)', () => {
    const rows = clipRowsForChild({ clipKeyframes: fixture, childName: 'bone_1' });
    for (const row of rows) {
      // bone_1 has exactly its 2 keys at t=0 and t=1.5 — bone_2's t=0.5 excluded.
      expect(row.keyframes.map((k) => k.time)).toEqual([0, 1.5]);
    }
  });

  it('flags every projected row readOnly:true', () => {
    const rows = clipRowsForChild({ clipKeyframes: fixture, childName: 'bone_1' });
    expect(rows.every((r) => r.readOnly === true)).toBe(true);
  });

  // R5 — the key-discrimination guard. The GltfChild dagId
  // (`n_gltfChild_<hash>`) is NOT the clip track key; querying by it returns [].
  it('R5: querying by the GltfChild dagId yields ZERO rows (NAME key, not dagId)', () => {
    const dagId = 'n_gltfChild_deadbeef'; // a stand-in for hashId('gltfChild',…)
    const rows = clipRowsForChild({ clipKeyframes: fixture, childName: dagId });
    expect(rows).toEqual([]);
  });

  it('returns [] for a bone with no clip track', () => {
    const rows = clipRowsForChild({ clipKeyframes: fixture, childName: 'no_such_bone' });
    expect(rows).toEqual([]);
  });

  it('sorts unsorted input by time', () => {
    const unsorted: ClipKeyframe[] = [
      { ...fixture[1] }, // t=1.5 first
      { ...fixture[0] }, // t=0 second
    ];
    const rows = clipRowsForChild({ clipKeyframes: unsorted, childName: 'bone_1' });
    expect(rows[0].keyframes.map((k) => k.time)).toEqual([0, 1.5]);
  });
});

describe('clipRowChannelId', () => {
  it('namespaces the synthetic id so it cannot collide with a real channel id', () => {
    expect(clipRowChannelId('bone_1', 'position')).toBe('clip:bone_1:position');
    // Real channel ids are `n_…` hashIds — the `clip:` prefix never collides.
    expect(clipRowChannelId('bone_1', 'position').startsWith('clip:')).toBe(true);
  });
});
