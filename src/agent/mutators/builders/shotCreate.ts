// shotCreate Mutator — a shot is a stretch of the film on one camera, written as cuts (#1666).
//
// Spec: { cameraId, startTime, endTime? }. There is no shot record: a cut is a key on the camera
// switch's `active` (`CameraSelect`), and the Shots panel, the viewport and the render all read
// those keys (`src/app/shots.ts`). So this writes what the panel writes — `buildShotOps`, the same
// ops — and an agent's shot is on screen at its start the moment it is applied. It used to add a
// `Shot` node that nothing read; that type is gone (format v25 turns saved ones into cuts).
//
// With `endTime`, the camera that was on screen at `endTime` comes back there, so the rest of the
// film is unchanged; cuts inside the span are removed. Without it the shot runs to the next cut.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { isCameraNode } from '../../../app/cameraNode';
import { buildShotOps } from '../../../app/shotOps';
import { cameraSelectOf, cutChannelOf } from '../../../app/shots';
import { enumerateCameraNodeIds, selectActiveCameraNode } from '../../../app/activeCamera';

const ShotCreateSpec = z.object({
  cameraId: z.string().min(1),
  startTime: z.number().nonnegative().default(0),
  endTime: z.number().nonnegative().optional(),
});
export type ShotCreateSpec = z.infer<typeof ShotCreateSpec>;

export const shotCreateMutator: MutatorDefinition<ShotCreateSpec> = {
  name: 'mutator.shot.create',
  description:
    'Make a shot: film from startTime (seconds) on cameraId. Writes the cuts the Shots panel ' +
    'shows and the render plays: a cut to the camera at startTime and, when endTime is given, a ' +
    'cut back at endTime to the camera that was on screen there (cuts in between are removed). ' +
    'Without endTime the shot runs to the next cut. Adds a camera switch if the scene has none.',
  spec: ShotCreateSpec,
  specExample: {
    cameraId: 'n_camera',
    startTime: 2,
    endTime: 4,
  },
  contract: {
    requiredEdges: [],
    // #387 — the camera is NOT declared here. `contract.requiredNodeTypes` is a
    // node-TYPE mechanism (gate 4 compares `node.type === requiredType`), and a split
    // camera is an Object posing a CameraData, so a type token cannot express it. The
    // possession-keyed precondition below owns the check instead — and is strictly
    // stronger, since it validates the SPECIFIC `cameraId` rather than "some camera
    // exists somewhere in the closure".
    // The cuts go on the scene's camera: the Scene the project outputs is in the closure (a root).
    requiredNodeTypes: ['Scene'],
    // A cut is a key on the camera switch: nothing about any camera or object moves.
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
  },
  buildClosureSpec(spec, state): ClosureSpec {
    // The cuts land on the scene (when a switch is inserted), its camera switch and the switch's
    // cut channel — named here from the graph, since the agent names only the camera.
    const sceneId = state?.outputs.scene?.node;
    const select = state ? cameraSelectOf(state) : null;
    const channel = state && select ? cutChannelOf(state, select.id) : null;
    return {
      rootSelectors: [spec.cameraId, sceneId, select?.id, channel?.id].filter(
        (id): id is string => typeof id === 'string',
      ),
      followedEdges: [],
    };
  },
  preconditions(spec, _closure, state) {
    const camera = state.nodes[spec.cameraId];
    if (!camera) return { ok: false, reason: `Camera "${spec.cameraId}" not in DAG.` };
    // #387 — possession, not type: post-split a camera is an Object posing a CameraData,
    // so a type test rejects every migrated camera with "is Object; expected a Camera".
    if (!isCameraNode(state, spec.cameraId)) {
      return {
        ok: false,
        reason: `cameraId "${spec.cameraId}" is ${camera.type}; expected a Camera node.`,
      };
    }
    if (spec.endTime !== undefined && spec.endTime <= spec.startTime) {
      return {
        ok: false,
        reason: `endTime (${spec.endTime}) must be after startTime (${spec.startTime}).`,
      };
    }
    if (!buildShotOps(state, spec.startTime, spec.endTime, spec.cameraId)) {
      // With one camera wired straight into the scene there is no switch and nothing to cut to.
      const onlyCamera = enumerateCameraNodeIds(state).length === 1;
      return {
        ok: false,
        reason:
          onlyCamera && selectActiveCameraNode(state, spec.startTime)?.id === spec.cameraId
            ? `"${spec.cameraId}" is the scene's only camera and already films the whole film; ` +
              'add another camera to cut between.'
            : "The scene has no camera socket to cut on (its output names no Scene with a 'camera' input).",
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    return buildShotOps(state, spec.startTime, spec.endTime, spec.cameraId) ?? [];
  },
};
