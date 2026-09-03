// dispatchClearBakedMotion — the character-level clear (#813).
//
// The per-bone revert (#108 D3) is unit-tested next door; this asserts the three
// things the FAN-OUT adds, which per-bone coverage cannot show:
//
//   1. ALL of a character's bones clear in ONE undo entry, not one per bone.
//   2. What is deleted is exactly what the RENDERER plays — asserted against
//      `bakedChannelSamplersForAsset` itself, not against a re-derived id list.
//      A clear that leaves a channel the renderer still samples would keep the
//      character moving after reporting success (the H516 shape, one level up).
//   3. The clear is SCOPED: a second character in the scene keeps its motion.
//
// Plus the two answers that must not collapse into each other: "already clear"
// (ok, nothing to do) and "cannot tell" (no such asset → refusal).

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, type DagState } from '../../core/dag';
import { buildDefaultDagState } from '../../core/project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchClearBakedMotion } from './dispatchMutator';
import { bakedChannelSamplersForAsset, bakedChannelIdsForAssetRef } from '../bakedGltfChannels';
import { gltfChildDagId, gltfChannelDagId } from '../../core/import/gltfImportChain';

const ASSET = 'char-a';
const OTHER = 'char-b';
const BONES = ['bone_1', 'bone_2', 'bone_3'];

const BAKED_POS: [number, number, number] = [3, 3, 3];

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

function nameMapFor(assetRef: string): Record<string, string> {
  return Object.fromEntries(BONES.map((b) => [b, gltfChildDagId(assetRef, b)]));
}

/** A character whose bones each carry a baked position+rotation channel. */
function addCharacter(s: DagState, assetRef: string, assetNodeId: string): DagState {
  s = applyOp(s, {
    type: 'addNode',
    nodeId: assetNodeId,
    nodeType: 'GltfAsset',
    params: { assetRef, nodeNameMap: nameMapFor(assetRef) },
  }).next;
  for (const bone of BONES) {
    const childId = gltfChildDagId(assetRef, bone);
    s = applyOp(s, {
      type: 'addNode',
      nodeId: childId,
      nodeType: 'GltfChild',
      params: {
        assetRef,
        childName: bone,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overridden: { position: false, rotation: false, scale: false },
      },
    }).next;
    for (const component of ['position', 'rotation'] as const) {
      s = applyOp(s, {
        type: 'addNode',
        nodeId: gltfChannelDagId(assetRef, bone, component),
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: `${bone} — ${component}`,
          target: childId,
          childName: bone,
          assetRef,
          paramPath: component,
          keyframes: [{ time: 0, value: BAKED_POS, easing: 'linear' }],
        },
      }).next;
    }
  }
  return s;
}

function buildTwoCharacterScene(): DagState {
  let s = buildDefaultDagState();
  s = addCharacter(s, ASSET, 'n_gltf_a');
  s = addCharacter(s, OTHER, 'n_gltf_b');
  return s;
}

/** What the RENDERER would play for this asset — the enumerator it actually reads. */
function rendererSeesBonesFor(nodes: DagState['nodes'], assetRef: string): string[] {
  return Object.keys(bakedChannelSamplersForAsset(nodes, nameMapFor(assetRef), assetRef)).sort();
}

describe('dispatchClearBakedMotion (#813 — the character-level fan-out)', () => {
  it('clears EVERY bone of the character in ONE undo entry', () => {
    useDagStore.getState().hydrate(buildTwoCharacterScene());
    expect(useDagStore.getState().undoStack).toHaveLength(0);
    // Precondition: the renderer plays all three bones.
    expect(rendererSeesBonesFor(useDagStore.getState().state.nodes, ASSET)).toEqual(BONES);

    const res = dispatchClearBakedMotion({ assetRef: ASSET, label: 'char-a' });
    expect(res.ok).toBe(true);

    const after = useDagStore.getState().state;
    for (const bone of BONES) {
      for (const component of ['position', 'rotation'] as const) {
        expect(after.nodes[gltfChannelDagId(ASSET, bone, component)]).toBeUndefined();
      }
    }
    // ONE atomic undo for the whole character — not one per bone (K6).
    const stack = useDagStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect((stack[0] as { __atomic?: true }).__atomic).toBe(true);
  });

  it('after the clear the RENDERER sees no baked motion for that character', () => {
    useDagStore.getState().hydrate(buildTwoCharacterScene());
    dispatchClearBakedMotion({ assetRef: ASSET });

    // The load-bearing assertion: asked of the enumerator the renderer reads,
    // not of the id list the clear computed. These agree only because they share
    // one membership predicate — which is the whole point.
    expect(rendererSeesBonesFor(useDagStore.getState().state.nodes, ASSET)).toEqual([]);
  });

  it('does NOT touch a second character in the same scene', () => {
    useDagStore.getState().hydrate(buildTwoCharacterScene());
    dispatchClearBakedMotion({ assetRef: ASSET });

    const after = useDagStore.getState().state;
    expect(rendererSeesBonesFor(after.nodes, OTHER)).toEqual(BONES);
    for (const bone of BONES) {
      expect(after.nodes[gltfChannelDagId(OTHER, bone, 'position')]).toBeDefined();
    }
  });

  it("one undo restores the whole character's motion", () => {
    useDagStore.getState().hydrate(buildTwoCharacterScene());
    dispatchClearBakedMotion({ assetRef: ASSET });
    expect(rendererSeesBonesFor(useDagStore.getState().state.nodes, ASSET)).toEqual([]);

    useDagStore.getState().undo();
    expect(rendererSeesBonesFor(useDagStore.getState().state.nodes, ASSET)).toEqual(BONES);
  });

  it('a character with nothing baked is "already clear" — ok, and no undo entry', () => {
    let s = buildDefaultDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_gltf_a',
      nodeType: 'GltfAsset',
      params: { assetRef: ASSET, nodeNameMap: nameMapFor(ASSET) },
    }).next;
    useDagStore.getState().hydrate(s);

    expect(dispatchClearBakedMotion({ assetRef: ASSET })).toEqual({ ok: true });
    expect(useDagStore.getState().undoStack).toHaveLength(0);
  });

  it('an assetRef no asset carries is a REFUSAL, never a quiet success', () => {
    useDagStore.getState().hydrate(buildTwoCharacterScene());
    const res = dispatchClearBakedMotion({ assetRef: 'not-in-this-scene' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('not-in-this-scene');
  });
});

describe('bakedChannelIdsForAssetRef', () => {
  it('distinguishes "already clear" (empty) from "cannot tell" (null)', () => {
    const s = buildTwoCharacterScene();
    expect(bakedChannelIdsForAssetRef(s.nodes, ASSET)).toHaveLength(BONES.length * 2);
    // No asset carries this ref → null, NOT [].
    expect(bakedChannelIdsForAssetRef(s.nodes, 'nobody')).toBeNull();
  });

  it('returns ids in a stable sorted order (V22 — the undo op set is deterministic)', () => {
    const s = buildTwoCharacterScene();
    const ids = bakedChannelIdsForAssetRef(s.nodes, ASSET)!;
    expect([...ids].sort()).toEqual(ids);
  });
});
