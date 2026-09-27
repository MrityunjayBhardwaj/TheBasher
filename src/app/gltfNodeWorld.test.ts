// #1284 — a bone's posed world position, pure, and Track-To aiming at it.
//
// The expected positions are the RENDERED ones: read off the drawn skeleton's bones in the
// browser on the "Camera Path + AI Walk" example (re-read 2026-09-27 for #1285's 10 s walk, whose
// path is asked for in the generator's metres), at the same times. The walk moves
// the Hips while the armature Root and the character's Group stay where the walk began — which is
// why aiming at the character is not aiming at the walker.

import { describe, expect, it } from 'vitest';
import { registerAllNodes } from '../nodes/registerAll';
import { buildExampleProject } from '../core/project/examples';
import { applyOp, type DagState } from '../core/dag';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { characterAssetOf, characterNodeNames } from './characterParts';
import { gltfNodeWorldPosition } from './gltfNodeWorld';
import { resolveTrackToTarget } from './nodeConstraints';

registerAllNodes();

const at = (seconds: number) => ({
  time: { frame: Math.round(seconds * 30), seconds, normalized: 0 },
});
const near = (got: readonly number[] | null, want: readonly number[], tol = 0.01) => {
  expect(got, `expected ${JSON.stringify(want)}`).not.toBeNull();
  for (let i = 0; i < 3; i++) expect(Math.abs(got![i] - want[i])).toBeLessThan(tol);
};

async function example() {
  const state = (await buildExampleProject('example_camera_path_ai_walk')).state;
  const group = Object.values(state.nodes).find((n) => n.type === 'Group')!.id;
  const trackTo = Object.values(state.nodes).find((n) => n.type === 'TrackTo')!.id;
  return { state, group, trackTo };
}

describe('a glTF node inside a character, posed, in the world (#1284)', () => {
  it('the Hips travel with the walk while the Root holds — as drawn', async () => {
    const { state, group } = await example();
    const drawnHips: Record<number, [number, number, number]> = {
      0: [-2.019, 0.604, -1.99],
      2: [-1.421, 0.601, -0.118],
      7.5: [1.349, 0.603, 0.261],
    };
    for (const [t, want] of Object.entries(drawnHips)) {
      const cache = createEvaluatorCache();
      near(gltfNodeWorldPosition(state, group, 'mixamorig_Hips', at(+t), cache), want);
      near(gltfNodeWorldPosition(state, group, 'Root', at(+t), cache), [-2, 0, -2]);
    }
  });

  it('answers null, never a guess, for no character or no such part', async () => {
    const { state, group } = await example();
    expect(gltfNodeWorldPosition(state, group, 'no_such_bone', at(1))).toBeNull();
    expect(gltfNodeWorldPosition(state, 'n_light', 'mixamorig_Hips', at(1))).toBeNull();
    expect(characterAssetOf(state, 'n_light')).toBeNull();
  });

  it('lists the parts of the character a Group or its asset stands for', async () => {
    const { state, group } = await example();
    const names = characterNodeNames(state, group);
    expect(names).toContain('mixamorig_Hips');
    expect(names).toContain('Root');
    expect(characterNodeNames(state, characterAssetOf(state, group)!)).toEqual(names);
  });
});

describe('Track-To aims at a bone when asked (#1284)', () => {
  const withAimBone = (state: DagState, trackTo: string, value: string) =>
    applyOp(state, { type: 'setParam', nodeId: trackTo, paramPath: 'aimBone', value }).next;

  it('aimBone empty: the aim is the character object, as before', async () => {
    const { state, trackTo } = await example();
    near(resolveTrackToTarget(withAimBone(state, trackTo, ''), 'n_camera', at(1)), [-2, 0, -2]);
  });

  it('aimBone = Hips: the aim follows the walking Hips', async () => {
    const { state, trackTo } = await example();
    // The example ships aiming at the Hips; set it anyway so this row does not lean on that.
    const s = withAimBone(state, trackTo, 'mixamorig_Hips');
    near(resolveTrackToTarget(s, 'n_camera', at(0)), [-2.019, 0.604, -1.99]);
    near(resolveTrackToTarget(s, 'n_camera', at(7.5)), [1.349, 0.603, 0.261]);
  });

  it('an unresolvable bone falls back to the object, never to a blank aim', async () => {
    const { state, trackTo } = await example();
    const s = withAimBone(state, trackTo, 'no_such_bone');
    near(resolveTrackToTarget(s, 'n_camera', at(1)), [-2, 0, -2]);
  });
});
