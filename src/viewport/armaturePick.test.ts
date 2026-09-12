import { describe, expect, it } from 'vitest';
import {
  pickBone,
  ownerNodeId,
  assetIdsFor,
  bonesPickable,
  type PickAncestor,
  type PickNode,
  type PickableBone,
} from './armaturePick';

/** Two armatures in one flat array, the way the fill loop writes them. */
const RIG_A: PickableBone[] = [
  { name: 'Hips', parent: -1 },
  { name: 'LeftUpLeg', parent: 0 },
  { name: 'LeftLeg', parent: 1 },
  { name: 'LeftFoot', parent: 2 },
];
const RIG_B: PickableBone[] = [
  { name: 'root', parent: -1 },
  { name: 'spine', parent: 0 },
];
const FRAMES = [...RIG_A, ...RIG_B];
const OFFSETS = [0, RIG_A.length];

describe('instance id → bone', () => {
  it('names the bone and the chain that gives the name meaning', () => {
    const hit = pickBone(3, OFFSETS, FRAMES);
    expect(hit?.name).toBe('LeftFoot');
    expect(hit?.armature).toBe(0);
    expect(hit?.index).toBe(3);
    expect(hit?.chain).toEqual(['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot']);
  });

  it('keeps the two armatures apart, which is the whole reason offsets exist', () => {
    const hit = pickBone(5, OFFSETS, FRAMES);
    expect(hit?.armature).toBe(1);
    // Index and chain are LOCAL to the second rig — a parent index of 0 there
    // means `root`, not `Hips`. Reading it against the flat array would name a
    // bone from the other character.
    expect(hit?.index).toBe(1);
    expect(hit?.chain).toEqual(['root', 'spine']);
  });

  it('answers null outside the drawn range instead of a neighbouring bone', () => {
    // `mesh.count` can be below the array length for a frame after a rig is
    // removed, and an id from a stale raycast then lands past the end.
    expect(pickBone(FRAMES.length, OFFSETS, FRAMES)).toBeNull();
    expect(pickBone(-1, OFFSETS, FRAMES)).toBeNull();
    expect(pickBone(1.5, OFFSETS, FRAMES)).toBeNull();
    expect(pickBone(0, [], FRAMES)).toBeNull();
  });

  it('does not hang on a parent cycle', () => {
    // The frames come from walking a live scene, not from a schema that forbids
    // a cycle, and a click handler that never returns takes the whole app with
    // it. Cheaper to guard than to prove impossible.
    const looped: PickableBone[] = [
      { name: 'a', parent: 1 },
      { name: 'b', parent: 0 },
    ];
    const hit = pickBone(1, [0], looped);
    expect(hit?.name).toBe('b');
    expect(hit?.chain.length).toBeLessThanOrEqual(2);
  });
});

describe('bone → the node that produced it', () => {
  const chainOf = (names: readonly string[]): PickAncestor => {
    let node: PickAncestor | null = null;
    for (const name of names) node = { name, parent: node };
    return node as PickAncestor;
  };

  it('finds the wrapping group SceneFromDAG named with its node id', () => {
    // scene → group(node id) → armature root → the bone
    const from = chainOf(['Scene', 'n_char_1', 'Armature', 'Hips']);
    expect(ownerNodeId(from, (n) => n === 'n_char_1')).toBe('n_char_1');
  });

  it('walks PAST names the file supplied, rather than taking the first one', () => {
    // An imported glTF is full of named groups. Taking the nearest named
    // ancestor would select whatever the exporter happened to call the rig.
    const from = chainOf(['Scene', 'n_char_1', 'ArmatureRoot', 'mixamorig:Hips']);
    const seen: string[] = [];
    const id = ownerNodeId(from, (n) => {
      seen.push(n);
      return n === 'n_char_1';
    });
    expect(id).toBe('n_char_1');
    expect(seen[0]).toBe('mixamorig:Hips');
  });

  it('answers null for a rig no node produced, so the click falls through', () => {
    const from = chainOf(['Scene', 'Armature', 'Hips']);
    expect(ownerNodeId(from, () => false)).toBeNull();
    expect(ownerNodeId(null, () => true)).toBeNull();
  });

  it('does not hang on a parent cycle in the scene graph either', () => {
    const a = { name: 'a' } as { name: string; parent: PickAncestor | null };
    const b = { name: 'b', parent: a } as { name: string; parent: PickAncestor | null };
    a.parent = b;
    expect(ownerNodeId(b, () => false)).toBeNull();
  });
});

describe("which selections make an armature's bones clickable", () => {
  /** The shape a glTF import actually produces, measured in #973:
   *
   *      group("n_char")                     ← named with the producer's node id
   *        ├─ Object3D("Armature") → Hips…    ← the bones
   *        └─ mesh (userData.basherGltfChildId = "n_gltfChild_1")
   *
   *  Clicking the body selects `n_gltfChild_1`, which is the armature's SIBLING
   *  and is not named with its id — two separate reasons the naive gate failed.
   */
  function characterScene() {
    const root: PickNode & { children: PickNode[] } = {
      name: 'n_char',
      parent: null,
      children: [],
    };
    const armature: PickNode & { children: PickNode[] } = {
      name: 'Armature',
      parent: root,
      children: [],
    };
    const hips: PickNode = { name: 'mixamorigHips', parent: armature, children: [] };
    (armature.children as PickNode[]).push(hips);
    const skin: PickNode = {
      name: 'Beta_Surface',
      parent: root,
      children: [],
      userData: { basherGltfChildId: 'n_gltfChild_1' },
    };
    root.children.push(armature, skin);
    return { root, hips };
  }

  const isNodeId = (n: string) => n === 'n_char';

  it('collects the asset id, and the drilled child ids that share it', () => {
    const { hips } = characterScene();
    const ids = assetIdsFor(hips, isNodeId);
    expect([...ids].sort()).toEqual(['n_char', 'n_gltfChild_1']);
  });

  it("opens for a click on the character's own mesh part", () => {
    const { hips } = characterScene();
    const ids = assetIdsFor(hips, isNodeId);
    // This is the case that was measured failing: the body was selected and the
    // bones stayed unclickable.
    expect(bonesPickable(ids, 'n_gltfChild_1')).toBe(true);
    expect(bonesPickable(ids, 'n_char')).toBe(true);
  });

  it('stays shut for another object, and for no selection at all', () => {
    const { hips } = characterScene();
    const ids = assetIdsFor(hips, isNodeId);
    expect(bonesPickable(ids, 'n_cube')).toBe(false);
    expect(bonesPickable(ids, null)).toBe(false);
    // Nothing selected is the state on load; bones must not take clicks then,
    // or selecting the character in the first place becomes impossible on any
    // pixel over a bone.
    expect(bonesPickable(new Set(), 'n_char')).toBe(false);
  });

  it('gives an armature no ids when nothing in the graph produced it', () => {
    const loose: PickNode = { name: 'Hips', parent: null, children: [] };
    expect(assetIdsFor(loose, isNodeId).size).toBe(0);
    expect(bonesPickable(assetIdsFor(loose, isNodeId), 'n_char')).toBe(false);
  });

  it('does not hang on a cycle, up or down', () => {
    const a = { name: 'n_char', parent: null, children: [] } as PickNode & {
      parent: PickNode | null;
      children: PickNode[];
    };
    const b = { name: 'x', parent: a, children: [a] } as PickNode & { children: PickNode[] };
    a.children.push(b);
    a.parent = b;
    expect(assetIdsFor(b, isNodeId).has('n_char')).toBe(true);
  });
});
