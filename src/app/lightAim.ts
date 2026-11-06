// lightAim — the one way a light is given an aim (#1765).
//
// A sun, spot or area light shines down its own −Z. When it is aimed, it is aimed by a Track-To,
// and that Track-To always aims at an OBJECT: an empty (a Null) named after the light, e.g.
// "Spot.aim". Moving the empty re-aims the light, which is the handle a director reaches for;
// a bare aim point in a constraint's fields is not. Every road that gives a light a Track-To
// comes through here — Add ▸ Light, a studio light, an imported studio profile, the default
// project and the examples, the constraint stack's "+ Add", and the agent's constrain — so a
// new road cannot forget the empty.
//
// The Track-To keeps the same world point as its `aimPoint`. Deleting the empty clears the
// Track-To's `aimNode` (it is an argument reference), the Track-To falls back to that point, and
// the light's own rotation already faces it: the light keeps shining where it shone.
//
// The empty hangs where the light hangs — at the top of the scene, or in the light's parent
// group — never under the light itself, which would aim the light at something it carries.
//
// REF: src/nodes/TrackTo.ts (`aimNode`, `aimPoint`, `idRefs`); src/app/sceneHierarchy.ts.

import * as THREE from 'three';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { nextConstraintOrder } from './nodeConstraints';
import { lightKindOf } from './lightNode';
import { freshObjectName, takenObjectNames } from './objectNames';
import { hierarchyChildIds } from './sceneHierarchy';
import { resolveDrawnParentWorldMatrix } from './drawnWorldTransform';

type Vec3 = [number, number, number];

/** The kinds a Track-To turns: a point light shines every way, an ambient one has no place. */
export const AIMABLE_LIGHT_KINDS: ReadonlySet<string> = new Set(['Directional', 'Spot', 'Area']);

const KIND_WORD: Record<string, string> = { Directional: 'Sun', Spot: 'Spot', Area: 'Area' };

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** "<light>.aim": the light's own name when it has one, else the word for its kind. */
export function lightAimName(state: DagState, lightId: string, kind?: string | null): string {
  const own = (state.nodes[lightId]?.meta as { name?: unknown } | undefined)?.name;
  const base =
    typeof own === 'string' && own
      ? own
      : (KIND_WORD[kind ?? lightKindOf(state.nodes, lightId) ?? ''] ?? 'Light');
  return `${base}.aim`;
}

/** The group `lightId` hangs in, or null at the top of the scene (the Scene, a rig, nothing). */
function parentGroupOf(state: DagState, lightId: string): string | null {
  for (const node of Object.values(state.nodes)) {
    if (node.type === 'Scene') continue;
    if (hierarchyChildIds(node).includes(lightId)) return node.type === 'Group' ? node.id : null;
  }
  return null;
}

export interface LightAimOpts {
  /** Where the light should face, in the world. The empty is put there. */
  readonly at: Vec3;
  /** The light's kind, when the light is being added in the same batch (not yet in `state`). */
  readonly kind?: string;
  readonly trackToId?: string;
  readonly nullId?: string;
  /** Overrides the empty's name (`lightAimName`). */
  readonly name?: string;
}

/**
 * The ops that aim `lightId` at `at`: an empty there, named after the light, hung where the light
 * hangs, and a Track-To on the light aimed at it (with `at` as its fallback point).
 */
export function lightAimOps(
  state: DagState,
  lightId: string,
  opts: LightAimOpts,
): { ops: Op[]; trackToId: string; nullId: string } {
  const nullId = opts.nullId ?? newId('aim');
  const trackToId = opts.trackToId ?? newId('tt');
  const sceneId = state.outputs.scene?.node;
  const parent = parentGroupOf(state, lightId);
  // In its parent's space, so it starts where the light should face. A parent that moves later
  // carries the empty with it, and the light with it.
  let position: Vec3 = [...opts.at];
  if (parent) {
    const parentWorld = resolveDrawnParentWorldMatrix(state, lightId, {
      time: { frame: 0, seconds: 0, normalized: 0 },
    });
    if (parentWorld) {
      const local = new THREE.Vector3(...opts.at).applyMatrix4(parentWorld.clone().invert());
      position = [local.x, local.y, local.z];
    }
  }
  const holder = parent ?? sceneId;
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: nullId,
      nodeType: 'Null',
      params: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'setMeta',
      nodeId: nullId,
      // #1518 — a free name: two spots with no name of their own would otherwise share `Spot.aim`.
      name: freshObjectName(
        opts.name ?? lightAimName(state, lightId, opts.kind),
        takenObjectNames(state),
      ),
    },
    ...(holder
      ? [
          {
            type: 'connect' as const,
            from: { node: nullId, socket: 'out' },
            to: { node: holder, socket: 'children' },
          },
        ]
      : []),
    {
      type: 'addNode',
      nodeId: trackToId,
      nodeType: 'TrackTo',
      params: {
        name: 'aim',
        target: lightId,
        aimNode: nullId,
        aimPoint: [...opts.at],
        up: [0, 1, 0],
        mute: false,
        order: nextConstraintOrder(state.nodes, lightId),
      },
    },
  ];
  return { ops, trackToId, nullId };
}
