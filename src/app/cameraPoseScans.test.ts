// #1757 — every camera's pose is resolved every frame, and each `overlayCameraChannels` call scans
// the node table for the camera's channels, strips and drivers. #1760 briefly made that two calls
// per resolve (the pose, then the Object's own rotation). One resolve scans once, and the one scan
// still carries a keyed rotation.

import { beforeAll, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('./cameraChannels', async (importOriginal) => {
  const real = await importOriginal<typeof import('./cameraChannels')>();
  return {
    ...real,
    overlayCameraChannels: ((...args: Parameters<typeof real.overlayCameraChannels>) => {
      calls.n++;
      return real.overlayCameraChannels(...args);
    }) as typeof real.overlayCameraChannels,
  };
});

import { applyOp } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { resolveCameraPoseAt } from './activeCamera';

beforeAll(() => registerAllNodes());

describe('#1757 — a camera pose resolve scans for the camera’s channels once', () => {
  it('one resolve, one scan, and a keyed rotation still turns the camera', () => {
    const s = applyOp(buildDefaultDagState(), {
      type: 'addNode',
      nodeId: 'rot',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'rotation',
        target: 'n_camera',
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [0, 90, 0], easing: 'linear' },
          { time: 1, value: [0, 90, 0], easing: 'linear' },
        ],
      },
    }).next;
    calls.n = 0;
    const pose = resolveCameraPoseAt(s, 'n_camera', 0.5);
    expect(calls.n).toBe(1);
    // Turned 90° about +Y by the key, read through that one scan.
    expect(pose.quaternion[1]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(pose.quaternion[3]).toBeCloseTo(Math.SQRT1_2, 9);
  });
});
