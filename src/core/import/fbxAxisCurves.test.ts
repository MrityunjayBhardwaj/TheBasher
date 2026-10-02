// #1279 — a bone's X, Y and Z rotation curves keyed at different times, read by Blender's rule.
//
// Blender's FBX importer takes the union of every curve's key times on an item and fills each curve
// there by linear interpolation, using the property's initial value before the curve's first key
// and its last value after the last (`io_scene_fbx/import_fbx.py:711-739`,
// `_combine_curve_keyframe_times`, `np.interp(..., left=initial_value)`, called at `:1033`, Blender
// 5.1.1). Blender refuses ASCII FBX (`import_fbx.py:3080-3094`), so these rows take their expected
// values from that rule, not from a Blender import: source tier. The every-frame rows against
// Blender's own import are in `fbxImportChain.test.ts`.
//
// The file is the committed ASCII `rig.fbx` with Spine given a rest rotation and a rotation curve
// node whose axes disagree: X keyed at 0 s and 1 s, Y only from 0.5 s, Z not at all. Built here,
// never committed as a second fixture that could drift from the first.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Euler, MathUtils, Quaternion } from 'three';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildFbxImportOps } from './fbxImportChain';
import type { PosedSkeletonValue } from '../../nodes/types';

const RIG = readFileSync(resolve(process.cwd(), 'public/fixtures/anim/rig.fbx'), 'utf8');
const SECOND = 46186158000; // FBX KTime ticks per second

const REST = [10, 20, 30];
const curve = (id: number, keys: [number, number][]) => `	AnimationCurve: ${id}, "AnimCurve::", "" {
		Default: 0
		KeyVer: 4009
		KeyTime: *${keys.length} {
			a: ${keys.map(([t]) => Math.round(t * SECOND)).join(',')}
		}
		KeyValueFloat: *${keys.length} {
			a: ${keys.map(([, v]) => v).join(',')}
		}
	}
`;

/** `rig.fbx` with Spine resting at REST and rotated by the given per-axis curves (null = no curve). */
function rigRotating(axes: {
  x: [number, number][] | null;
  y: [number, number][] | null;
  z: [number, number][] | null;
}): ArrayBuffer {
  const spineRest = 'P: "Lcl Translation", "Lcl Translation", "", "A",0,0.5,0';
  if (!RIG.includes(spineRest)) throw new Error('rig.fbx no longer places Spine where expected');
  let text = RIG.replace(
    spineRest,
    `${spineRest}\n\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",${REST.join(',')}`,
  );
  const ids = { x: 1301, y: 1302, z: 1303 } as const;
  let objects = `	AnimationCurveNode: 1201, "AnimCurveNode::R", "" {
		Properties70:  {
			P: "d|X", "Number", "", "A",${REST[0]}
			P: "d|Y", "Number", "", "A",${REST[1]}
			P: "d|Z", "Number", "", "A",${REST[2]}
		}
	}
`;
  let connections = '	C: "OO",1201,1100\n	C: "OP",1201,200, "Lcl Rotation"\n';
  for (const a of ['x', 'y', 'z'] as const) {
    const keys = axes[a];
    if (!keys) continue;
    objects += curve(ids[a], keys);
    connections += `	C: "OP",${ids[a]},1201, "d|${a.toUpperCase()}"\n`;
  }
  text = text.replace(
    '\n}\n\nConnections:  {\n',
    `\n${objects}}\n\nConnections:  {\n${connections}`,
  );
  if (!text.includes('AnimCurveNode::R'))
    throw new Error('rig.fbx no longer ends its Objects where expected');
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** These files sample no image; a store would be a regression the test should see. */
const storeImage = (): Promise<string> => Promise.reject(new Error('this file stores no image'));

async function spineAt(data: ArrayBuffer, seconds: number): Promise<Quaternion> {
  const { ops } = await buildFbxImportOps({
    data,
    name: 'rig',
    ids: { skeleton: 'sk', layer: 'layer' },
    storeImage,
  });
  let s = emptyDagState();
  for (const op of ops) s = applyOp(s, op).next;
  const pose = evaluate(s, 'layer', {
    ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    socket: 'out',
  }).value as PosedSkeletonValue;
  const i = pose.skeleton.bones.findIndex((b) => b.name === 'Spine');
  return new Quaternion(...pose.sample(seconds)[i].quaternion);
}
/** FBX's default rotation order, eEulerXYZ, is three's 'ZYX' (`FBXLoader.js` `getEulerOrder(0)`). */
const eulerDeg = (x: number, y: number, z: number) =>
  new Quaternion().setFromEuler(
    new Euler(MathUtils.degToRad(x), MathUtils.degToRad(y), MathUtils.degToRad(z), 'ZYX'),
  );
const degreesBetween = (a: Quaternion, b: Quaternion) =>
  MathUtils.radToDeg(
    2 * Math.acos(Math.min(1, Math.abs(a.clone().normalize().dot(b.clone().normalize())))),
  );

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#1279 — each axis is filled at every key time of the bone, as Blender fills it', () => {
  const file = rigRotating({
    x: [
      [0, 0],
      [1, 60],
    ],
    y: [
      [0.5, 50],
      [1, 50],
    ],
    z: null,
  });

  // The merged key times are 0, 0.5 and 1 s. X is linear between its own keys (30° at 0.5 s), Y is
  // its initial value before its first key (20° at 0 s — not its first key's 50°), and Z, which has
  // no curve, stays at rest (30°).
  it.each([
    [0, [0, 20, 30]],
    [0.5, [30, 50, 30]],
    [1, [60, 50, 30]],
  ] as const)('at %f s Spine reads (%j)°', async (seconds, [x, y, z]) => {
    expect(degreesBetween(await spineAt(file, seconds), eulerDeg(x, y, z))).toBeLessThan(1e-4);
  });

  it('the file is read at all: the rest alone would be a different rotation at 1 s', () => {
    expect(
      degreesBetween(eulerDeg(60, 50, 30), eulerDeg(...(REST as [number, number, number]))),
    ).toBeGreaterThan(30);
  });
});
