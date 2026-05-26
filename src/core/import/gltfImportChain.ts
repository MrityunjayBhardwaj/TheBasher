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

import { Quaternion } from 'three';
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

function findTimeSource(state: DagState): string | null {
  for (const node of Object.values(state.nodes)) {
    if (node.type === 'TimeSource') return node.id;
  }
  return null;
}

export async function buildGltfImportOps(
  args: GltfImportChainArgs,
  state: DagState,
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
  const timeId = hasClips ? (args.timeSourceId ?? findTimeSource(state)) : null;
  if (hasClips && !timeId) {
    throw new Error(
      'No TimeSource node in DAG. Default projects seed `n_time` (PR #40); ' +
        'this project has been mutated to remove it. Add a TimeSource node ' +
        'before importing animated glTF.',
    );
  }

  const transformClipIds: string[] = animations.map((_, i) =>
    hashId('clip', args.assetRef, String(i)),
  );
  const clipSelectId = hasClips ? hashId('sel', args.assetRef) : null;

  const ops: Op[] = [];

  // GltfAsset includes the deterministic nodeNameMap so the renderer
  // can match Object3D.name → DAG target id without re-deriving, plus the
  // childHierarchy (P7.7 #91) so the outliner (Wave D) can nest child rows
  // by KEY without re-walking the glTF — pure projection, not render inputs.
  ops.push({
    type: 'addNode',
    nodeId: gltfAssetId,
    nodeType: 'GltfAsset',
    params: { assetRef: args.assetRef, nodeNameMap, childHierarchy },
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
  for (let i = 0; i < animations.length; i++) {
    ops.push({
      type: 'connect',
      from: { node: timeId!, socket: 'out' },
      to: { node: transformClipIds[i], socket: 'time' },
    });
  }
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
