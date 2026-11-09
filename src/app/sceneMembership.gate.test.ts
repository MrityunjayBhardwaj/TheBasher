// #1821 — no new surface walks scene membership itself.
//
// "Is this object in the scene?" has one answer, `isInScene` / `sceneMembersOf`
// (`sceneMembership.ts`). A file that starts at the scene output and reads the scene's
// membership sockets off the node table is either answering that question again, or doing
// something else with those wires (writing them, pairing a wire with the value it produced,
// picking the active camera). This census lists every such file today with what it does. A new
// file fails here: answer membership with `isInScene`, or add it below with its reason.
//
// The predicate, stated so a reader can check what this sees: a non-test file under `src/`,
// outside `src/nodes/` (a node's `evaluate` reads its own resolved inputs, not the node table),
// whose code with comments removed both names the scene output (`outputs.scene`) and reads one of
// the membership or parenting sockets off an `inputs` record by name.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

const SCENE_OUTPUT = /outputs(\?)?\.scene\b|outputs\[['"]scene['"]\]/;
const MEMBERSHIP_READ =
  /inputs(\?)?\.(children|lights|lightRig|collections|camera|members|rigs|cameras)\b|inputs\[['"](children|lights|lightRig|collections|camera|members|rigs|cameras)['"]\]/;

/** Every file that reads the scene's membership wires, and what it does with them. */
const CENSUS: Record<string, string> = {
  // Shape, not membership: the outliner's tree. `sceneMembership.test.ts` checks its rows agree.
  'src/app/sceneTreeWalk.ts': 'the outliner tree; rows checked against isInScene',
  'src/app/collections.ts': "a collection's own sockets (its members, nested collections)",
  'src/app/selectableNodes.ts': 'box-select: the top-level band only; checked to stay inside',
  // The answer itself, and what the scene draws (#1823): the one walk this census protects.
  'src/app/sceneMembership.ts': 'the answer, and what the scene draws (sceneDrawOf)',
  // Pairing a wire with the value it produced. The scene's children come from `sceneChildRefs`
  // since #1823; these read the other sockets.
  'src/app/resolveWorldTransform.ts':
    "whether the render draws the output scene; the Scene type's input",
  'src/viewport/SceneFromDAG.tsx': 'pairs scene lights with what it draws',
  // A move between parents: a membership wire is not a parent, so it is left as it is (#1823).
  'src/app/keepPlaceReparent.ts': "tells a scene list or collection's members from a parent edge",
  // The active camera and the lighting profile: which one, not whether.
  'src/app/activeCamera.ts': 'which camera is active',
  'src/app/shots.ts': 'which camera is active',
  'src/app/resolveRigLightSources.ts': 'which lighting profile is active',
  'src/app/studioProfiles.ts': 'finds the profile select to write to',
  'src/app/studioProfileIO.ts': "reads a rig's lights to save a profile",
  // Writers: they wire into these sockets.
  'src/app/setActiveCamera.ts': 'writes the scene camera',
  'src/app/character/cameraFromView.ts': 'writes the scene camera',
  'src/agent/tools/cameraSnapshot.ts': 'writes the scene camera',
  'src/core/project/migrations.ts': 'converts old files',
  'src/app/sceneNodeActions.ts':
    "Duplicate: a copy joins the scene's own list where its original is (#1823)",
  'src/core/project/repairFloatingCameras.ts': 'wires a camera an old Add left floating, on load',
};

function readers(): string[] {
  return sourceFiles()
    .filter(([path]) => !path.startsWith('src/nodes/') && !/\/tmp-/.test(path))
    .filter(([, src]) => {
      const code = stripComments(src);
      return SCENE_OUTPUT.test(code) && MEMBERSHIP_READ.test(code);
    })
    .map(([path]) => path)
    .sort();
}

describe('#1821 — one walk answers scene membership', () => {
  it('every file reading the scene membership wires is in the census, and only those', () => {
    expect(readers()).toEqual(Object.keys(CENSUS).sort());
  });

  it('the predicate sees a reader (positive control)', () => {
    const code = 'const s = state.outputs.scene; const kids = node.inputs.children;';
    expect(SCENE_OUTPUT.test(code) && MEMBERSHIP_READ.test(code)).toBe(true);
    // And not a node that reads only its own evaluated inputs.
    expect(SCENE_OUTPUT.test('return inputs.children;')).toBe(false);
  });
});
