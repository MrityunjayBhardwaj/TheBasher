// #903 — read-only dopesheet rows for a bone driven by an AnimationClip.
//
// The claim is not "rows appear". It is that the dopesheet shows exactly ONE
// row set per (bone, component): the clip's when nobody has authored, the real
// channel's when somebody has. Both halves have to be observed — a projection
// that showed everything would pass a test that only counted rows.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { gltfChannelDagId, gltfChildDagId } from '../core/import/gltfImportChain';
import { animationClipRowsForAsset, bakedChannelKeysForAsset } from './clipChannelRows';

const ASSET = 'user-imports/dwarf.glb';
const HIPS = 'mixamorig_Hips';
const ARM = 'mixamorig_LeftArm';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

type Nodes = Record<string, { type: string; params?: unknown; inputs?: Record<string, unknown> }>;

function rigged(extra?: Nodes): Nodes {
  const nodes: Nodes = {
    n_asset: {
      type: 'GltfAsset',
      params: { assetRef: ASSET, skins: [{ jointKeys: [HIPS, ARM] }] },
      inputs: {},
    },
    n_rig: {
      type: 'GltfSkeleton',
      params: { skinIndex: 0 },
      inputs: { asset: { node: 'n_asset', socket: 'out' } },
    },
    [gltfChildDagId(ASSET, HIPS)]: {
      type: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: HIPS,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      inputs: {},
    },
    [gltfChildDagId(ASSET, ARM)]: {
      type: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: ARM,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      inputs: {},
    },
    n_clip: {
      type: 'AnimationClip',
      params: {
        duration: 1,
        loop: true,
        keyframes: [
          { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { bone: 0, time: 0.5, position: [0, 2, 0], rotation: [0, 0, 0] },
          { bone: 1, time: 0, position: [1, 0, 0], rotation: [0, 0, 0] },
          { bone: 1, time: 1, position: [2, 0, 0], rotation: [0, 0, 0] },
        ],
      },
      inputs: { skeleton: { node: 'n_rig', socket: 'out' } },
    },
  };
  return { ...nodes, ...(extra ?? {}) };
}

/** One minted channel — what slice 2 leaves behind after a director edits ONE
 *  component of ONE bone. */
function mintedRotation(childName: string): Nodes {
  const id = gltfChannelDagId(ASSET, childName, 'rotation');
  return {
    [id]: {
      type: 'KeyframeChannelVec3',
      params: {
        name: `${childName} — rotation`,
        target: gltfChildDagId(ASSET, childName),
        childName,
        assetRef: ASSET,
        paramPath: 'rotation',
        keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
      },
      inputs: {},
    },
  };
}

describe('projecting an AnimationClip into rows', () => {
  it('gives every bone the clip touches two rows — position and rotation', () => {
    const rows = animationClipRowsForAsset({ nodes: rigged(), assetRef: ASSET });
    expect(rows.map((r) => r.channelId).sort()).toEqual([
      `clip:${HIPS}:position`,
      `clip:${HIPS}:rotation`,
      `clip:${ARM}:position`,
      `clip:${ARM}:rotation`,
    ]);
  });

  it('never projects a scale row — the clip has no scale track to show', () => {
    // A scale row would be a claim with nothing behind it: AnimationClip's
    // schema carries position and rotation only, and the eager bake agreed —
    // 46 channels for 23 bones is two per bone, never three.
    const rows = animationClipRowsForAsset({ nodes: rigged(), assetRef: ASSET });
    expect(rows.some((r) => r.channelId.endsWith(':scale'))).toBe(false);
  });

  it('marks every projected row read-only', () => {
    const rows = animationClipRowsForAsset({ nodes: rigged(), assetRef: ASSET });
    expect(rows.every((r) => r.readOnly === true)).toBe(true);
  });

  it('carries the bone’s OWN key times, not the whole clip’s', () => {
    // The row that separates "this bone's track" from "the clip's timeline".
    // Hips is keyed at 0 and 0.5; the arm at 0 and 1.
    const rows = animationClipRowsForAsset({ nodes: rigged(), assetRef: ASSET });
    const hips = rows.find((r) => r.channelId === `clip:${HIPS}:position`)!;
    const arm = rows.find((r) => r.channelId === `clip:${ARM}:position`)!;
    expect(hips.keyframes.map((k) => k.time)).toEqual([0, 0.5]);
    expect(arm.keyframes.map((k) => k.time)).toEqual([0, 1]);
  });
});

describe('one row set per (bone, component)', () => {
  it('suppresses ONLY the component that has a real channel', () => {
    // The half a per-bone suppression would get wrong. The eager bake was
    // whole-bone, so "is this bone baked?" was a complete question; minting is
    // per component, so suppressing by bone would hide the arm's POSITION row
    // — a track that is still driving the character — the moment its rotation
    // was edited.
    const rows = animationClipRowsForAsset({
      nodes: rigged(mintedRotation(ARM)),
      assetRef: ASSET,
    });
    const ids = rows.map((r) => r.channelId).sort();
    expect(ids).toContain(`clip:${ARM}:position`);
    expect(ids).not.toContain(`clip:${ARM}:rotation`);
    // The other bone is untouched by somebody else's edit.
    expect(ids).toContain(`clip:${HIPS}:position`);
    expect(ids).toContain(`clip:${HIPS}:rotation`);
  });

  it('projects nothing at all once every component is authored', () => {
    const nodes = rigged({ ...mintedRotation(ARM), ...mintedRotation(HIPS) });
    const rows = animationClipRowsForAsset({ nodes, assetRef: ASSET });
    expect(rows.map((r) => r.channelId).sort()).toEqual([
      `clip:${HIPS}:position`,
      `clip:${ARM}:position`,
    ]);
  });

  it('keys the suppression set by bone AND component', () => {
    const keys = bakedChannelKeysForAsset(rigged(mintedRotation(ARM)), ASSET);
    expect([...keys]).toEqual([`${ARM}:rotation`]);
  });
});

describe('a clip that is not bound to this asset', () => {
  it('contributes no rows — the walk follows the edge, not the name', () => {
    // The retargeted clip hangs off the rig; a source clip hanging off a plain
    // Skeleton must not leak in, because its bone indices belong to a different
    // spine and would name the wrong bones.
    const nodes = rigged({
      n_source_rig: { type: 'Skeleton', params: {}, inputs: {} },
      n_source_clip: {
        type: 'AnimationClip',
        params: {
          duration: 1,
          keyframes: [{ bone: 0, time: 0, position: [9, 9, 9], rotation: [0, 0, 0] }],
        },
        inputs: { skeleton: { node: 'n_source_rig', socket: 'out' } },
      },
    });
    const rows = animationClipRowsForAsset({ nodes, assetRef: ASSET });
    expect(rows).toHaveLength(4);
  });
});
