// Tests for timelineSelection — activeChannelId + activeKeyframeId
// (P6 W6 — extended for keyframe-level selection).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useTimelineSelection } from './timelineSelection';

describe('timelineSelection', () => {
  beforeEach(() => {
    useTimelineSelection.setState({ activeChannelId: null, activeKeyframeId: null });
  });

  afterEach(() => {
    useTimelineSelection.setState({ activeChannelId: null, activeKeyframeId: null });
  });

  it('defaults to both selections null', () => {
    const s = useTimelineSelection.getState();
    expect(s.activeChannelId).toBeNull();
    expect(s.activeKeyframeId).toBeNull();
  });

  it('setActiveChannel updates the channel pointer', () => {
    useTimelineSelection.getState().setActiveChannel('ch1');
    expect(useTimelineSelection.getState().activeChannelId).toBe('ch1');
  });

  it('setActiveKeyframe stores the (channelId, time) compound key', () => {
    useTimelineSelection.getState().setActiveKeyframe({ channelId: 'ch1', time: 0.5 });
    expect(useTimelineSelection.getState().activeKeyframeId).toEqual({
      channelId: 'ch1',
      time: 0.5,
    });
  });

  it('setActiveKeyframe(null) clears the pointer', () => {
    useTimelineSelection.getState().setActiveKeyframe({ channelId: 'ch1', time: 0 });
    useTimelineSelection.getState().setActiveKeyframe(null);
    expect(useTimelineSelection.getState().activeKeyframeId).toBeNull();
  });

  it('switching channels clears the keyframe pointer', () => {
    useTimelineSelection.getState().setActiveChannel('ch1');
    useTimelineSelection.getState().setActiveKeyframe({ channelId: 'ch1', time: 0.5 });
    useTimelineSelection.getState().setActiveChannel('ch2');
    expect(useTimelineSelection.getState().activeChannelId).toBe('ch2');
    expect(useTimelineSelection.getState().activeKeyframeId).toBeNull();
  });

  it('re-selecting the same channel preserves the keyframe pointer', () => {
    useTimelineSelection.getState().setActiveChannel('ch1');
    useTimelineSelection.getState().setActiveKeyframe({ channelId: 'ch1', time: 0.5 });
    useTimelineSelection.getState().setActiveChannel('ch1');
    expect(useTimelineSelection.getState().activeKeyframeId).toEqual({
      channelId: 'ch1',
      time: 0.5,
    });
  });
});
