// lightBrush — the Light Brush decision layer (#207). Asserts: only a selected rig
// light is brushable; the brushed op preserves the light's radius (same shell as a
// panel drag); a non-rig / no selection → null.
//
// REF: src/app/lightBrush.ts; src/app/studioLightRig.ts; vyapti V62.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildLightBrushOp } from './lightBrush';
import { makeSplitLight } from '../test-utils/splitLight';

type Vec3 = [number, number, number];

function addRigLight(state: DagState, id: string, pos: Vec3): DagState {
  // A split area light: an Object at `pos` posing an Area LightData. `isAreaLightNode`
  // reaches through `data` to recognise it (studioLightRig.ts:57), so the brush is being
  // asked the question it faces in a real project.
  let next = makeSplitLight(state, { objectId: id, lightKind: 'Area', position: pos }).state;
  next = applyOp(next, {
    type: 'addNode',
    nodeId: `${id}_tt`,
    nodeType: 'TrackTo',
    params: { target: id, aimNode: '', aimPoint: [0, 0, 0], up: [0, 1, 0], mute: false },
  }).next;
  return next;
}

describe('buildLightBrushOp', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it('paints the selected rig light onto its own shell (radius preserved)', () => {
    // A rig light at distance 5 from the origin centre.
    const state = addRigLight(buildDefaultDagState(), 'n_rig', [5, 0, 0]);
    // Brush a hit on top of the subject; normal +Y, camera looking down.
    const op = buildLightBrushOp(state, 0, 'n_rig', [0, 1, 0], [0, 1, 0], [0, -1, 0], 'reflect');
    expect(op).not.toBeNull();
    expect(op!.type).toBe('setParam');
    const pos = (op as { value: Vec3 }).value;
    // The new position is on the radius-5 shell around the origin.
    expect(Math.hypot(...pos)).toBeCloseTo(5, 4);
  });

  it('returns null when nothing is selected', () => {
    const state = addRigLight(buildDefaultDagState(), 'n_rig', [5, 0, 0]);
    expect(
      buildLightBrushOp(state, 0, null, [0, 1, 0], [0, 1, 0], [0, -1, 0], 'reflect'),
    ).toBeNull();
  });

  it('returns null when the selection is not a rig light', () => {
    const state = addRigLight(buildDefaultDagState(), 'n_rig', [5, 0, 0]);
    // The scene's default cube is selectable but not a rig light.
    expect(
      buildLightBrushOp(state, 0, 'n_box', [0, 1, 0], [0, 1, 0], [0, -1, 0], 'reflect'),
    ).toBeNull();
  });
});
