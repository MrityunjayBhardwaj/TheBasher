// #1153 — the rotation mode a posable node can hold, Blender's shape.
//
// Blender keeps an euler AND a quaternion on every Object and composes whichever `rotmode`
// names (`object.cc:2794-2815`); its glTF importer sets QUATERNION on meshes and empties alike
// (`io_scene_gltf2/blender/imp/node.py:100`), because a file's rotation tracks are quaternions
// and interpolating them as euler bends the path — measured 41.49° off the spec's slerp on a
// 170° turn, where the same keys as a quaternion channel are 0.00° off.
//
// Only one mode besides today's is offered: the euler order is XYZ everywhere in this codebase,
// and axis-angle has no producer.
//
// ── OPTIONAL, NEVER DEFAULTED ────────────────────────────────────────────────────────────
//
// Both params are `.optional()` for the reason `slotOverrides` is (ObjectNode.ts): a
// `.default(...)` would write the field into every saved Object and Group, which is a format
// change dressed as a default. Absent means euler, and a project that never opts in saves
// byte-identical.
//
// THREE-free, like the rest of `src/nodes`. The resolution — quaternion to the euler every
// reader consumes — needs three's conversion and lives in `src/app/resolvedRotation.ts`.

import { z } from 'zod';
import type { Quat, RotationModeFields } from './types';

/** The two params, spread into ObjectParams and GroupParams. */
export const rotationModeParams = {
  rotationMode: z.enum(['quaternion']).optional(),
  quaternion: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
};

/** Blender's default `rotation_quaternion`: the identity (wxyz 1,0,0,0 — here xyzw). */
export const IDENTITY_QUATERNION: Quat = [0, 0, 0, 1];

/**
 * The fields a value carries for these params. Nothing at all in euler mode — a quaternion
 * the author left behind after switching back composes nothing, as in Blender, and carrying it
 * would change the shape of every euler value that ever held one. In quaternion mode both are
 * carried, the quaternion defaulting to the identity as Blender's does.
 */
export function rotationModeFieldsOf(params: {
  rotationMode?: 'quaternion';
  quaternion?: Quat;
}): RotationModeFields {
  if (params.rotationMode !== 'quaternion') return {};
  // Shape-checked rather than trusted: a saved node is not re-parsed through its schema on
  // load (Group.ts says so of its own params), so what arrives here is whatever was on disk.
  return {
    rotationMode: 'quaternion',
    quaternion: isQuat(params.quaternion) ? params.quaternion : IDENTITY_QUATERNION,
  };
}

function isQuat(v: unknown): v is Quat {
  return Array.isArray(v) && v.length === 4 && v.every((x) => Number.isFinite(x));
}
