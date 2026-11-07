// #1813 — every door reads a constrained object through its chain.
//
// Where the object ends up has one answer, the object's `world` output. The aim maths that gives it
// runs in one place, the chain's step fold. A file that calls that maths itself is working a pose out
// a second way, which is how three past bugs came about (a reader and the drawing disagreeing about
// whether a transform was before or after the constraint). A new caller reds here: read
// `resolveConstraintRotation` or the object's world instead, or add it below with its reason.
//
// The predicate, stated so a reader can check what this sees: a non-test file under `src/` whose code
// with comments removed calls `trackToQuaternion(` or `resolveTrackTo(`, or reads a step's aim
// inputs by building one with `aimTargetWorld`.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

const AIM_MATHS = /\b(trackToQuaternion|resolveTrackTo)\(/;

const ALLOWED: Record<string, string> = {
  'src/app/constraintChain.ts': 'the step fold itself',
  'src/app/resolveTrackTo.ts': 'where the maths is defined',
  'src/core/project/migrations.ts': 'old files: bakes an aim into a rotation at conversion',
};

/** The doors #1813 names, each with the read that proves it is on the chain. */
const DOORS: Record<string, RegExp> = {
  'src/viewport/SceneFromDAG.tsx': /resolveConstraintRotation\(|chainDrawCorrection\(/, // renderer
  'src/app/activeCamera.ts': /cameraLocalOrientation/, // camera pose, focus and reticle
  'src/app/resolveEvaluatedTransform.ts': /resolveConstraintRotation\(/, // inspector rows, I key
  'src/app/Gizmo.tsx': /resolveEvaluatedTransform\(|resolveFollowedWorldPosition\(/, // all gizmos
  'src/viewport/BoxSelectController.tsx': /resolveFollowedWorldPosition\(/, // box select
  'src/app/studioLightRig.ts': /resolveTrackToTarget\(/, // the light rig's centre
  'src/app/animate/keyCamera.ts': /resolveActiveTrackTo\(/, // the I key on a camera
  'src/agent/mutators/builders/constrain.ts': /buildAddConstraintOps\(/, // the agent, one road
  'src/agent/mutators/builders/cameraTrajectory.ts': /liveConstraintOfType\(/,
};

describe('#1813 — the doors read the chain', () => {
  const code = new Map(
    sourceFiles()
      .filter(([path]) => !/\/tmp-/.test(path))
      .map(([path, src]) => [path, stripComments(src)]),
  );

  it('the aim maths runs only where it is listed', () => {
    const found = [...code]
      .filter(([, src]) => AIM_MATHS.test(src))
      .map(([path]) => path)
      .sort();
    expect(found).toEqual(Object.keys(ALLOWED).sort());
  });

  it('each door still takes the read that puts it on the chain', () => {
    for (const [path, read] of Object.entries(DOORS)) {
      expect(read.test(code.get(path) ?? ''), path).toBe(true);
    }
  });

  it("the resolvers those doors read take the object's world, not a fold of their own", () => {
    const resolvers = code.get('src/app/nodeConstraints.ts') ?? '';
    expect(resolvers).toMatch(/socket: 'world'/);
    expect(AIM_MATHS.test(resolvers)).toBe(false);
  });
});
