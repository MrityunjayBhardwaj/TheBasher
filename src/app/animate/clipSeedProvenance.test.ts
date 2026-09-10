// #1001 — a re-cooked clip must not leave the director's edited bones behind in
// silence, AND the signal that says so must not fire on a deliberate edit.
//
// 🔴 THE LOSING ALTERNATIVE IS IN THIS FILE, AND IT IS THE POINT. The cheap fix
// for #1001 is to compare the channel's keys against the clip's. That check
// passes every "detects the re-cook" row below and fails exactly one — the row
// where a director edits a bone and nothing else happens. Delete the recorded
// provenance and derive staleness from the keys, and `an edited channel is NOT
// stale` reds. Without that row this whole file would be green for the wrong
// mechanism.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { gltfChannelDagId, gltfChildDagId } from '../../core/import/gltfImportChain';
import { importedChildNodes } from '../../test-utils/importedChildFixture';
import { ensureChannelForBone } from './ensureChannelForBone';
import { channelSeedRows, staleSeedBones, staleSeedCount } from './clipSeedProvenance';

const ASSET = 'user-imports/dwarf.glb';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';
const CHILD = gltfChildDagId(ASSET, BONE);

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** A clip keyframe. Rotation is RADIANS in a clip — the seed converts. */
function key(bone: number, time: number, y: number) {
  return { bone, time, position: [0, y, 0], rotation: [0, 0, 0] };
}

/** An imported rig with one clip bound to it, as `boundClipsForAsset` walks it. */
function riggedState(keyframes: unknown[] = [key(1, 0, 1), key(1, 1, 2)]): DagState {
  return {
    nodes: {
      n_asset: {
        id: 'n_asset',
        type: 'GltfAsset',
        params: { assetRef: ASSET, skins: [{ jointKeys: [OTHER, BONE] }] },
        inputs: {},
      },
      n_rig: {
        id: 'n_rig',
        type: 'GltfSkeleton',
        params: { skinIndex: 0 },
        inputs: { asset: { node: 'n_asset', socket: 'out' } },
      },
      n_clip: {
        id: 'n_clip',
        type: 'AnimationClip',
        params: { duration: 1, loop: 'hold', keyframes },
        inputs: { skeleton: { node: 'n_rig', socket: 'out' } },
      },
      ...importedChildNodes(CHILD, {
        assetRef: ASSET,
        childName: BONE,
        position: [1, 2, 3],
        rotation: [10, 20, 30],
        scale: [1, 1, 1],
      }),
    },
    outputs: {},
  } as unknown as DagState;
}

/**
 * The mint, pushed through the REAL op road so the params land zod-PARSED.
 *
 * Not a convenience: `applyAddNode` stores parsed params, so a provenance field
 * the schema does not declare is SILENTLY STRIPPED and every row here would read
 * `unknown` while the mint looked correct at its own call site. Asserting on the
 * ops alone could never catch that.
 */
function mint(state: DagState, component: 'position' | 'rotation'): DagState {
  const out = ensureChannelForBone(state, CHILD, component);
  expect(out).not.toBeNull();
  let next = state;
  for (const op of out!.ops) next = applyOp(next, op as Op).next;
  return next;
}

/** Replace the clip's keys the way a re-cook does — same node, new params. */
function recook(state: DagState, keyframes: unknown[]): DagState {
  return {
    ...state,
    nodes: {
      ...state.nodes,
      n_clip: {
        ...state.nodes.n_clip,
        params: { ...(state.nodes.n_clip.params as object), keyframes },
      },
    },
  } as unknown as DagState;
}

/** Rewrite a channel's keys the way a DIRECTOR does — the authored case. */
function editChannel(state: DagState, component: 'position' | 'rotation'): DagState {
  const id = gltfChannelDagId(ASSET, BONE, component);
  return applyOp(state, {
    type: 'setParam',
    nodeId: id,
    paramPath: 'keyframes',
    value: [
      { time: 0, value: [0, 42, 0], easing: 'linear' },
      { time: 1, value: [0, 77, 0], easing: 'linear' },
    ],
  } as unknown as Op).next;
}

function rowFor(state: DagState, component: 'position' | 'rotation') {
  return channelSeedRows(state, ASSET).find((r) => r.component === component);
}

describe('#1001 — provenance is recorded at the mint', () => {
  it('the recorded fields SURVIVE the zod parse', () => {
    // The whole mechanism rides on two optional params being declared on
    // KeyframeChannelVec3. Undeclared, they are dropped without a word and the
    // read reports `unknown` for a channel that was just minted from a clip.
    const s = mint(riggedState(), 'position');
    const p = s.nodes[gltfChannelDagId(ASSET, BONE, 'position')].params as {
      sourceClipId?: string;
      sourceHash?: string;
    };
    expect(p.sourceClipId).toBe('n_clip');
    expect(typeof p.sourceHash).toBe('string');
    expect(p.sourceHash).not.toBe('');
  });

  it('a freshly minted channel reads CURRENT', () => {
    expect(rowFor(mint(riggedState(), 'position'), 'position')!.state).toBe('current');
    expect(staleSeedCount(mint(riggedState(), 'position'), ASSET)).toBe(0);
  });
});

describe('#1001 — the re-cook is detected', () => {
  it('a clip re-cooked under an UNTOUCHED channel reads STALE', () => {
    const minted = mint(riggedState(), 'position');
    const after = recook(minted, [key(1, 0, 1), key(1, 1, 999)]);
    expect(rowFor(after, 'position')!.state).toBe('stale');
    expect(staleSeedBones(after, ASSET)).toEqual([BONE]);
  });

  it('a clip re-cooked under an EDITED channel reads STALE — the defect itself', () => {
    // The bone the director cared enough to edit is the one left on the old
    // motion while its neighbours follow the new clip.
    const minted = mint(riggedState(), 'position');
    const after = recook(editChannel(minted, 'position'), [key(1, 0, 1), key(1, 1, 999)]);
    expect(rowFor(after, 'position')!.state).toBe('stale');
  });

  it('the row names WHICH clip it was seeded from and which one carries the bone now', () => {
    const after = recook(mint(riggedState(), 'position'), [key(1, 0, 1), key(1, 1, 999)]);
    const row = rowFor(after, 'position')!;
    expect(row.seededFrom).toBe('n_clip');
    expect(row.clipNow).toBe('n_clip');
    expect(row.childName).toBe(BONE);
  });
});

describe('#1001 — 🔴 THE LOSING ALTERNATIVE: an edit is not staleness', () => {
  it('a channel the DIRECTOR rewrote, over an unchanged clip, is NOT stale', () => {
    // Reds for any implementation that compares the channel's keys against the
    // clip's. Every other row in this file is green for that implementation too.
    const edited = editChannel(mint(riggedState(), 'position'), 'position');
    const keys = (
      edited.nodes[gltfChannelDagId(ASSET, BONE, 'position')].params as {
        keyframes: { value: number[] }[];
      }
    ).keyframes;
    // The edit really did diverge from the clip — otherwise the row below proves
    // nothing at all.
    expect(keys.map((k) => k.value[1])).toEqual([42, 77]);
    expect(rowFor(edited, 'position')!.state).toBe('current');
    expect(staleSeedCount(edited, ASSET)).toBe(0);
  });

  it('a change to ANOTHER bone’s track leaves this bone CURRENT', () => {
    // A clip-wide hash would red here, and re-cooking a walk would report every
    // edited bone stale including the ones whose motion is byte-identical.
    const minted = mint(riggedState(), 'position');
    const after = recook(minted, [key(1, 0, 1), key(1, 1, 2), key(0, 0, 555)]);
    expect(rowFor(after, 'position')!.state).toBe('current');
  });

  it('a change to another COMPONENT leaves this component CURRENT', () => {
    // The provenance is keyed per component. One stamped for the whole call
    // would put the position track's revision on the rotation channel.
    let s = mint(riggedState(), 'rotation');
    s = mint(s, 'position');
    const after = recook(s, [
      { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
      { bone: 1, time: 1, position: [0, 2, 0], rotation: [1.5, 0, 0] },
    ]);
    expect(rowFor(after, 'position')!.state).toBe('current');
    expect(rowFor(after, 'rotation')!.state).toBe('stale');
  });
});

describe('#1001 — absent provenance is UNKNOWN, never current', () => {
  it('a channel minted before this field cannot be vouched for', () => {
    // Every channel in every project saved until now. Calling it `current`
    // vouches for a copy nobody can vouch for; calling it `stale` alarms on
    // every bone of every existing project. Neither is true.
    const s = applyOp(riggedState(), {
      type: 'addNode',
      nodeId: gltfChannelDagId(ASSET, BONE, 'position'),
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'legacy',
        target: CHILD,
        childName: BONE,
        assetRef: ASSET,
        paramPath: 'position',
        keyframes: [{ time: 0, value: [0, 1, 0], easing: 'linear' }],
      },
    } as unknown as Op).next;
    expect(rowFor(s, 'position')!.state).toBe('unknown');
    expect(rowFor(s, 'position')!.seededFrom).toBeNull();
    expect(staleSeedCount(s, ASSET)).toBe(0);
  });
});

describe('#1001 — a bone with no clip at the mint', () => {
  it('records the EMPTY track, and goes stale once a clip carries the bone', () => {
    // The base-pose fallback. Its stored keys are the bone's own pose, so a hash
    // OF THE STORED KEYS would read stale the instant it was minted. What is
    // recorded is the consultation: the clip offered nothing.
    const noTrack = riggedState([key(0, 0, 9)]);
    const minted = mint(noTrack, 'position');
    expect(rowFor(minted, 'position')!.state).toBe('current');
    expect(rowFor(minted, 'position')!.seededFrom).toBe('');

    const clipArrives = recook(minted, [key(0, 0, 9), key(1, 0, 1), key(1, 1, 2)]);
    // The keys demonstrably predate the motion its neighbours are now playing.
    expect(rowFor(clipArrives, 'position')!.state).toBe('stale');
  });
});
