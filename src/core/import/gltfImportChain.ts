// What is left of the glTF clone importer (Phase 7.5 Wave D, #81) after the clone road retired.
//
// This file used to build the whole clone import — a GltfAsset, a GltfData per mesh child, a
// GltfSkeleton per skin, TransformClips and a ClipSelect. Nothing imports that way since #1421,
// and the builder itself (`buildGltfImportOps`) went with its last caller, the load converter
// (#1424). What stays is what other code still reads:
//
//   - `hashId` and the id helpers — content-addressed node ids (fnv1a-32 over assetRef + suffix,
//     no Math.random / Date.now: V2 / THESIS §48). The native importer mints its ids with
//     `hashId`; the frozen migrations address old imported children with `gltfChildDagId` /
//     `gltfChannelDagId`; `importGroupNodeIds` is an old import's footprint in a saved graph.
//   - `buildNodeNameMap` — sanitised, collision-suffixed scene-node names, in JSON-array walk
//     order. The native importer keys its nodes with it.
//   - `computeGltfBoundsCenter` — the native importer's default pivot.
//   - `buildSkinMetadata` / `defaultTRS` — the shape a `GltfSkeleton` node holds. No production
//     caller; tests of the skeleton projection and the retarget use it to make that shape. It
//     goes when the node type does (#1425).
//
// REF: src/core/import/nativeGltfImport.ts; src/core/project/migrations.ts;
//      src/app/asset/importCommon.ts; issues #81, #1053, #1424, #1425.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { radVec3ToDeg, type Vec3 } from '../../viewport/rotation';
import { sanitizeBoneName, quaternionToEulerVec3 } from './threeAdapter';
import { readAccessor, type GltfJson } from './glb';
import type { DagState } from '../dag/state';
// #389 — the ONE reader of "is this node an imported child, and what is it?". Imported
// rather than re-spelled here for the reason its own header gives: the fused kind's
// spelling used to live in fifteen places, and this module was one of them.
import { importedChildDataId, importedChildrenOf } from '../../app/importedChild';

export interface GltfImportChainArgs {
  readonly buffer: ArrayBuffer;
  readonly assetRef: string;
  readonly sceneNodeId: string;
  readonly position?: Vec3;
  /**
   * Resolves an external buffer URI (relative `.bin`) to its bytes (#90).
   * Injected because byte resolution is environment-specific (OPFS in
   * the app, fixtures in tests). data-URI buffers are decoded inline by
   * `resolveBuffers` and never reach this callback; omit it for
   * single-file GLB / data-URI-only `.gltf`. An external URI with no
   * resolver throws loudly at `resolveBuffers`.
   */
  readonly resolveBuffer?: (uri: string) => Promise<Uint8Array>;
}

// fnv1a 32-bit — small, dependency-free, deterministic. Output is an
// 8-char hex string suffix on an `n_gltf_…` id namespace. Choice
// rationale: V2 forbids non-deterministic id sources here (Math.random
// / Date.now). fnv1a is a non-cryptographic hash but determinism is
// the only property this seam needs.
function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Exported for #1049's native import road, so its content-addressed ids share this one rule.
export function hashId(prefix: string, ...parts: string[]): string {
  return `n_${prefix}_${fnv1a32(parts.join('|'))}`;
}

/**
 * The content-addressed DAG id of a glTF child (bone) node. This is the SAME
 * derivation `buildNodeNameMap` uses at import (:120, `hashId('gltfChild',
 * assetRef, key)`). Exported so the P7.12 copy-on-write bake mutator
 * (bakeGltfChannel, Wave D — gone in #1053) stored `params.target` = the child's dagId
 * without re-deriving the hash by hand (single source of truth — BLOCK-2); today the
 * v9→v10 migration uses it to recognise channels saved in that shape. Diverging
 * derivations would have broken the renderer's `nodeNameMap[childName] === target`
 * asset-membership check (bakedGltfChannels.ts (gone in #1053; at 7e1356c7)) AND paramAnimationState's
 * `p.target === selectionNodeId` match (the bone's selection id IS this dagId).
 *
 * REF: src/core/import/gltfImportChain.ts:120 (the import-time derivation);
 *      app/bakedGltfChannels.ts (gone in #1053; at 7e1356c7) (the consumer); PLAN 7.12 Wave D (BLOCK-2).
 */
export function gltfChildDagId(assetRef: string, childName: string): string {
  return hashId('gltfChild', assetRef, childName);
}

/**
 * The content-addressed DAG id of a P7.12 baked KeyframeChannel for one bone's
 * TRS component (position/rotation/scale). Deterministic (V22): re-baking the
 * same bone yields the SAME ids, so the bake is idempotent (D1 guards on
 * `state.nodes[id]`). Namespaced `gltfChannel` so it can never collide with the
 * bone's own `gltfChild` id nor an authored channel id.
 *
 * REF: PLAN 7.12 Wave D (D1, V22 determinism); app/animate/bakeGltfChannel.ts (gone in
 *      #1053; at 15c170c4); src/core/project/migrations.ts (the reader today).
 */
export function gltfChannelDagId(assetRef: string, childName: string, component: string): string {
  return hashId('gltfChannel', assetRef, childName, component);
}

/**
 * The content-addressed DAG id of the `GltfSkeleton` projecting one of an
 * asset's skins (#807). Deterministic like every other import id, so a re-import
 * of the same file yields the same rig node and the retarget road can address a
 * character's skeleton without searching for it.
 *
 * REF: src/nodes/GltfSkeleton.ts (the projection); issue #100 (which defined the
 *      node), issue #807 (which gave it a producer).
 */
export function gltfSkeletonDagId(assetRef: string, skinIndex: number): string {
  return hashId('gltfSkel', assetRef, String(skinIndex));
}

/**
 * Every DAG node the clone importer emitted for one `assetRef` — the "import
 * footprint" of a single glTF imported on the old structure (#1424: only an old
 * save holds one). Used by the My-Imports break-refs
 * delete (#127) to GC the WHOLE subtree, not just the `GltfAsset` node, so a
 * referenced-asset delete leaves no orphan wrapper `Transform`/`Group`, no
 * inputless `GltfChild` satellites, and no `TransformClip`/`ClipSelect` ghosts.
 *
 * The membership is recovered WITHOUT a stored provenance tag because every
 * import id is already content-addressed off `assetRef` (the id IS the
 * provenance): the assetRef-carrying nodes (`GltfAsset`, the `GltfChild`
 * satellites) are found by `params.assetRef` (authoritative — survives the
 * dedup-suffix key rename), and the structural wrappers that carry no assetRef
 * (`Transform`/`Group`/`ClipSelect`/`TransformClip`) are recomputed via the
 * same `hashId(prefix, assetRef, …)` derivation the importer used.
 *
 * Crucially this NEVER over-reaches into user-wired nodes: a user-created
 * Transform has a random id, never `hashId('tx', assetRef)`, and never carries
 * the import's assetRef in params. The shared output anchor (the `Scene` node)
 * is not content-addressed off assetRef, so it is never in the set. Only ids
 * that actually exist in `state` are returned (a clip-less import has no
 * clip/sel nodes; a re-saved older project may lack some).
 *
 * REF: src/core/project/__fixtures__/clone-characters/placed.json (a recorded
 *      footprint); src/app/asset/importCommon.ts `deleteImportedAsset`
 *      (the break-refs consumer); issue #127.
 */
export function importGroupNodeIds(assetRef: string, state: DagState): string[] {
  const ids = new Set<string>();
  // Structural wrappers (no assetRef in params) — recompute from the id scheme.
  ids.add(hashId('gltf', assetRef));
  ids.add(hashId('tx', assetRef));
  ids.add(hashId('grp', assetRef));
  ids.add(hashId('sel', assetRef));
  // Clips are emitted at contiguous indices 0..N-1.
  for (let i = 0; state.nodes[hashId('clip', assetRef, String(i))]; i++) {
    ids.add(hashId('clip', assetRef, String(i)));
  }
  // Skins likewise (#807). Without this line a deleted character leaves its rig
  // node behind — inputless, projecting an asset that no longer exists, and
  // indistinguishable in the outliner from a rig that still means something.
  for (let i = 0; state.nodes[gltfSkeletonDagId(assetRef, i)]; i++) {
    ids.add(gltfSkeletonDagId(assetRef, i));
  }
  // assetRef-carrying nodes (the GltfAsset itself) — find by params, the authoritative
  // source (independent of the hashId derivation + nameMap).
  for (const node of Object.values(state.nodes)) {
    if (
      node.type === 'GltfAsset' &&
      (node.params as { assetRef?: string } | undefined)?.assetRef === assetRef
    ) {
      ids.add(node.id);
    }
  }
  // #389 — the imported children, BOTH HALVES. A param scan alone no longer finds them:
  // after the split the `assetRef` lives on the DATA node and the OBJECT carries only a
  // pose, so the old `type === 'GltfChild' && params.assetRef === …` test would collect
  // every data node and leave every Object behind — a deleted asset would strand one
  // poseless, dataless node per bone in the outliner. The seam answers the membership
  // question and hands back the pair.
  for (const [objectId] of importedChildrenOf(state.nodes, assetRef)) {
    ids.add(objectId);
    const dataId = importedChildDataId(state.nodes, objectId);
    if (dataId) ids.add(dataId);
  }
  return [...ids].filter((id) => state.nodes[id] !== undefined);
}

interface NameMapResult {
  /** Sanitised + deduped scene-node key → DAG TransformClip target id.
   *  The renderer walks gltf.scene by `Object3D.name`, sanitises to the
   *  same key, then looks up the dagId here. */
  nodeNameMap: Record<string, string>;
  /** Glb-JSON-index → unique key (same key as in nodeNameMap). */
  keyByGltfNodeIndex: Record<number, string>;
  /**
   * P7.7 (#91) — parent KEY → child KEYs. Derived from the glTF
   * `node.children` index arrays, mapped through `keyByGltfNodeIndex` so the
   * hierarchy is stored by post-dedup KEY (e.g. `bone__1`), matching the
   * nodeNameMap key contract — NOT by raw glTF index (which doesn't survive
   * the dedup-suffix rename). Persisted on the GltfAsset node (A3) and read
   * by the outliner (Wave D) as a pure projection — children are NOT render
   * `inputs` (R-2 / B12 guard). A node absent as a value here (appears in no
   * parent's child list) is a root; the walk computes roots from that.
   */
  childHierarchy: Record<string, string[]>;
}

export function buildNodeNameMap(json: GltfJson, assetRef: string): NameMapResult {
  const nodeNameMap: Record<string, string> = {};
  const keyByGltfNodeIndex: Record<number, string> = {};
  const seen = new Set<string>();
  const nodes = json.nodes ?? [];
  for (let i = 0; i < nodes.length; i++) {
    const raw = nodes[i].name ?? '';
    const base = sanitizeBoneName(raw) || `node_${i}`;
    let key = base;
    let suffix = 1;
    while (seen.has(key)) {
      key = `${base}__${suffix}`;
      suffix += 1;
    }
    seen.add(key);
    const dagId = hashId('gltfChild', assetRef, key);
    nodeNameMap[key] = dagId;
    keyByGltfNodeIndex[i] = key;
  }
  // Second pass — keys are now fully assigned, so child indices resolve to
  // their post-dedup keys. Only emit an entry for a parent that actually has
  // children (keeps the persisted map minimal + the determinism stable).
  const childHierarchy: Record<string, string[]> = {};
  for (let i = 0; i < nodes.length; i++) {
    const children = nodes[i].children;
    if (!children || children.length === 0) continue;
    const parentKey = keyByGltfNodeIndex[i];
    childHierarchy[parentKey] = children
      .map((ci) => keyByGltfNodeIndex[ci])
      .filter((k): k is string => k !== undefined);
  }
  return { nodeNameMap, keyByGltfNodeIndex, childHierarchy };
}

/**
 * A complete static TRS — what a glTF node declares and what `defaultTRS`
 * yields. Deliberately NOT `Required<PartialKeyframe>`: since #876 that form
 * also demands `rotationRad`, a staging field that exists only while animation
 * keyframes are being assembled and is meaningless for a node's static
 * transform. Conflating the two made the static side owe a field it can never
 * have.
 */
interface StaticTRS {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

// Exported for #1049's native import road: an Object's base pose comes from the node the same
// way whichever road the import takes.
export function defaultTRS(node: GltfJson['nodes'][number]): StaticTRS {
  // P7.11 (#100, FLAG 1) — a glTF node may carry its local transform as a
  // single 4×4 column-major `matrix` INSTEAD of translation/rotation/scale
  // (glTF 2.0 §3.6; Blender exports joints this way). Decompose it into the
  // same TRS the T/R/S branch produces, so a matrix-form joint and the
  // equivalent T/R/S joint yield identical bind TRS — correct-by-construction.
  // Without this, matrix-form joints capture as identity (silent on the
  // committed TRS-only fixtures) and deform fidelity breaks. This also closes
  // the same latent gap on the pre-existing GltfChild import path (:309),
  // which calls defaultTRS too. Matrix4.decompose recovers T/R/S within float
  // limits; it cannot recover shear, but glTF joint matrices are affine TRS
  // (no shear by spec), so the decomposition is exact for valid rigs.
  if (node.matrix) {
    const m = new Matrix4().fromArray(node.matrix); // fromArray reads column-major (matches glTF)
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    m.decompose(pos, quat, scl);
    return {
      position: [pos.x, pos.y, pos.z],
      rotation: radVec3ToDeg(quaternionToEulerVec3(quat)),
      scale: [scl.x, scl.y, scl.z],
    };
  }
  const rotRad: Vec3 = node.rotation
    ? quaternionToEulerVec3(
        new Quaternion(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]),
      )
    : [0, 0, 0];
  return {
    position: (node.translation ?? [0, 0, 0]) as Vec3,
    rotation: radVec3ToDeg(rotRad),
    scale: (node.scale ?? [1, 1, 1]) as Vec3,
  };
}

/**
 * #222 — the model's world-space bounding-box CENTRE, used as the import Group's
 * `pivot` so the import rotates/scales about its own centre (not the world
 * origin). Computed PURELY from the glTF accessor min/max — POSITION accessors
 * declare their bounds per glTF 2.0 §3.6.1, so NO buffer reads are needed. Walks
 * the scene node hierarchy accumulating world matrices, transforms each mesh
 * primitive's 8 bbox corners by its node's world matrix, and centres the union.
 * Returns [0,0,0] when no positioned geometry is found (→ identity pivot, so the
 * Group behaves exactly as a non-centred one).
 */
export function computeGltfBoundsCenter(json: GltfJson): Vec3 {
  const nodes = json.nodes ?? [];
  const meshes = (json.meshes ?? []) as {
    primitives?: { attributes?: Record<string, number> }[];
  }[];
  const accessors = (json.accessors ?? []) as { min?: number[]; max?: number[] }[];

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const corner = new Vector3();

  const localMatrix = (node: GltfJson['nodes'][number]): Matrix4 => {
    if (node.matrix) return new Matrix4().fromArray(node.matrix);
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];
    return new Matrix4().compose(
      new Vector3(t[0], t[1], t[2]),
      new Quaternion(r[0], r[1], r[2], r[3]),
      new Vector3(s[0], s[1], s[2]),
    );
  };

  const visit = (nodeIdx: number, parent: Matrix4) => {
    const node = nodes[nodeIdx];
    if (!node) return;
    const world = parent.clone().multiply(localMatrix(node));
    if (typeof node.mesh === 'number') {
      for (const prim of meshes[node.mesh]?.primitives ?? []) {
        const posIdx = prim.attributes?.POSITION;
        const acc = typeof posIdx === 'number' ? accessors[posIdx] : undefined;
        const lo = acc?.min;
        const hi = acc?.max;
        if (Array.isArray(lo) && Array.isArray(hi) && lo.length === 3 && hi.length === 3) {
          for (let i = 0; i < 8; i++) {
            corner
              .set(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2])
              .applyMatrix4(world);
            minX = Math.min(minX, corner.x);
            maxX = Math.max(maxX, corner.x);
            minY = Math.min(minY, corner.y);
            maxY = Math.max(maxY, corner.y);
            minZ = Math.min(minZ, corner.z);
            maxZ = Math.max(maxZ, corner.z);
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };

  // Scene roots; fall back to nodes that aren't anyone's child (avoid double-
  // transforming a child that's also walked as a root when no scene is declared).
  const scenes = (json as { scenes?: { nodes?: number[] }[]; scene?: number }).scenes;
  const sceneIdx = (json as { scene?: number }).scene ?? 0;
  let roots = scenes?.[sceneIdx]?.nodes;
  if (!roots) {
    const childSet = new Set<number>();
    for (const n of nodes) for (const c of n.children ?? []) childSet.add(c);
    roots = nodes.map((_, i) => i).filter((i) => !childSet.has(i));
  }
  const identity = new Matrix4();
  for (const r of roots) visit(r, identity);

  if (minX > maxX) return [0, 0, 0]; // no positioned geometry
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/**
 * P7.11 (#100, D-04) — per-skin bind metadata captured at import.
 * Everything is indexed in `skin.joints[]` order (the SPINE): jointKeys[i],
 * bindTRS[i], parentJointIndex[i], inverseBindMatrices[i] all describe the
 * joint at joint-list position `i`. This single ordering makes the projector
 * (C1) trivial and the H40 render boundary-pair a plain index-by-index check.
 */
export interface SkinMetadata {
  /** GltfChild KEYS in skin.joints[] order. */
  jointKeys: string[];
  /** Per-joint bind TRS (degrees Euler), SAME order. Matrix-form handled by
   *  defaultTRS. */
  bindTRS: StaticTRS[];
  /** Per-joint nearest joint-ancestor's position WITHIN jointKeys, or -1 for
   *  a root / no-joint-parent. SAME order. (FLAG 2 — captured first-class so
   *  C1 reads it directly, no runtime re-derivation.) */
  parentJointIndex: number[];
  /** Per-joint number[16] column-major IBM, SAME order. `[]` when the skin
   *  declares no inverseBindMatrices (loader treats absent as identity). */
  inverseBindMatrices: number[][];
  /** Advisory common-root key (skin.skeleton mapped through keyByGltfNodeIndex). */
  skeletonRootKey?: string;
  name?: string;
}

/**
 * Capture per-skin bind metadata (D-04). Deterministic — content-addressed
 * off `json` (V22); no Math.random / Date.now. `childHierarchy` is inverted
 * here to resolve each joint's nearest JOINT ancestor in joints space.
 */
export function buildSkinMetadata(
  json: GltfJson,
  buffers: Uint8Array[],
  keyByGltfNodeIndex: Record<number, string>,
  childHierarchy: Record<string, string[]>,
): SkinMetadata[] {
  const skins = json.skins ?? [];
  // Invert childHierarchy once: child KEY → parent KEY. A node absent here is
  // a root (in no parent's child list).
  const parentKeyByChildKey: Record<string, string> = {};
  for (const [parentKey, childKeys] of Object.entries(childHierarchy)) {
    for (const childKey of childKeys) parentKeyByChildKey[childKey] = parentKey;
  }

  return skins.map((skin) => {
    const jointKeys = skin.joints.map((nodeIdx) => keyByGltfNodeIndex[nodeIdx]);
    // jointKey → its position in the joints list (the spine ordering).
    const jointPosByKey: Record<string, number> = {};
    for (let i = 0; i < jointKeys.length; i++) jointPosByKey[jointKeys[i]] = i;

    const bindTRS = skin.joints.map((nodeIdx) => defaultTRS(json.nodes[nodeIdx]));

    // (FLAG 2) Walk UP the hierarchy from each joint to the nearest JOINT
    // ancestor; record that ancestor's joints-list position, or -1.
    const parentJointIndex = jointKeys.map((jointKey) => {
      let cursor: string | undefined = parentKeyByChildKey[jointKey];
      while (cursor !== undefined) {
        const pos = jointPosByKey[cursor];
        if (pos !== undefined) return pos; // nearest joint ancestor
        cursor = parentKeyByChildKey[cursor]; // skip non-joint parent, keep climbing
      }
      return -1; // root or no joint ancestor
    });

    // IBMs: read the MAT4/FLOAT accessor (16 floats per joint, column-major)
    // and slice per joint by joint-list position `i` — the #1 bug site is
    // indexing by NODE index here instead of joint-list position.
    let inverseBindMatrices: number[][] = [];
    if (skin.inverseBindMatrices !== undefined) {
      const ibm = readAccessor(json, buffers, skin.inverseBindMatrices);
      inverseBindMatrices = skin.joints.map((_, i) =>
        Array.from(ibm.subarray(i * 16, i * 16 + 16)),
      );
    }

    const skeletonRootKey =
      skin.skeleton !== undefined ? keyByGltfNodeIndex[skin.skeleton] : undefined;

    return {
      jointKeys,
      bindTRS,
      parentJointIndex,
      inverseBindMatrices,
      ...(skeletonRootKey !== undefined ? { skeletonRootKey } : {}),
      ...(skin.name !== undefined ? { name: skin.name } : {}),
    };
  });
}
