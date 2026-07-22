// C1 unit tests — paramAnimationState pure helper.
//
// Covers the three states + the frame-boundary case (kf at t=1.0s →
// currentFrame 60 = 'on-key', 61 = 'animated'). The seconds↔frame
// conversion is exercised in isolation, no store, no React (D-W9-4
// pure-geometry discipline).

import { beforeAll, describe, expect, it } from 'vitest';
import { isKeyframeChannelNode, paramAnimationState } from './paramAnimationState';
import type { DagState } from '../../core/dag/state';
import { listNodeTypes } from '../../core/dag/registry';
import { registerAllNodes } from '../../nodes/registerAll';
import { KeyframeChannelNumberNode } from '../../nodes/KeyframeChannelNumber';
import { KeyframeChannelVec2Node } from '../../nodes/KeyframeChannelVec2';
import { KeyframeChannelVec3Node } from '../../nodes/KeyframeChannelVec3';
import { KeyframeChannelQuatNode } from '../../nodes/KeyframeChannelQuat';
import { KeyframeChannelColorNode } from '../../nodes/KeyframeChannelColor';
import { KeyframeChannelTextNode } from '../../nodes/KeyframeChannelText';
import { KeyframeChannelImageNode } from '../../nodes/KeyframeChannelImage';

function stateWith(channel?: {
  target: string;
  paramPath: string;
  keyframes: { time: number }[];
}): DagState {
  const nodes: DagState['nodes'] = {
    n_box: { id: 'n_box', type: 'BoxMesh', version: 1, params: {} },
  };
  if (channel) {
    nodes.n_chan = {
      id: 'n_chan',
      type: 'KeyframeChannelVec3',
      version: 1,
      params: {
        target: channel.target,
        paramPath: channel.paramPath,
        keyframes: channel.keyframes,
      },
    };
  }
  return { nodes, outputs: {} };
}

describe('paramAnimationState', () => {
  it("returns 'none' when no channel targets the (nodeId, paramPath)", () => {
    const s = stateWith();
    expect(paramAnimationState(s, 'n_box', 'rotation', 0)).toBe('none');
  });

  it("returns 'none' when a channel exists but targets a different param", () => {
    const s = stateWith({
      target: 'n_box',
      paramPath: 'position',
      keyframes: [{ time: 0 }],
    });
    expect(paramAnimationState(s, 'n_box', 'rotation', 0)).toBe('none');
  });

  it("returns 'none' when a channel exists but targets a different node", () => {
    const s = stateWith({
      target: 'n_other',
      paramPath: 'rotation',
      keyframes: [{ time: 0 }],
    });
    expect(paramAnimationState(s, 'n_box', 'rotation', 0)).toBe('none');
  });

  it("returns 'animated' when a channel exists but the current frame is not a key", () => {
    const s = stateWith({
      target: 'n_box',
      paramPath: 'rotation',
      keyframes: [{ time: 0 }, { time: 2 }],
    });
    // frame 30 = 0.5s — no kf there.
    expect(paramAnimationState(s, 'n_box', 'rotation', 30)).toBe('animated');
  });

  it("returns 'animated' when the channel exists with zero keyframes", () => {
    const s = stateWith({
      target: 'n_box',
      paramPath: 'rotation',
      keyframes: [],
    });
    expect(paramAnimationState(s, 'n_box', 'rotation', 0)).toBe('animated');
  });

  it("returns 'on-key' when the current frame is a frame-rounded key (t=0)", () => {
    const s = stateWith({
      target: 'n_box',
      paramPath: 'rotation',
      keyframes: [{ time: 0 }, { time: 2 }],
    });
    expect(paramAnimationState(s, 'n_box', 'rotation', 0)).toBe('on-key');
    // t=2s → frame 120.
    expect(paramAnimationState(s, 'n_box', 'rotation', 120)).toBe('on-key');
  });

  // The decided on-key rule: Math.round(kf.time * 60) === currentFrame.
  describe('frame-boundary (kf at t=1.0s, FRAMES_PER_SECOND=60)', () => {
    const s = stateWith({
      target: 'n_box',
      paramPath: 'rotation',
      keyframes: [{ time: 1.0 }],
    });

    it("currentFrame 60 → 'on-key'", () => {
      expect(paramAnimationState(s, 'n_box', 'rotation', 60)).toBe('on-key');
    });

    it("currentFrame 61 → 'animated' (off by one frame)", () => {
      expect(paramAnimationState(s, 'n_box', 'rotation', 61)).toBe('animated');
    });

    it("currentFrame 59 → 'animated' (off by one frame, other side)", () => {
      expect(paramAnimationState(s, 'n_box', 'rotation', 59)).toBe('animated');
    });
  });

  // Frame-rounded equality: a key at a non-grid-aligned second still
  // matches its nearest 60fps frame, no float epsilon needed.
  it('rounds a non-grid-aligned keyframe time to its nearest frame', () => {
    // 0.509s → 0.509 * 60 = 30.54 → Math.round = 31.
    const s = stateWith({
      target: 'n_box',
      paramPath: 'position',
      keyframes: [{ time: 0.509 }],
    });
    expect(paramAnimationState(s, 'n_box', 'position', 31)).toBe('on-key');
    expect(paramAnimationState(s, 'n_box', 'position', 30)).toBe('animated');
  });

  // P7.1 / D-05 goal-backward proof: a SUB-FRAME-retimed key (the
  // Task 3/6 retime target t=1.3333, NOT on any 60fps grid line —
  // 1.3333*60 = 79.998) still reads 'on-key' at its NEAREST playhead
  // frame thanks to the ±½-frame tolerance, and 'animated' two frames
  // away. Without D-05 mechanism (b) this would be 'animated' at EVERY
  // integer frame — the silently-broken P7 diamond D-05 exists to fix.
  describe('D-05 ±½-frame tolerance (sub-frame-retimed key)', () => {
    const s = stateWith({
      target: 'n_box',
      paramPath: 'rotation',
      keyframes: [{ time: 1.3333 }],
    });

    it("frame 80 (1.33333s, Δ≈3.3e-6 ≤ ½-frame) → 'on-key'", () => {
      expect(paramAnimationState(s, 'n_box', 'rotation', 80)).toBe('on-key');
    });

    it("frame 82 (1.36667s, Δ≈0.0333 > ½-frame) → 'animated'", () => {
      expect(paramAnimationState(s, 'n_box', 'rotation', 82)).toBe('animated');
    });

    it("frame 78 (1.3s, Δ≈0.0333 > ½-frame) → 'animated' (other side)", () => {
      expect(paramAnimationState(s, 'n_box', 'rotation', 78)).toBe('animated');
    });
  });
});

// isKeyframeChannelNode — the ONE home for "is this a channel node?" (#419).
// The prefix match is load-bearing: it is correct ONLY if every authored channel
// type is named KeyframeChannel* AND no OTHER registered type shares that prefix.
// That naming assumption used to be un-testable (written out at ~16 call sites);
// consolidated here, it is checkable in one place by walking the whole registry.
describe('isKeyframeChannelNode (#419)', () => {
  beforeAll(() => {
    registerAllNodes();
  });

  // The canonical authored-channel set, built INDEPENDENTLY of the prefix match:
  // the seven KeyframeChannel*Node definitions registered in registerAll. Membership
  // below is by exact string equality (a Set), not a prefix — so the soundness sweep
  // is a genuine cross-check, not a tautology of the implementation.
  const CHANNEL_TYPES = [
    KeyframeChannelNumberNode,
    KeyframeChannelVec2Node,
    KeyframeChannelVec3Node,
    KeyframeChannelQuatNode,
    KeyframeChannelColorNode,
    KeyframeChannelTextNode,
    KeyframeChannelImageNode,
  ].map((d) => d.type);

  it('classifies every authored channel node as a channel (completeness)', () => {
    for (const type of CHANNEL_TYPES) {
      expect(isKeyframeChannelNode({ type })).toBe(true);
    }
    // Guards against a channel type being added without updating this list — the
    // soundness sweep below would then flag it (helper true, set membership false).
    expect(CHANNEL_TYPES).toHaveLength(7);
  });

  it('classifies no other registered node as a channel (soundness — the naming assumption)', () => {
    const channelSet = new Set(CHANNEL_TYPES);
    // Registry-walking ([[V109]] pattern): for EVERY registered type the helper's
    // verdict must equal exact membership in the authored set. A non-channel named
    // KeyframeChannel* → helper true, set false → red. A channel renamed off-prefix →
    // helper false, set true → red.
    for (const type of listNodeTypes()) {
      expect(isKeyframeChannelNode({ type })).toBe(channelSet.has(type));
    }
  });

  it('CONTROL — a ParamDriver yields a channel VALUE but is NOT a channel NODE', () => {
    // ParamDriver.evaluate returns a kind:'KeyframeChannel' value, yet its type is
    // 'ParamDriver' (no prefix) — drivers ride a SEPARATE fold path. The helper is
    // NAME-scoped, not value-scoped. If this flips, the helper's contract silently
    // changed (and every one of the ~16 sites would start counting drivers).
    expect(isKeyframeChannelNode({ type: 'ParamDriver' })).toBe(false);
    // And a plainly non-channel node stays false.
    expect(isKeyframeChannelNode({ type: 'BoxMesh' })).toBe(false);
  });

  it('is false for an absent node (undefined)', () => {
    expect(isKeyframeChannelNode(undefined)).toBe(false);
  });
});
