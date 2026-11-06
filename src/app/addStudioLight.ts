// addStudioLight — the "+ Light" Op-chain builder for the 2D Light-Studio panel
// (epic #201, slice #206). A studio light is the §1.5 pair-in-waiting: an
// AreaLight wired into scene.lights PLUS a Track-To aiming it at the rig centre
// ([[V60]] — the rig aim), so the new light appears on the panel (enumerateStudioLights
// lists only Track-To-aimed AreaLights) and faces the subject from the moment it
// is added. The emitter `tex` (the studio look, V61) is attached later via the
// panel's tex picker — a fresh light starts as a plain area light (V37: byte-
// identical to a pre-#205 area light until a tex is set).
//
// Pure (V1): reads only the scene aggregator id; never mutates. Mirrors
// addPrimitives.ts. The spawn point is a flattering default — front meridian,
// slightly above the equator — derived through the SAME placement core the panel
// drags through, so "+ Light" lands exactly where a puck at that spot would.
//
// REF: src/app/resolveStudioLightTransform.ts (the placement core); src/nodes/LightData.ts;
//      src/nodes/TrackTo.ts; src/app/addPrimitives.ts (the builder discipline); vyapti V60.

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { resolveStudioLightTransform } from './resolveStudioLightTransform';
import { lightAimOps } from './lightAim';
import { linkIntoActiveCollection } from './collections';
import { freshAimedNames, takenObjectNames } from './objectNames';
import { cameraRotationLookingAt } from './cameraOrientation';

type Vec3 = [number, number, number];

/** A new light's distance from the rig centre, and where on the sphere it spawns
 *  (front meridian u=0.5, a little above the equator v=0.68 — a key-light spot). */
const SPAWN_RADIUS = 6;
const SPAWN_PANEL_XY: [number, number] = [0.5, 0.68];

export interface AddStudioLightResult {
  readonly ops: Op[];
  readonly lightId: string;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Build the Op chain for a new rig light aimed at `target` (the rig centre).
 * Returns null when the scene aggregator is missing (a corrupt project). The
 * chain is atomic at the caller (one dispatchAtomic → one undo entry).
 *
 * When `rigId` is given (a profile is active, #208), the light is wired into that
 * rig's `lights` socket so it belongs to the profile; otherwise it wires into
 * `scene.lights` directly (the pre-profile legacy path #205–#207).
 */
export function buildAddStudioLightOps(
  state: DagState,
  target: Vec3,
  rigId?: string | null,
): AddStudioLightResult | null {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return null;

  const lightId = newId('light');
  const dataId = newId('data');
  const ttId = newId('tt');
  const { position } = resolveStudioLightTransform(SPAWN_PANEL_XY, SPAWN_RADIUS, target);

  // A profile's rig groups the light; without a profile it wires straight into the
  // scene's flat light list (legacy).
  const dest =
    rigId && state.nodes[rigId]?.type === 'LightRig'
      ? { node: rigId, socket: 'lights' }
      : { node: sceneRef.node, socket: 'lights' };

  // #386 Stage C (C3) — a studio light is split-native: a LightData (the Area shading)
  // and an Object (the pose) that inherits `lightId`. The Track-To
  // targets `lightId` (the Object), the rig/scene `dest` receives the Object, and the
  // panel's enumeration recognises it through `data` (studioLightRig, #386 S3b) — so the
  // rig aim + index-correspondence survive the split.
  const { name, aim: aimName } = freshAimedNames('Area', takenObjectNames(state));
  const aim = lightAimOps(state, lightId, {
    at: target,
    kind: 'Area',
    trackToId: ttId,
    name: aimName,
  });
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: dataId,
      nodeType: 'LightData',
      params: {
        lightKind: 'Area',
        intensity: 5,
        color: '#ffffff',
        width: 2,
        height: 2,
      },
    },
    {
      type: 'addNode',
      nodeId: lightId,
      nodeType: 'Object',
      // #1765 — turned toward the rig centre by its own rotation as well, so muting the Track-To
      // leaves it facing where it faced (its old `lookAt` did that, and lights no longer have one).
      params: { position, rotation: cameraRotationLookingAt(position, target), scale: [1, 1, 1] },
    },
    // #1518 — named when made, as Add ▸ Light names one.
    { type: 'setMeta', nodeId: lightId, name },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: lightId, socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: lightId, socket: 'out' },
      to: dest,
    },
    // #1765 — aimed at the rig centre by a Track-To at an empty ("Area.aim") there, the one way
    // every light is aimed (`lightAimOps`).
    ...aim.ops,
  ];
  // #1480 — into the active collection, as every light the Add menu makes joins it (#1453).
  return { ops: linkIntoActiveCollection(state, ops, [lightId, aim.nullId]), lightId };
}
