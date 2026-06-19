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
// REF: src/app/resolveStudioLightTransform.ts (the placement core); src/nodes/AreaLight.ts;
//      src/nodes/TrackTo.ts; src/app/addPrimitives.ts (the builder discipline); vyapti V60.

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { resolveStudioLightTransform } from './resolveStudioLightTransform';

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
 */
export function buildAddStudioLightOps(
  state: DagState,
  target: Vec3,
): AddStudioLightResult | null {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return null;

  const lightId = newId('light');
  const ttId = newId('tt');
  const { position } = resolveStudioLightTransform(SPAWN_PANEL_XY, SPAWN_RADIUS, target);

  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: lightId,
      nodeType: 'AreaLight',
      params: { intensity: 5, position, color: '#ffffff', width: 2, height: 2, lookAt: target },
    },
    {
      type: 'connect',
      from: { node: lightId, socket: 'out' },
      to: { node: sceneRef.node, socket: 'lights' },
    },
    {
      type: 'addNode',
      nodeId: ttId,
      nodeType: 'TrackTo',
      params: { name: 'aim', target: lightId, aimNode: '', aimPoint: target, up: [0, 1, 0], mute: false },
    },
  ];
  return { ops, lightId };
}
