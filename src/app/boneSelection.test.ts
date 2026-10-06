import { describe, expect, it } from 'vitest';
import { activeBone } from './boneSelection';

const SEL = { nodeId: 'char', boneName: 'LeftShin', chain: ['Hips', 'LeftLeg', 'LeftShin'] };

describe('is there a live bone selection?', () => {
  it('yes, while the rig it belongs to is the primary selection', () => {
    const live = activeBone('char', SEL, 'pose');
    expect(live?.boneName).toBe('LeftShin');
    expect(live?.chain).toEqual(['Hips', 'LeftLeg', 'LeftShin']);
  });

  it('no, once the director selects something else', () => {
    // The highlight and the inspector both read this, and a bone highlighted on
    // a rig the director has navigated away from is worse than none: it answers
    // the question with the wrong object rather than with silence.
    expect(activeBone('cube', SEL, 'pose')).toBeNull();
    expect(activeBone(null, SEL, 'pose')).toBeNull();
  });

  it('no, when nothing has been clicked', () => {
    expect(activeBone('char', { nodeId: null, boneName: null, chain: [] }, 'pose')).toBeNull();
    // A node id with no bone is the state after a clear; it must not read as a
    // selection of whatever bone happens to be first.
    expect(activeBone('char', { nodeId: 'char', boneName: null, chain: [] }, 'pose')).toBeNull();
  });

  it('no, in object mode, and the bone comes back on re-entering a mode (#1335)', () => {
    // In object mode the armature is one thing; the stored bone is kept for the next pose.
    expect(activeBone('char', SEL, 'object')).toBeNull();
    expect(activeBone('char', SEL, 'edit')?.boneName).toBe('LeftShin');
  });
});
