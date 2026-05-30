// clipChannelRows — B1 unit tests (Phase 7.12 Wave B, issue #108).
//
// The R5 key-discrimination test is the load-bearing one: a clip is keyed by
// childName (the NAME), never the GltfChild dagId. Querying by the dagId MUST
// yield zero rows — that mismatch is the exact #108 symptom in reverse (a
// silent-empty timeline on a clearly-animated bone).

import { describe, it, expect } from 'vitest';
import {
  clipRowsForChild,
  clipRowChannelId,
  activeClipKeyframesForAsset,
  bakedChildNamesForAsset,
  appendSelectionClipRows,
  resolveClipRow,
  type ClipKeyframe,
  type ChannelRow,
} from './clipChannelRows';

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

// ─────────────────────────────────────────────────────────────────────────
// B2 — selection → clip-row wiring + FLAG-3 single-row-set
// ─────────────────────────────────────────────────────────────────────────

// A minimal DAG mirroring the import chain: GltfAsset → ClipSelect → 1
// TransformClip, plus a GltfChild for `bone_1`. Shapes match the helpers'
// structural reads (params + inputs only).
const ASSET_REF = 'asset-abc';
const dagNodes = (): Record<string, { type: string; params?: unknown; inputs?: unknown }> => ({
  n_gltf_x: {
    type: 'GltfAsset',
    params: { assetRef: ASSET_REF },
    inputs: { transformClip: { node: 'n_sel_x', socket: 'out' } },
  },
  n_sel_x: {
    type: 'ClipSelect',
    params: { selectedClipName: 'walk' },
    inputs: { clips: [{ node: 'n_clip_0', socket: 'out' }] },
  },
  n_clip_0: {
    type: 'TransformClip',
    params: { name: 'walk', duration: 1.5, keyframes: fixture },
    inputs: {},
  },
  n_gltfChild_bone1: {
    type: 'GltfChild',
    params: { assetRef: ASSET_REF, childName: 'bone_1' },
    inputs: {},
  },
});

describe('activeClipKeyframesForAsset', () => {
  it('walks GltfAsset → ClipSelect → matching TransformClip and returns its keyframes', () => {
    const kfs = activeClipKeyframesForAsset(dagNodes(), ASSET_REF);
    expect(kfs).toBe(fixture); // same reference — direct param read, no copy
  });

  it('returns [] when no asset matches the assetRef', () => {
    expect(activeClipKeyframesForAsset(dagNodes(), 'no-such-asset')).toEqual([]);
  });

  it('returns [] when the ClipSelect selects a clip name that no clip carries', () => {
    const nodes = dagNodes();
    (nodes.n_sel_x.params as { selectedClipName: string }).selectedClipName = 'run';
    expect(activeClipKeyframesForAsset(nodes, ASSET_REF)).toEqual([]);
  });
});

describe('appendSelectionClipRows', () => {
  const base: ChannelRow[] = [{ channelId: 'n_existing', name: 'existing', keyframes: [] }];

  it('appends the selected GltfChild clip rows to the base rows', () => {
    const rows = appendSelectionClipRows({
      baseRows: base,
      nodes: dagNodes(),
      selectedNodeId: 'n_gltfChild_bone1',
    });
    expect(rows).toHaveLength(1 + 3); // existing + 3 clip component rows
    expect(rows.slice(1).map((r) => r.channelId)).toEqual([
      'clip:bone_1:position',
      'clip:bone_1:rotation',
      'clip:bone_1:scale',
    ]);
    expect(rows.slice(1).every((r) => r.readOnly)).toBe(true);
  });

  it('returns base rows unchanged when nothing is selected', () => {
    const rows = appendSelectionClipRows({
      baseRows: base,
      nodes: dagNodes(),
      selectedNodeId: null,
    });
    expect(rows).toBe(base);
  });

  it('returns base rows unchanged when a non-GltfChild is selected', () => {
    const rows = appendSelectionClipRows({
      baseRows: base,
      nodes: dagNodes(),
      selectedNodeId: 'n_clip_0',
    });
    expect(rows).toBe(base);
  });

  // FLAG-3 — the single-row-set invariant. Once a bone is baked (a
  // KeyframeChannel carrying its childName+assetRef exists), its clip rows are
  // SUPPRESSED so the dopesheet shows exactly ONE row set (the baked rows via
  // the orphan path), never clip-row + baked-row.
  it('FLAG-3: suppresses clip rows once the bone is baked', () => {
    const nodes = dagNodes();
    nodes.n_baked_bone1 = {
      type: 'KeyframeChannelVec3',
      params: { childName: 'bone_1', assetRef: ASSET_REF, paramPath: 'position', keyframes: [] },
      inputs: {},
    };
    // The baked channel itself would appear via collectChannelRows' orphan
    // path; here baseRows stands in for that. appendSelectionClipRows must NOT
    // add clip rows on top.
    const bakedBase: ChannelRow[] = [
      { channelId: 'n_baked_bone1', name: 'bone_1 — position', keyframes: [] },
    ];
    const rows = appendSelectionClipRows({
      baseRows: bakedBase,
      nodes,
      selectedNodeId: 'n_gltfChild_bone1',
    });
    expect(rows).toBe(bakedBase); // exactly one row set — no clip rows appended
    expect(rows.some((r) => r.channelId.startsWith('clip:'))).toBe(false);
  });
});

describe('bakedChildNamesForAsset', () => {
  it('is empty when no bone has been baked (pre-Wave-D)', () => {
    expect(bakedChildNamesForAsset(dagNodes(), ASSET_REF).size).toBe(0);
  });

  it('collects the childName of a baked channel scoped to the asset', () => {
    const nodes = dagNodes();
    nodes.n_baked_bone1 = {
      type: 'KeyframeChannelVec3',
      params: { childName: 'bone_1', assetRef: ASSET_REF, paramPath: 'position' },
      inputs: {},
    };
    const baked = bakedChildNamesForAsset(nodes, ASSET_REF);
    expect(baked.has('bone_1')).toBe(true);
  });
});

describe('resolveClipRow', () => {
  it('resolves a synthetic clip-row id back to its source clip keyframes', () => {
    const resolved = resolveClipRow(dagNodes(), 'clip:bone_1:rotation');
    expect(resolved?.childName).toBe('bone_1');
    expect(resolved?.component).toBe('rotation');
    expect(resolved?.keyframes.map((k) => k.time)).toEqual([0, 1.5]);
  });

  it('returns null for a real (non-clip) channel id', () => {
    expect(resolveClipRow(dagNodes(), 'n_existing')).toBeNull();
  });

  it('returns null when the bone has no clip', () => {
    expect(resolveClipRow(dagNodes(), 'clip:ghost_bone:position')).toBeNull();
  });
});
