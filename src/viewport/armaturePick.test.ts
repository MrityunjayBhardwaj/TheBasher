import { describe, expect, it } from 'vitest';
import { pickBone, type PickableBone } from './armaturePick';

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
