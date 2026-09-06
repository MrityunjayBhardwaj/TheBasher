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
import {
  animationClipRowsForAsset,
  appendAnimationClipRows,
  bakedChannelKeysForAsset,
  type ChannelRow,
} from './clipChannelRows';
import { collectChannelRows } from './TimelineCanvas';
import type { Node } from '../core/dag/types';

const ASSET = 'user-imports/dwarf.glb';
const HIPS = 'mixamorig_Hips';
const ARM = 'mixamorig_LeftArm';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

type Nodes = Record<
  string,
  { id?: string; type: string; params?: unknown; inputs?: Record<string, unknown> }
>;

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
function mintedChannel(childName: string, component: 'position' | 'rotation'): Nodes {
  const id = gltfChannelDagId(ASSET, childName, component);
  return {
    [id]: {
      // `collectChannelRows` reads `node.id`, so a fixture channel that omits it
      // yields a row with an undefined id — indistinguishable from a real one by
      // count, and wrong by identity. The store always carries it; so does this.
      id,
      type: 'KeyframeChannelVec3',
      params: {
        name: `${childName} — ${component}`,
        target: gltfChildDagId(ASSET, childName),
        childName,
        assetRef: ASSET,
        paramPath: component,
        keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
      },
      inputs: {},
    },
  };
}

function mintedRotation(childName: string): Nodes {
  return mintedChannel(childName, 'rotation');
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

// ---------------------------------------------------------------------------
// The composition the dopesheet actually evaluates.
//
// Everything above tests `animationClipRowsForAsset`, the inner projection.
// `TimelineCanvas.tsx:575` calls the WRAPPER over a base of real channel rows,
// and that pairing is the whole claim: as the eager bake stops emitting
// channels, the projection has to take over so the timeline never goes blank.
// Neither half failing alone proves it — only the pair does.
// ---------------------------------------------------------------------------

const COMPONENTS = ['position', 'rotation'] as const;

/** The eager bake's analogue: a real channel for every (bone, component). */
function fullyBaked(): Nodes {
  let channels: Nodes = {};
  for (const bone of [HIPS, ARM]) {
    for (const component of COMPONENTS) {
      channels = { ...channels, ...mintedChannel(bone, component) };
    }
  }
  return rigged(channels);
}

/** What copy-on-write leaves behind once the bake stops: no channel nodes. */
function withoutChannels(nodes: Nodes): Nodes {
  const out: Nodes = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (!node.type.startsWith('KeyframeChannel')) out[id] = node;
  }
  return out;
}

function channelCount(nodes: Nodes): number {
  return Object.values(nodes).filter((n) => n.type.startsWith('KeyframeChannel')).length;
}

/** EXACTLY the expression `TimelineCanvas.tsx:575` evaluates. */
function dopesheetRows(nodes: Nodes): ChannelRow[] {
  return appendAnimationClipRows({
    // One cast, and only where it is forced: `collectChannelRows` takes the
    // store's full `Node`, while this fixture is the structural subset the walk
    // actually reads. `nodes` goes to the wrapper UNCAST on purpose — casting it
    // (or using `as never`, which disables checking entirely) would let a change
    // to the wrapper's own signature pass this file silently, which is the very
    // class of drift these rows exist to catch.
    baseRows: collectChannelRows(nodes as unknown as Record<string, Node>),
    nodes,
  });
}

describe('the dopesheet survives the bake going away', () => {
  it('ANTI-VACUITY: the fixture witnesses the property it is used to test', () => {
    // A before/after row count proves nothing if the "before" graph had no
    // channels to lose — 0 -> 0 holds trivially and reads exactly like a pass.
    // If someone later swaps in a friendlier fixture, this is the row that
    // reddens rather than the count silently becoming a tautology.
    const baked = fullyBaked();
    expect(channelCount(baked)).toBe(4); // 2 bones x position + rotation
    expect(channelCount(withoutChannels(baked))).toBe(0);
  });

  it('channels go 4 -> 0 while the row count HOLDS, and the rows change hands', () => {
    const baked = fullyBaked();

    const before = dopesheetRows(baked);
    expect(before).toHaveLength(4);
    // Every row is a real, editable channel; the projection is fully suppressed.
    expect(before.filter((r) => r.readOnly === true)).toHaveLength(0);

    const after = dopesheetRows(withoutChannels(baked));
    expect(after).toHaveLength(before.length); // the claim #903 wrote down
    expect(after.every((r) => r.readOnly === true)).toBe(true);
    expect(after.map((r) => r.channelId).sort()).toEqual(
      [
        `clip:${HIPS}:position`,
        `clip:${HIPS}:rotation`,
        `clip:${ARM}:position`,
        `clip:${ARM}:rotation`,
      ].sort(),
    );
  });

  it('a HALF-authored rig shows both kinds at once, still one row per (bone, component)', () => {
    // The state a director is actually in: one component edited, the rest still
    // following the clip. A wrapper that replaced rather than appended, or a
    // per-bone suppression, would both lose rows here.
    const nodes = rigged(mintedChannel(ARM, 'rotation'));
    const rows = dopesheetRows(nodes);
    expect(rows).toHaveLength(4);
    const editable = rows.filter((r) => r.readOnly !== true);
    expect(editable).toHaveLength(1);
    expect(editable[0].channelId).toBe(gltfChannelDagId(ASSET, ARM, 'rotation'));
    expect(
      rows
        .filter((r) => r.readOnly === true)
        .map((r) => r.channelId)
        .sort(),
    ).toEqual([`clip:${HIPS}:position`, `clip:${HIPS}:rotation`, `clip:${ARM}:position`].sort());
  });
});

describe('the wrapper the dopesheet calls', () => {
  it('APPENDS to the rows it was handed — it never replaces them', () => {
    const sentinel: ChannelRow = { channelId: 'sentinel', name: 'sentinel', keyframes: [] };
    const out = appendAnimationClipRows({
      baseRows: [sentinel],
      nodes: withoutChannels(rigged()) as never,
    });
    expect(out[0]).toBe(sentinel);
    expect(out).toHaveLength(1 + 4);
  });

  it('skips an asset with no usable ref rather than projecting under an empty name', () => {
    const unusable = [undefined, '', 42];
    let examined = 0;
    for (const assetRef of unusable) {
      const nodes = withoutChannels(rigged());
      const asset = nodes.n_asset;
      nodes.n_asset = { ...asset, params: { ...(asset.params as object), assetRef } };
      expect(dopesheetRows(nodes)).toHaveLength(0);
      examined += 1;
    }
    // Every assertion here lives inside the loop, so an empty list would report
    // the same green as a complete pass. State the denominator.
    expect(examined).toBe(unusable.length);
    expect(examined).toBeGreaterThan(0);
  });

  it('walks GltfAsset nodes ONLY — a shared assetRef never projects the rig twice', () => {
    // Removing `n_asset` would NOT test this: with nothing to project, the walk
    // returns nothing whether or not it filters by type. The discriminating
    // shape is an asset that IS projectable sitting beside other nodes carrying
    // the same ref — the rig's own bones already do — where dropping the filter
    // multiplies the dopesheet instead of emptying it.
    const nodes = withoutChannels(rigged());
    nodes.n_impostor = { type: 'GltfChild', params: { assetRef: ASSET }, inputs: {} };
    expect(dopesheetRows(nodes)).toHaveLength(4);
  });
});
