// #1728 — an animated object's transform is written onto the drawn object, not re-rendered.
//
// A keyed object used to move by a React state update made inside the frame loop: every frame
// the overlay renderer sampled its channels and called `setState` with the patched value. React
// schedules that update at its default priority, and while the frame is busy and anything that
// follows the playhead (the selected object's gizmo) keeps sending higher-priority updates, it is
// never rendered: the keyed object stands still until playback pauses (#1726).
//
// The fix splits the sampled value in two:
//   - its TRANSFORM (position, rotation, scale) is written straight onto a wrapper group every
//     frame, the way `BoneParentR` already places a bone-parented child. No React work at all.
//   - everything else (material, size, data) is drawn by React as before, at an identity
//     transform inside that wrapper, and re-rendered only when one of those fields changes.
// A keyed transform therefore never asks React for anything during playback.
//
// The wrapper carries the transform only for value kinds whose own renderer applies it as a
// plain group transform (`drawsTransformAsGroup`). A light reads its scale as intensity and
// aims from its position, so it keeps the old road until it gets a writer of its own.

import type * as THREE from 'three';
import { withResolvedRotation } from '../app/resolvedRotation';
import type { SceneObject } from '../nodes/types';

const DEG2RAD = Math.PI / 180;

/** The top-level fields that make up a value's transform: the orientation in either mode. */
const TRANSFORM_KEYS: ReadonlySet<string> = new Set([
  'position',
  'rotation',
  'scale',
  'quaternion',
  'rotationMode',
]);

/**
 * True when every renderer of this value applies its position, rotation and scale as the
 * transform of a group or mesh and reads them for nothing else, so drawing it at identity inside a
 * group carrying that transform draws the same thing.
 *
 * - Object: its body (mesh, skinned mesh, curve) and its children's group sit at its TRS. Not
 *   when its data is a light: the light reads scale as intensity and aims from its position.
 * - Group: TRS on the outer group, the pivot on an inner one, so T·R·S·T(-pivot) is unchanged.
 * - Transform, Null: one group at their TRS.
 */
export function drawsTransformAsGroup(value: SceneObject): boolean {
  switch (value.kind) {
    case 'Object':
      return value.data?.kind !== 'LightData';
    case 'Group':
    case 'Transform':
    case 'Null':
      return true;
    default:
      return false;
  }
}

/**
 * `value` drawn at identity: position 0, rotation 0, scale 1, euler mode. Every other field is the
 * same object, so the identity the evaluator minted (material key, geometry ref) still describes
 * it: none of those is derived from the transform.
 */
export function withoutTransform<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!TRANSFORM_KEYS.has(k)) rest[k] = v;
  }
  rest.position = [0, 0, 0];
  rest.rotation = [0, 0, 0];
  rest.scale = [1, 1, 1];
  return rest as T;
}

/**
 * True when `a` and `b` differ in nothing but their transform. Compares top-level fields by
 * identity: the overlay copies only the path it writes (`cloneForOverlay`), so a field no channel
 * touched is the very same object in both.
 */
export function sameApartFromTransform(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of Object.keys(ra)) if (!TRANSFORM_KEYS.has(k) && ra[k] !== rb[k]) return false;
  for (const k of Object.keys(rb)) if (!TRANSFORM_KEYS.has(k) && !(k in ra)) return false;
  return true;
}

/**
 * Write `value`'s transform onto `object`, as the renderers' `position`/`rotation`/`scale` props
 * would: rotation in degrees to radians, XYZ order, a quaternion-mode value through the same
 * `withResolvedRotation` every renderer reads. `null` writes identity.
 */
export function writeTransform(object: THREE.Object3D, value: unknown): void {
  if (!value || typeof value !== 'object') {
    object.position.set(0, 0, 0);
    object.rotation.set(0, 0, 0, 'XYZ');
    object.scale.set(1, 1, 1);
    return;
  }
  const v = withResolvedRotation(value) as {
    position?: readonly number[];
    rotation?: readonly number[];
    scale?: readonly number[];
  };
  const p = v.position ?? [0, 0, 0];
  const r = v.rotation ?? [0, 0, 0];
  const s = v.scale ?? [1, 1, 1];
  object.position.set(p[0], p[1], p[2]);
  object.rotation.set(r[0] * DEG2RAD, r[1] * DEG2RAD, r[2] * DEG2RAD, 'XYZ');
  object.scale.set(s[0], s[1], s[2]);
}
