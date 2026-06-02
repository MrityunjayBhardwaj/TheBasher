// glTF TRS animation import — Phase 7.5 Wave D (issue #81).
//
// Single sibling to buildFbxImportOps / buildBvhImportOps — the third
// importer the deferred-glTF-clips note in fbxImportChain.ts:7 was
// waiting for. Eager-parses GLB animations into N TransformClip Ops
// + 1 ClipSelect Op + the existing static GltfAsset → Transform →
// Group → Scene chain, all atomic.
//
// Discipline (CONTEXT.md / RESEARCH.md):
//   - **Deterministic** ids: content-addressed (fnv1a-32 over assetRef
//     + suffix). No Math.random / Date.now anywhere in this file —
//     V2 / THESIS §48.
//   - **Single path**: always run this importer; emit a degenerate Op
//     chain (no TransformClip / no ClipSelect / empty nodeNameMap) when
//     `json.animations` is absent or empty. One call graph; one test
//     surface.
//   - **Rotation conversion at the seam**: quaternionToEulerVec3 →
//     radians → radVec3ToDeg → degrees. Locked at B3 CHECKPOINT (see
//     .planning/phases/7.5-gltf-transform-clip/SECTION-INVENTORY.md).
//   - **Sanitised names**: scene-node names go through sanitizeBoneName
//     (same THREE-reserved-char class as BVH bones); collisions get a
//     `__N` suffix in JSON-array walk order.
//   - **glTF defaults**: a node's static `translation / rotation / scale`
//     fill any TRS channel a clip doesn't carry (glTF 2.0 §5.34).
//
// REF: PLAN.md Wave D; CONTEXT D-01/D-02/D-03/D-06;
// fbxImportChain.ts:7 (the abstraction note that earns its keep here).

import { Matrix4, Quaternion, Vector3 } from 'three';
import { radVec3ToDeg, type Vec3 } from '../../viewport/rotation';
import { sanitizeBoneName, quaternionToEulerVec3 } from './threeAdapter';
import {
  parseGltfContainer,
  resolveBuffers,
  readAccessor,
  type GltfAnimation,
  type GltfJson,
} from './glb';
import type { Op } from '../dag/types';
import type { DagState } from '../dag/state';

export interface GltfImportChainResult {
  readonly ops: Op[];
  readonly gltfAssetId: string;
  readonly clipSelectId: string | null;
  readonly transformClipIds: string[];
  readonly nodeNameMap: Record<string, string>;
}

export interface GltfImportChainArgs {
  readonly buffer: ArrayBuffer;
  readonly assetRef: string;
  readonly sceneNodeId: string;
  readonly timeSourceId?: string;
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

function hashId(prefix: string, ...parts: string[]): string {
  return `n_${prefix}_${fnv1a32(parts.join('|'))}`;
}

/**
 * The content-addressed DAG id of a glTF child (bone) node. This is the SAME
 * derivation `buildNodeNameMap` uses at import (:120, `hashId('gltfChild',
 * assetRef, key)`), exported so the P7.12 copy-on-write bake mutator
 * (bakeGltfChannel, Wave D) stores `params.target` = the child's dagId without
 * re-deriving the hash by hand (single source of truth — BLOCK-2). Diverging
 * derivations would break the renderer's `nodeNameMap[childName] === target`
 * asset-membership check (bakedGltfChannels.ts) AND paramAnimationState's
 * `p.target === selectionNodeId` match (the bone's selection id IS this dagId).
 *
 * REF: src/core/import/gltfImportChain.ts:120 (the import-time derivation);
 *      src/app/bakedGltfChannels.ts (the consumer); PLAN 7.12 Wave D (BLOCK-2).
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
 * REF: PLAN 7.12 Wave D (D1, V22 determinism); bakeGltfChannel.ts.
 */
export function gltfChannelDagId(assetRef: string, childName: string, component: string): string {
  return hashId('gltfChannel', assetRef, childName, component);
}

/**
 * Every DAG node `buildGltfImportOps` emits for one `assetRef` — the "import
 * footprint" of a single imported glTF. Used by the My-Imports break-refs
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
 * same `hashId(prefix, assetRef, …)` derivation `buildGltfImportOps` uses.
 *
 * Crucially this NEVER over-reaches into user-wired nodes: a user-created
 * Transform has a random id, never `hashId('tx', assetRef)`, and never carries
 * the import's assetRef in params. The shared output anchor (the `Scene` node)
 * is not content-addressed off assetRef, so it is never in the set. Only ids
 * that actually exist in `state` are returned (a clip-less import has no
 * clip/sel nodes; a re-saved older project may lack some).
 *
 * REF: src/core/import/gltfImportChain.ts:392 `buildGltfImportOps` (the emitter
 *      this mirrors); src/app/asset/importCommon.ts `deleteImportedAsset`
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
  // assetRef-carrying nodes (GltfAsset + GltfChild satellites) — find by params,
  // the authoritative source (independent of the hashId derivation + nameMap).
  for (const node of Object.values(state.nodes)) {
    if (
      (node.type === 'GltfAsset' || node.type === 'GltfChild') &&
      (node.params as { assetRef?: string } | undefined)?.assetRef === assetRef
    ) {
      ids.add(node.id);
    }
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

interface PartialKeyframe {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
}

interface CompleteKeyframe {
  targetNodeId: string;
  time: number;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

function defaultTRS(node: GltfJson['nodes'][number]): Required<PartialKeyframe> {
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
  bindTRS: Required<PartialKeyframe>[];
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

function buildClipKeyframes(
  animation: GltfAnimation,
  json: GltfJson,
  buffers: Uint8Array[],
  keyByGltfNodeIndex: Record<number, string>,
): { duration: number; keyframes: CompleteKeyframe[] } {
  // Per-target per-time partial assemblage. We merge translation /
  // rotation / scale channels onto the same (target, time) key, then
  // fill missing components from the glTF node's static TRS (glTF 2.0
  // §5.34 — "the channel's missing components use the corresponding
  // values from the targeted node's transform").
  const partial = new Map<string, Map<number, PartialKeyframe>>();
  let duration = 0;
  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.sampler];
    const targetIndex = channel.target.node;
    const targetKey = keyByGltfNodeIndex[targetIndex];
    if (!targetKey) continue;
    const times = readAccessor(json, buffers, sampler.input);
    const values = readAccessor(json, buffers, sampler.output);
    for (let i = 0; i < times.length; i++) {
      duration = Math.max(duration, times[i]);
      let perTarget = partial.get(targetKey);
      if (!perTarget) {
        perTarget = new Map();
        partial.set(targetKey, perTarget);
      }
      let kf = perTarget.get(times[i]);
      if (!kf) {
        kf = {};
        perTarget.set(times[i], kf);
      }
      if (channel.target.path === 'translation') {
        kf.position = [values[i * 3], values[i * 3 + 1], values[i * 3 + 2]];
      } else if (channel.target.path === 'scale') {
        kf.scale = [values[i * 3], values[i * 3 + 1], values[i * 3 + 2]];
      } else if (channel.target.path === 'rotation') {
        const quat = new Quaternion(
          values[i * 4],
          values[i * 4 + 1],
          values[i * 4 + 2],
          values[i * 4 + 3],
        );
        kf.rotation = radVec3ToDeg(quaternionToEulerVec3(quat));
      }
    }
  }
  // Flatten: every (target, time) gets the missing TRS components
  // filled from the node's static defaults.
  const keyframes: CompleteKeyframe[] = [];
  for (const [targetKey, perTimeMap] of partial) {
    // Stable ordering: target keys in node-index order; times ascending.
    const times = [...perTimeMap.keys()].sort((a, b) => a - b);
    // Resolve node index from keyByGltfNodeIndex inverse lookup; fallback
    // to {0,0,0}/{0,0,0}/{1,1,1} if the lookup misses (shouldn't happen).
    const nodeIndex = Object.entries(keyByGltfNodeIndex).find(([, v]) => v === targetKey)?.[0];
    const node = nodeIndex !== undefined ? json.nodes[Number(nodeIndex)] : undefined;
    const defaults = node
      ? defaultTRS(node)
      : ({
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        } as Required<PartialKeyframe>);
    for (const t of times) {
      const kf = perTimeMap.get(t)!;
      keyframes.push({
        targetNodeId: targetKey,
        time: t,
        position: kf.position ?? defaults.position,
        rotation: kf.rotation ?? defaults.rotation,
        scale: kf.scale ?? defaults.scale,
      });
    }
  }
  return { duration: duration > 0 ? duration : 1, keyframes };
}

// P7.10 (#114): `findTimeSource` removed — TransformClip no longer
// declares a `time` input socket, so the importer no longer needs to
// resolve a TimeSource singleton. The `state` parameter on
// `buildGltfImportOps` is preserved for signature stability across the
// boot.ts caller; flagged unused via the underscore prefix.

export async function buildGltfImportOps(
  args: GltfImportChainArgs,
  _state: DagState,
): Promise<GltfImportChainResult> {
  // #90 — accept GLB or JSON-only `.gltf`; materialise every buffer
  // (embedded / data-URI / external via the injected resolver) before
  // reading any accessor.
  const { json, bin } = parseGltfContainer(args.buffer);
  const buffers = await resolveBuffers(json, bin, args.resolveBuffer);
  const { nodeNameMap, keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, args.assetRef);

  // Static chain ids (deterministic) — mirrors dropChain.ts:36-73 but
  // content-addressed off assetRef so re-import of the same file
  // produces identical Op stream.
  const gltfAssetId = hashId('gltf', args.assetRef);
  const transformId = hashId('tx', args.assetRef);
  const groupId = hashId('grp', args.assetRef);
  const position = args.position ?? [0, 0, 0];

  const animations = json.animations ?? [];
  const hasClips = animations.length > 0;
  // P7.10 (B13 Pass 3, #114): TransformClip no longer has a `time` input
  // socket — its value carries `.sample(seconds)` and the renderer
  // (GltfAssetR's useFrame) drives time at consumer cadence. The
  // findTimeSource() / timeId plumbing is no longer needed for the
  // animated path; left as dead code below (cleanup tracked as P7.10.x).

  const transformClipIds: string[] = animations.map((_, i) =>
    hashId('clip', args.assetRef, String(i)),
  );
  const clipSelectId = hasClips ? hashId('sel', args.assetRef) : null;

  const ops: Op[] = [];

  // P7.11 (#100, D-04) — capture per-skin bind metadata (joint keys + bind
  // TRS + IBMs + parentJointIndex, all in skin.joints[] order) so the pure
  // GltfSkeleton projection (Wave C) can build a Skeleton value from
  // GltfAsset params alone. Buffers + childHierarchy are already resolved.
  const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);

  // GltfAsset includes the deterministic nodeNameMap so the renderer
  // can match Object3D.name → DAG target id without re-deriving, plus the
  // childHierarchy (P7.7 #91) so the outliner (Wave D) can nest child rows
  // by KEY without re-walking the glTF — pure projection, not render inputs.
  // P7.11 adds the additive `skins` metadata in the SAME atomic op array
  // (K6 — one Cmd+Z); both prod callers (boot.ts, importGltf.ts) get it free.
  ops.push({
    type: 'addNode',
    nodeId: gltfAssetId,
    nodeType: 'GltfAsset',
    params: { assetRef: args.assetRef, nodeNameMap, childHierarchy, skins },
  });
  // P7.7 (#91) — one GltfChild addNode per scene child, in json.nodes
  // INTEGER-INDEX order (NOT Object.keys — that order is incidental today
  // and a future map-build change would silently reorder the Op stream,
  // breaking V22). The dagId is the SAME content-addressed id already
  // computed by buildNodeNameMap (hashId('gltfChild', assetRef, key)), so
  // re-import is byte-identical and the renderer's name lookup matches.
  // Seeded with the child's captured base TRS (defaultTRS) and overridden
  // all-false — the manual dirty flags are set later by the gizmo (Wave C).
  // These are inputless addressing satellites (R-1): NOT connected to
  // anything. Emitted in the SAME atomic ops array (K6 — one Cmd+Z),
  // BEFORE the TransformClip/ClipSelect block so the chain order is locked.
  const childNodes = json.nodes ?? [];
  for (let i = 0; i < childNodes.length; i++) {
    const key = keyByGltfNodeIndex[i];
    const dagId = nodeNameMap[key];
    const base = defaultTRS(childNodes[i]);
    ops.push({
      type: 'addNode',
      nodeId: dagId,
      nodeType: 'GltfChild',
      params: {
        assetRef: args.assetRef,
        childName: key,
        position: base.position,
        rotation: base.rotation,
        scale: base.scale,
        overridden: { position: false, rotation: false, scale: false },
      },
    });
  }
  ops.push({
    type: 'addNode',
    nodeId: transformId,
    nodeType: 'Transform',
    params: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  ops.push({
    type: 'connect',
    from: { node: gltfAssetId, socket: 'out' },
    to: { node: transformId, socket: 'target' },
  });
  ops.push({ type: 'addNode', nodeId: groupId, nodeType: 'Group', params: {} });
  ops.push({
    type: 'connect',
    from: { node: transformId, socket: 'out' },
    to: { node: groupId, socket: 'children' },
  });
  ops.push({
    type: 'connect',
    from: { node: groupId, socket: 'out' },
    to: { node: args.sceneNodeId, socket: 'children' },
  });

  if (!hasClips) {
    return {
      ops,
      gltfAssetId,
      clipSelectId: null,
      transformClipIds: [],
      nodeNameMap,
    };
  }

  // Emit one TransformClip per glTF animation, in animations[] order.
  for (let i = 0; i < animations.length; i++) {
    const anim = animations[i];
    const { duration, keyframes } = buildClipKeyframes(anim, json, buffers, keyByGltfNodeIndex);
    const name = anim.name ?? `clip_${i}`;
    ops.push({
      type: 'addNode',
      nodeId: transformClipIds[i],
      nodeType: 'TransformClip',
      params: { name, duration, loop: 'clamp', keyframes },
    });
  }

  // ClipSelect picks the first animation's name by default so a fresh
  // drop plays without user action.
  const firstName = animations[0].name ?? 'clip_0';
  ops.push({
    type: 'addNode',
    nodeId: clipSelectId!,
    nodeType: 'ClipSelect',
    params: { selectedClipName: firstName },
  });

  // Wire connects in the locked deterministic order.
  // P7.10 (#114): the Time → TransformClip connect-loop is removed —
  // TransformClip no longer declares a `time` input socket. Time enters
  // each clip via its `.sample(seconds)` method, called by GltfAssetR's
  // useFrame at consumer cadence. The TimeSource node remains in the
  // default project for save-format compatibility; it is now unused by
  // the animated-glTF chain and will be cleaned up in P7.10.x.
  for (let i = 0; i < animations.length; i++) {
    ops.push({
      type: 'connect',
      from: { node: transformClipIds[i], socket: 'out' },
      to: { node: clipSelectId!, socket: 'clips' },
      index: i,
    });
  }
  ops.push({
    type: 'connect',
    from: { node: clipSelectId!, socket: 'out' },
    to: { node: gltfAssetId, socket: 'transformClip' },
  });

  return { ops, gltfAssetId, clipSelectId, transformClipIds, nodeNameMap };
}
