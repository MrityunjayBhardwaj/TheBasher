// A character with its arms at its sides, for tests of skin weights (#1539): the X Bot fixture's two
// meshes as ONE mesh, re-posed by the file's own weights so that each arm is turned down about its
// shoulder by `degrees`, with the skeleton turned the same way. At 0 it is the file's T-pose.
//
// The file's weights come back too, per point and per bone, so a test can say which part of the
// body a point belongs to without trusting the weights it is testing.

import { Matrix4, Vector3 } from 'three';
import { parseGltfContainer, resolveBuffers } from '../core/import/glb';
import { readGltfMesh } from '../core/import/nativeGltfImport';
import { readNativeSkeletons } from '../core/import/nativeGltfSkeleton';
import { captureBonesOf } from '../nodes/CaptureModifier';
import type { CaptureBone } from '../nodes/captureWeights';
import { skinLanes } from '../nodes/skinInfluences';

export interface XbotArmsDown {
  readonly mesh: {
    readonly points: Float32Array;
    readonly faceSizes: Uint32Array;
    readonly cornerPoints: Uint32Array;
  };
  /** Every bone of the file as a rest segment in the mesh's space, arms turned. */
  readonly bones: readonly CaptureBone[];
  /** The file's own weight of point `p` on bone `b`, at `p * bones.length + b`. */
  readonly fileWeights: Float32Array;
}

/** `bytes` is `public/assets/mixamo-xbot.glb`. */
export async function xbotArmsDown(bytes: ArrayBuffer, degrees: number): Promise<XbotArmsDown> {
  const { json, bin } = parseGltfContainer(bytes);
  const buffers = await resolveBuffers(json, bin);
  const read = readNativeSkeletons(json as never);
  if (!read || 'refused' in read) throw new Error('the fixture has no skeleton');
  const specs = read.skeletons[0].bones;
  // The file's armature node is scaled to a hundredth: bones are in centimetres, points in metres.
  const rest = captureBonesOf(specs, new Matrix4().makeScale(0.01, 0.01, 0.01));
  if (rest.length !== specs.length) throw new Error('a bone of the fixture was skipped');
  const groups = read.skins[0].vertexGroups;

  const hangsUnder = (root: string): boolean[] => {
    const top = specs.findIndex((b) => b.name === root);
    return specs.map((_, i) => {
      for (let k = i; k >= 0; k = specs[k].parent) if (k === top) return true;
      return false;
    });
  };
  /** A turn of `by` degrees about the line through `root`'s head along z. */
  const turnAbout = (root: string, by: number): Matrix4 => {
    const [x, y, z] = rest[specs.findIndex((b) => b.name === root)].head;
    return new Matrix4()
      .makeTranslation(x, y, z)
      .multiply(new Matrix4().makeRotationZ((by * Math.PI) / 180))
      .multiply(new Matrix4().makeTranslation(-x, -y, -z));
  };
  const left = hangsUnder('mixamorig_LeftArm');
  const right = hangsUnder('mixamorig_RightArm');
  // Down is away from +Y on whichever side the arm is.
  const leftSide = Math.sign(rest[specs.findIndex((b) => b.name === 'mixamorig_LeftArm')].head[0]);
  const turnLeft = turnAbout('mixamorig_LeftArm', -leftSide * degrees);
  const turnRight = turnAbout('mixamorig_RightArm', leftSide * degrees);
  const turnOf = (bone: number): Matrix4 | null =>
    left[bone] ? turnLeft : right[bone] ? turnRight : null;

  const at = new Vector3();
  const bones: CaptureBone[] = rest.map((b, i) => {
    const turn = turnOf(i);
    if (!turn) return b;
    const head = at.fromArray(b.head).applyMatrix4(turn).toArray();
    const tail = at.fromArray(b.tail).applyMatrix4(turn).toArray();
    return { name: b.name, head, tail };
  });

  const boneOfGroup = groups.map((name) => specs.findIndex((b) => b.name === name));
  const parts = [0, 1].map((index) => {
    const data = readGltfMesh(json as never, buffers, index, groups);
    if ('refused' in data) throw new Error(data.refused);
    return data;
  });
  const total = parts.reduce((n, d) => n + d.points.length / 3, 0);
  const points = new Float32Array(total * 3);
  const fileWeights = new Float32Array(total * specs.length);
  const faceSizes: number[] = [];
  const cornerPoints: number[] = [];
  const sum = new Vector3();
  let base = 0;
  for (const data of parts) {
    const lanes = skinLanes(data);
    if (!lanes) throw new Error('a mesh of the fixture has no weights');
    const count = data.points.length / 3;
    for (let p = 0; p < count; p++) {
      sum.set(0, 0, 0);
      let weight = 0;
      for (let lane = 0; lane < lanes.width; lane++) {
        const w = lanes.weights[p * lanes.width + lane];
        if (!w) continue;
        const bone = boneOfGroup[lanes.joints[p * lanes.width + lane]];
        fileWeights[(base + p) * specs.length + bone] += w;
        at.fromArray(data.points, p * 3);
        const turn = turnOf(bone);
        if (turn) at.applyMatrix4(turn);
        sum.addScaledVector(at, w);
        weight += w;
      }
      sum.multiplyScalar(1 / weight).toArray(points, (base + p) * 3);
    }
    for (const size of data.faceSizes) faceSizes.push(size);
    for (const corner of data.cornerPoints) cornerPoints.push(corner + base);
    base += count;
  }
  return {
    mesh: {
      points,
      faceSizes: Uint32Array.from(faceSizes),
      cornerPoints: Uint32Array.from(cornerPoints),
    },
    bones,
    fileWeights,
  };
}
