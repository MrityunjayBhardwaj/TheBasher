// gltfNodeWorld — where a node INSIDE an imported character (a bone, or any glTF node) is in
// the world at a time, pure. #1284: Track-To aims at a character's bone.
//
// WHY THIS IS NEEDED. A walk lives on the character's bones: a generated or imported clip moves
// the Hips, while the character's Group, its GltfAsset and its armature root never move (Kimodo,
// like a Mixamo rig, keeps bone 0 at zero and carries the travel on the Hips — measured on the
// "Camera Path + AI Walk" example, #1282). So "aim at the character" has to be able to mean "aim
// at this bone". `resolveWorldTransform` cannot answer it: a joint's Object is not a scene child
// (#1283), so it returns null for one.
//
// HOW, WITHOUT A SECOND COMPOSITION. Each glTF node's LOCAL pose is read through the one road
// every reader already uses — `resolveEvaluatedTransform`'s glTF-child branch, which layers
// rest → clip → baked samplers → override exactly as the renderer's `resolveAllChildTrs` does,
// at the same seconds. This module only chains those locals up the asset's `childHierarchy`
// (Euler degrees → radians in three's default XYZ order, as the renderer writes them onto the
// clone) and multiplies by the asset's own world transform. Blender's reference behaviour is the
// same: Track To with an armature target and a `subtarget` bone aims at the bone's posed head.
//
// PURE — a function of (state, ids, ctx). THREE is used only for matrix math.
//
// REF: src/app/resolveEvaluatedTransform.ts (the glTF-child branch); src/app/resolveWorldTransform.ts;
//      src/viewport/SceneFromDAG.tsx (the renderer's per-frame child TRS write); issue #1284.

import * as THREE from 'three';
import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type { GltfAssetValue } from '../nodes/types';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { resolveWorldTransform } from './resolveWorldTransform';
import { characterAssetOf } from './characterParts';

type Vec3 = [number, number, number];

/**
 * The WORLD position of the glTF node `nodeName` inside the character `nodeId` stands for, at
 * `ctx.time` — posed, as it is drawn. Null when there is no character, no such node, or a link
 * of the chain cannot be resolved (the caller falls back; never throws).
 */
export function gltfNodeWorldPosition(
  state: DagState,
  nodeId: string,
  nodeName: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 | null {
  const assetId = characterAssetOf(state, nodeId);
  if (!assetId) return null;
  let asset: GltfAssetValue;
  try {
    asset = evaluate(state, assetId, { cache, ctx }).value as GltfAssetValue;
  } catch {
    return null;
  }
  if (!asset?.nodeNameMap?.[nodeName]) return null;
  const parentOf = new Map<string, string>();
  for (const [parent, children] of Object.entries(asset.childHierarchy ?? {}))
    for (const child of children) parentOf.set(child, parent);

  // Leaf-to-top chain, then composed top-down: world = asset · top · … · leaf.
  const chain: string[] = [];
  for (let name: string | undefined = nodeName; name !== undefined; name = parentOf.get(name)) {
    if (chain.includes(name)) return null; // a malformed hierarchy must not loop
    chain.push(name);
  }
  const assetWorld = resolveWorldTransform(state, assetId, ctx, cache);
  if (!assetWorld) return null;
  const m = new THREE.Matrix4().fromArray(assetWorld.matrix);
  const local = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const d = Math.PI / 180;
  for (const name of chain.reverse()) {
    const childId = asset.nodeNameMap[name];
    if (!childId) return null;
    const t = resolveEvaluatedTransform(state, childId, ctx, cache);
    if (!t || !t.rotation || !t.scale) return null;
    e.set(t.rotation[0] * d, t.rotation[1] * d, t.rotation[2] * d);
    local.compose(
      new THREE.Vector3(t.position[0], t.position[1], t.position[2]),
      q.setFromEuler(e),
      new THREE.Vector3(t.scale[0], t.scale[1], t.scale[2]),
    );
    m.multiply(local);
  }
  const p = new THREE.Vector3().setFromMatrixPosition(m);
  return [p.x, p.y, p.z];
}
