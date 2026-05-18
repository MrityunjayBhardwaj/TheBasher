// C1 unit tests — paramAnimationState pure helper.
//
// Covers the three states + the frame-boundary case (kf at t=1.0s →
// currentFrame 60 = 'on-key', 61 = 'animated'). The seconds↔frame
// conversion is exercised in isolation, no store, no React (D-W9-4
// pure-geometry discipline).

import { describe, expect, it } from 'vitest';
import { paramAnimationState } from './paramAnimationState';
import type { DagState } from '../../core/dag/state';

function stateWith(
  channel?: { target: string; paramPath: string; keyframes: { time: number }[] },
): DagState {
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
});
