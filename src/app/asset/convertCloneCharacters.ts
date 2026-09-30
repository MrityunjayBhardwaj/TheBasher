// #1216 — a saved project's clone-road characters become native when the project loads.
// #1317 — and so do its plain models: every saved clone import, skinned or not, goes through the
// same conversion; only what the load says about it differs (a character or a model).
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
//
// Once a file is read, the format stops existing (the native-import rule, decided 2026-09-13), and
// no clone road is kept alive for old projects (decided 2026-09-25, on #1205). A character saved
// while skinned files still took the clone road (`GltfAsset` + `GltfSkeleton` + one `GltfData` /
// `Object` pair per glTF node + `Group` + `TransformClip`s) therefore has to arrive on exactly the
// nodes a fresh import of the same file writes today: a Skeleton standing as its armature Object,
// the file's motion as its base pose layer, an Armature modifier on each skinned mesh.
//
// ── HOW ─────────────────────────────────────────────────────────────────────────────────────────
//
// The file is read again, twice: through the clone reader, for the import exactly as it arrived,
// and through the native reader, for what it becomes. The director's edits are the SAVED import
// minus the UNTOUCHED one, so every edit is found by structure rather than from a hand-kept list of
// kinds. Each edit is either carried onto the native nodes or named; the join between the two roads
// is the glTF node index, never a name — the clone keys its children with `sanitizeBoneName`, the
// three.js clone with PropertyBinding's spelling, the native reader with Blender's (`Bone.001`).
//
// A character with ANY edit this step cannot carry is not converted: it stays as it was saved and
// the load names the character and each edit. Nothing is converted with a loss. So is a character
// whose file is no longer in this browser's storage (the clone draws nothing without it either),
// and one the native reader refuses for a reason other than its skin — that file lands on the clone
// road on a fresh import too, and its issue is named.
//
// MOTION (slice 2). Each clone-road motion edit lands where the native tool for the same gesture
// writes it, through that tool's own op builder: a bound retarget is the bind (`bindPosedOps`: the
// chain's bottom, the base muted); a posed bone — a bone's child Object moved by hand, or a
// `PoseOverride` on a bound motion — is a member of the hand-pose layer (`handPoseOps`); the take a
// `ClipSelect` picked is the one of the file's layers and tracks left unmuted (#1154's shape). A
// value the clone road stored but did not DRAW (a component a motion overwrote, which is also what
// Revert leaves behind) is not carried: the clone showed the motion, and so does the native node.
//
// Where the two roads rank a static value against keys differently, the native road follows Blender:
// a value set under an F-curve is overwritten by it. The clone let a gizmo edit on a node the file
// animates outrank the file's keys; natively those keys play, and the load says so by name.
//
// This is not a format migration: migrations are synchronous (`migrations.ts`), and the source bytes
// live in the browser's import storage, not in the project. It runs before every hydrate of a loaded
// project (`hydrateLoadedProject`, boot.ts).
//
// REF: src/core/import/nativeGltfImport.ts (`buildNativeGltfImportOps`, `nodeIds`, `skeletons`,
//      `takes`); src/core/import/gltfImportChain.ts (`buildGltfImportOps`, `importGroupNodeIds`);
//      src/agent/mutators/builders/retarget.ts (`bindPosedOps`); poseBone.ts (`handPoseOps`);
//      src/app/bakedGltfChannels.ts@7e1356c7 + src/app/resolveGltfChildTransform.ts@7e1356c7 (what the clone draws);
//      src/core/dag/idRefSweep.ts (`remapIdRefs`); issues #1216 #1227 #1205 #1053.

import { applyOp } from '../../core/dag/ops';
import { getNodeType } from '../../core/dag/registry';
import type { DagState } from '../../core/dag/state';
import type { InputBinding, Node, NodeRef, Op } from '../../core/dag/types';
import { refIdsAt, remapIdRefs } from '../../core/dag/idRefSweep';
import { parseGltfContainer } from '../../core/import/glb';
import {
  buildGltfImportOps,
  gltfSkeletonDagId,
  hashId,
  importGroupNodeIds,
} from '../../core/import/gltfImportChain';
import {
  buildNativeGltfImportOps,
  type NativeImportRefusal,
  type NativeImportResult,
} from '../../core/import/nativeGltfImport';
import { resolveBoneNames } from '../../core/import/retarget';
import { quatFromEulerXYZ } from '../../nodes/bonePose';
import type { BoneSpec, RotationModeFields, Vec3 } from '../../nodes/types';
import { KeyframeChannelVec3Params } from '../../nodes/KeyframeChannelVec3';
import { bindPosedOps } from '../../agent/mutators/builders/retarget';
import { handPoseOps } from '../../agent/mutators/builders/poseBone';
import { resolveChannelAddress } from '../../agent/mutators/builders/channelAddress';
import { boundClipsForAsset } from '../animate/boundClipsForAsset';
import { edgeTarget, type GraphNodeLike } from '../animate/graphNodes';
import { handPoseLayerOf, overrideChain } from '../animate/poseChain';
import { nodeDisplayName } from '../sceneTreeWalk';
import { rotationModeOps } from '../resolvedRotation';
import { opfsSiblingPath } from './opfsGltfResolver';
import type { Project } from '../../core/project/schema';
import { writeProjectImage } from '../../core/project/projectImages';
import type { StorageCapability } from '../../core/storage';
import type { DecodeDraco } from '../../core/import/gltfDraco';
import { decodeDracoInBrowser } from './dracoDecoder';

export interface ConvertCloneCharactersDeps {
  /** The bytes at a storage path; throws when there is no file there. */
  readonly read: (path: string) => Promise<Uint8Array>;
  /** Store an image in THIS project's image folder and return its key (#1050). */
  readonly storeImage: (bytes: Uint8Array, mime: string) => Promise<string>;
  /** #1063 — decode a Draco-compressed primitive, so a compressed character converts natively. */
  readonly decodeDraco?: DecodeDraco;
}

/**
 * #1317 — what a saved clone import was: a `character` (its file carries a skin) or a plain `model`.
 * Both convert the same way; only what the load says about them differs.
 */
export type CloneImportKind = 'character' | 'model';

export interface CharacterConversionReport {
  /** A converted import, and what now plays differently from the clone road, by name (may be empty). */
  readonly converted: readonly {
    readonly kind: CloneImportKind;
    readonly name: string;
    readonly assetRef: string;
    readonly notes: readonly string[];
  }[];
  /** An import left as it was saved, and why — each edit it could not carry, by name. */
  readonly kept: readonly {
    readonly kind: CloneImportKind;
    readonly name: string;
    readonly assetRef: string;
    readonly why: readonly string[];
  }[];
}

/**
 * Every saved clone-road import, with or without a skin. #1317 — this was characters only, which
 * left a saved plain model on a road that #1053 retires, with nothing to turn it native.
 */
export function cloneImportAssets(state: DagState): readonly Node[] {
  return Object.values(state.nodes).filter((node) => node.type === 'GltfAsset');
}

const kindOf = (asset: Node): CloneImportKind =>
  ((asset.params as { skins?: readonly unknown[] }).skins?.length ?? 0) > 0 ? 'character' : 'model';

/**
 * Every clone-road character in `state`, converted to the native structure where it can be, and
 * the report of what happened to each. Returns `state` itself when there is nothing to convert.
 */
export async function convertCloneCharacters(
  state: DagState,
  deps: ConvertCloneCharactersDeps,
): Promise<{ readonly state: DagState; readonly report: CharacterConversionReport }> {
  const converted: CharacterConversionReport['converted'][number][] = [];
  const kept: CharacterConversionReport['kept'][number][] = [];
  let next = state;
  for (const asset of cloneImportAssets(state)) {
    const assetRef = (asset.params as { assetRef: string }).assetRef;
    const kind = kindOf(asset);
    const name = characterName(next, assetRef);
    // A conversion that throws (a corrupt file, an op the reducer refuses) keeps the character as
    // saved and says why: converting must never be the reason a project does not open.
    const one = await convertOne(next, assetRef, deps).catch((err: unknown) => ({
      why: [`it could not be converted (${err instanceof Error ? err.message : String(err)})`],
    }));
    if ('why' in one) kept.push({ kind, name, assetRef, why: one.why });
    else {
      next = one.state;
      converted.push({ kind, name, assetRef, notes: one.notes });
    }
  }
  return { state: next, report: { converted, kept } };
}

/** The name a director knows the character by: its import Group's, else the file's. */
function characterName(state: DagState, assetRef: string): string {
  const named = state.nodes[hashId('grp', assetRef)]?.meta?.name;
  return named || (assetRef.split('/').filter(Boolean).pop() ?? assetRef);
}

async function convertOne(
  state: DagState,
  assetRef: string,
  deps: ConvertCloneCharactersDeps,
): Promise<{ state: DagState; notes: string[] } | { why: string[] }> {
  const sceneId = state.outputs.scene?.node;
  if (!sceneId || !state.nodes[sceneId])
    return { why: ['the project has no scene to place it in'] };

  let bytes: Uint8Array;
  try {
    bytes = await deps.read(assetRef);
  } catch {
    return { why: [`its file (${assetRef}) is no longer in this browser's storage`] };
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const args = {
    buffer: copy.buffer,
    assetRef,
    sceneNodeId: sceneId,
    resolveBuffer: (uri: string) => deps.read(opfsSiblingPath(assetRef, uri)),
    storeImage: deps.storeImage,
    decodeDraco: deps.decodeDraco,
  };

  // The import exactly as the clone road wrote it, applied on its own beside a bare scene.
  const untouched = await buildGltfImportOps(args, { nodes: {}, outputs: {} });
  let pristine: DagState = {
    nodes: { [sceneId]: { ...state.nodes[sceneId], inputs: {} } },
    outputs: {},
  };
  for (const op of untouched.ops) pristine = applyOp(pristine, op).next;

  const json = parseGltfContainer(copy.buffer).json as GltfShape;
  const plan = planEdits(state, pristine, sceneId, untouched.gltfAssetId, assetRef, json);
  if (plan.why.length > 0) return { why: plan.why };

  // Only now the native build: it writes the file's images into the project, and a character that
  // is kept must leave nothing behind.
  let native: NativeImportResult | NativeImportRefusal;
  try {
    native = await buildNativeGltfImportOps(args);
  } catch (err) {
    return { why: [`the native reader could not read it (${(err as Error).message})`] };
  }
  if ('refused' in native)
    return { why: [`the native reader refuses it: ${native.refused} (${native.issue})`] };

  const idMap = new Map<string, string>([[hashId('grp', assetRef), native.groupId]]);
  for (const [cloneId, index] of plan.childIndex) {
    const nativeId = native.nodeIds[index];
    if (nativeId) idMap.set(cloneId, nativeId);
  }
  // Each child's data node names the native mesh data of the same node.
  for (const [cloneId, index] of plan.dataIndex) {
    const mesh = native.meshes[index];
    if (mesh) idMap.set(cloneId, mesh.dataId);
  }
  // Each skin's rig names the skeleton of the armature that skin binds to.
  native.skinSkeleton.forEach((skeleton, skin) => {
    const nativeSkeleton = native.skeletons[skeleton];
    if (nativeSkeleton) idMap.set(gltfSkeletonDagId(assetRef, skin), nativeSkeleton.skeletonId);
  });

  // 1. The clone import leaves, and with it every clone-road pose the members below replace.
  const leaving = new Set([...plan.footprint, ...plan.motion.leaving]);
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(state.nodes)) if (!leaving.has(id)) nodes[id] = node;
  let next: DagState = { ...state, nodes };

  // 2. The native import arrives — without its edge into the scene: the saved Group's own consumer
  //    edge is re-pointed instead, so the character keeps its parent and its place among siblings.
  for (const op of native.ops) {
    if (
      op.type === 'connect' &&
      op.from.node === native.groupId &&
      op.to.node === sceneId &&
      op.to.socket === 'children'
    )
      continue;
    next = applyOp(next, op).next;
  }

  // 3. Everything outside that named the clone names its native counterpart.
  const remap = (id: string): string => idMap.get(id) ?? id;
  const remapped: Record<string, Node> = { ...next.nodes };
  for (const id of plan.referrers) {
    const node = remapped[id];
    if (!node) continue;
    remapped[id] = {
      ...node,
      inputs: remapInputs(node.inputs, remap),
      params: remapIdRefs(node, remap),
    };
  }
  next = { ...next, nodes: remapped };
  for (const [nodeId, input] of plan.addedInputs) {
    for (const ref of input.refs) {
      next = applyOp(next, {
        type: 'connect',
        from: { node: ref.node, socket: ref.socket },
        to: { node: remap(nodeId), socket: input.socket },
      }).next;
    }
  }

  // 4. The director's edits, onto the native nodes.
  for (const op of plan.edits(remap)) next = applyOp(next, op).next;

  // 5. The motion: binds, hand-poses, and which of the file's animations plays.
  next = plan.motion.apply(next, native);

  // 6. The materials: the leaves the director changed, and the per-slot materials an Object holds.
  next = plan.materials(next, native);
  return { state: next, notes: plan.notes };
}

function remapInputs(inputs: Node['inputs'], remap: (id: string) => string): Node['inputs'] {
  const out: Record<string, InputBinding> = {};
  for (const [socket, binding] of Object.entries(inputs)) {
    out[socket] = Array.isArray(binding)
      ? binding.map((ref) => ({ ...ref, node: remap(ref.node) }))
      : { ...binding, node: remap(binding.node) };
  }
  return out;
}

function refsOf(binding: InputBinding | undefined): NodeRef[] {
  if (!binding) return [];
  return Array.isArray(binding) ? binding : [binding];
}

const sameRef = (a: NodeRef, b: NodeRef): boolean => a.node === b.node && a.socket === b.socket;

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The parts of the glTF document the plan reads. */
interface GltfShape {
  nodes?: { skin?: number }[];
  skins?: { joints: number[] }[];
  animations?: {
    name?: string;
    channels: { target: { node?: number; path: string } }[];
  }[];
}

type Component = 'position' | 'rotation' | 'scale';
const COMPONENTS: readonly Component[] = ['position', 'rotation', 'scale'];
/** glTF's channel path for each component. */
const GLTF_PATH: Record<Component, string> = {
  position: 'translation',
  rotation: 'rotation',
  scale: 'scale',
};

/** One bone's pose, in the clone's units (euler degrees in the codebase's order). */
type BonePose = { position?: Vec3; rotation?: Vec3; scale?: Vec3 };

interface EditPlan {
  /** Every edit this step cannot carry, by name. Non-empty ⇒ the character is kept. */
  readonly why: string[];
  /** What plays differently once converted, by name — carried, and said. */
  readonly notes: string[];
  /** The clone import's node ids, all of which leave. */
  readonly footprint: readonly string[];
  /** Clone child Object id → the glTF node index it stands for. */
  readonly childIndex: ReadonlyMap<string, number>;
  /** Nodes outside the import that name one of its nodes, by edge or by id. */
  readonly referrers: readonly string[];
  /** Edges the director added INTO an import node from outside it, to re-add on the native node. */
  readonly addedInputs: readonly (readonly [string, { socket: string; refs: NodeRef[] }])[];
  /** The director's param/meta edits as ops, once the id map is known. */
  readonly edits: (remap: (id: string) => string) => Op[];
  readonly motion: MotionPlan;
  /** Clone data node id → the glTF node index its mesh stands for. */
  readonly dataIndex: ReadonlyMap<string, number>;
  /** The director's material edits, onto the native mesh data and Objects. */
  readonly materials: (state: DagState, native: NativeImportResult) => DagState;
}

interface MotionPlan {
  /** Clone-road pose nodes (`PoseOverride`s) whose pose the native members carry instead. */
  readonly leaving: readonly string[];
  /** The motion edits, written through the native tools' own op builders, in the native graph. */
  readonly apply: (state: DagState, native: NativeImportResult) => DagState;
}

function planEdits(
  state: DagState,
  pristine: DagState,
  sceneId: string,
  assetId: string,
  assetRef: string,
  json: GltfShape,
): EditPlan {
  const why: string[] = [];
  const notes: string[] = [];
  const saved = importGroupNodeIds(assetRef, state);
  const footprint = new Set(saved);
  const untouchedIds = Object.keys(pristine.nodes).filter((id) => id !== sceneId);
  // A node with an empty name (a retarget bound without one) is named by its id: a notice must
  // name something the director can find.
  const label = (id: string): string => `"${nodeDisplayName(state.nodes, id) || id}"`;
  const graph = state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;

  for (const id of untouchedIds) {
    if (!state.nodes[id]) why.push(`${label(id)} was deleted from the import`);
  }
  for (const id of saved) {
    if (!pristine.nodes[id]) why.push(`${label(id)} is not part of the file as it reads today`);
  }

  // The glTF node index each clone child Object stands for — the one join the roads share.
  const assetParams = pristine.nodes[assetId]?.params as
    | {
        keyByGltfNodeIndex?: Record<number, string>;
        nodeNameMap?: Record<string, string>;
        skins?: { jointKeys?: string[] }[];
      }
    | undefined;
  const keyByIndex = assetParams?.keyByGltfNodeIndex ?? {};
  const nodeNameMap = assetParams?.nodeNameMap ?? {};
  const indexOfKey = new Map<string, number>();
  const childIndex = new Map<string, number>();
  for (const [index, key] of Object.entries(keyByIndex)) {
    indexOfKey.set(key, Number(index));
    const objectId = nodeNameMap[key];
    if (objectId) childIndex.set(objectId, Number(index));
  }
  const skinOfBone = new Map<number, number>();
  (json.skins ?? []).forEach((skin, s) => {
    for (const joint of skin.joints) if (!skinOfBone.has(joint)) skinOfBone.set(joint, s);
  });
  const groupId = hashId('grp', assetRef);

  // ── Which of the file's animations plays: the take the saved ClipSelect picks, by index. ──────
  // The clone names each TransformClip after its animation (`anim.name ?? clip_<i>`); the native
  // reader makes names unique as Blender does. So the take is joined by INDEX: the first clip whose
  // name the selector matches, as `ClipSelect.evaluate` picks it. -1 when it matches none (the clone
  // then plays no clip at all).
  const clipIds = untouchedIds
    .filter((id) => pristine.nodes[id].type === 'TransformClip')
    .sort((a, b) => clipIndexOf(assetRef, a, pristine) - clipIndexOf(assetRef, b, pristine));
  const selectId = hashId('sel', assetRef);
  const selected = (state.nodes[selectId]?.params as { selectedClipName?: string } | undefined)
    ?.selectedClipName;
  const playing =
    clipIds.length === 0
      ? -1
      : clipIds.findIndex(
          (id) => (pristine.nodes[id].params as { name?: string }).name === selected,
        );
  /** The file's playing animation keys node `index` — any component, or the one named. */
  const playingKeys = (index: number, component?: Component): boolean =>
    playing >= 0 &&
    (json.animations?.[playing]?.channels ?? []).some(
      (c) =>
        c.target.node === index &&
        (component === undefined || c.target.path === GLTF_PATH[component]),
    );

  // ── Motion bound to the rigs: what the clone plays, in its own order (active first, then id). ──
  const bound = boundClipsForAsset(graph, assetRef);
  const boundBySkin = new Map<number, typeof bound>();
  for (const clip of bound) {
    const skeleton = edgeTarget(graph[clip.clipId], 'skeleton');
    const skin = (state.nodes[skeleton ?? '']?.params as { skinIndex?: number } | undefined)
      ?.skinIndex;
    if (typeof skin !== 'number') continue;
    boundBySkin.set(skin, [...(boundBySkin.get(skin) ?? []), clip]);
  }
  /** The glTF nodes (bones) a bound clip keys, through its skin's joint keys. */
  const bonesKeyedBy = (clip: (typeof bound)[number]): Set<number> =>
    new Set(
      (clip.params.keyframes ?? [])
        .map((k) => indexOfKey.get(clip.jointKeys[(k as { bone: number }).bone]))
        .filter((i): i is number => i !== undefined),
    );
  const boundBones = new Set<number>();
  for (const [skin, clips] of boundBySkin) {
    const first = clips[0];
    const firstBones = bonesKeyedBy(first);
    firstBones.forEach((b) => boundBones.add(b));
    // Natively one motion plays a rig. The clone let a second bound clip fill the bones the first
    // does not key; carrying only the first would silently drop those.
    for (const other of clips.slice(1)) {
      const extra = [...bonesKeyedBy(other)].filter((b) => !firstBones.has(b));
      if (extra.length > 0) {
        why.push(
          `${label(other.clipId)} also plays on this character (${extra
            .map((b) => `"${keyByIndex[b]}"`)
            .join(', ')}), and a native character plays one bound motion`,
        );
      }
    }
    if (playing > 0) {
      why.push(
        `the file's animation ${label(clipIds[playing])} plays beside the bound ${label(first.clipId)}, and natively a bound motion replaces the file's`,
      );
    }
    // A bind mutes the file's own motion (Blender swaps the action): a bone the file moves and the
    // bound motion does not now rests. Said, not refused — it is what binding natively does.
    const resting = (json.skins?.[skin]?.joints ?? []).filter(
      (b) => playingKeys(b) && !firstBones.has(b),
    );
    if (resting.length > 0) {
      notes.push(
        `the file's own animation no longer plays under the bound ${label(first.clipId)} (${resting
          .map((b) => `"${keyByIndex[b]}"`)
          .join(', ')} now rest), as binding a motion does natively`,
      );
    }
  }
  /** A bone something plays — the file's take or a bound motion — so its static value is not drawn. */
  const movedByMotion = (index: number): boolean => playingKeys(index) || boundBones.has(index);

  // A child Object that is a plain node of the file carries its edits; a skinned mesh stands at
  // identity under its armature natively, so it does not.
  const carryable = (id: string): string | null => {
    const index = childIndex.get(id);
    if (index === undefined) return 'is not a node of the file';
    if (skinOfBone.has(index)) return 'is a bone, which has no node of its own natively';
    if (typeof json.nodes?.[index]?.skin === 'number') return 'is a skinned mesh';
    return null;
  };

  // ── Materials: each child's data node, joined to the native mesh data by the same node index. ──
  const dataIndex = new Map<string, number>();
  for (const [objectId, index] of childIndex) {
    const data = edgeTarget(
      (pristine.nodes as unknown as Readonly<Record<string, GraphNodeLike>>)[objectId],
      'data',
    );
    if (data !== null && pristine.nodes[data]?.type === 'GltfData') dataIndex.set(data, index);
  }
  /** Per mesh node, the material leaves the director changed on its data, as setParam paths. */
  const materialEdits: { index: number; label: string; leaves: MaterialLeaf[]; slots: number }[] =
    [];
  /** Per mesh node, the per-slot materials its Object holds (`slotOverrides`), whole. */
  const slotOverrideEdits: { index: number; label: string; value: unknown; slots: number }[] = [];
  /** How many material slots the clone numbered on a mesh node's data (one when it holds no table). */
  const cloneSlots = (dataId: string | null): number => {
    const p = (dataId ? pristine.nodes[dataId]?.params : undefined) as
      | { materialSlots?: unknown[] }
      | undefined;
    return p?.materialSlots?.length ?? 1;
  };

  const editOps: ((remap: (id: string) => string) => Op[])[] = [];
  const addedInputs: [string, { socket: string; refs: NodeRef[] }][] = [];
  /** Per bone (glTF node), the pose its child Object drew with an explicit override (wins) and without. */
  const boneObjectPose = new Map<number, { forced: BonePose; plain: BonePose }>();

  for (const id of untouchedIds) {
    const was = pristine.nodes[id];
    const now = state.nodes[id];
    if (!now) continue;
    // Edges into the import node: the file's own must still be there; one the director added from
    // outside the import is carried to the native node when the node carries.
    for (const socket of new Set([...Object.keys(was.inputs), ...Object.keys(now.inputs)])) {
      const before = refsOf(was.inputs[socket]);
      const after = refsOf(now.inputs[socket]);
      if (before.some((ref) => !after.some((r) => sameRef(r, ref)))) {
        why.push(`${label(id)} lost its "${socket}" input`);
        continue;
      }
      const added = after.filter((ref) => !before.some((r) => sameRef(r, ref)));
      if (added.length === 0) continue;
      if (added.some((ref) => footprint.has(ref.node))) {
        why.push(`${label(id)} was rewired inside the import ("${socket}")`);
      } else if (id === groupId || carryable(id) === null) {
        addedInputs.push([id, { socket, refs: added }]);
      } else {
        why.push(`${label(id)} takes a "${socket}" input the native structure has no place for`);
      }
    }
    if (!deepEqual(was.spare, now.spare)) why.push(`${label(id)} has spare parameters`);
    const metaChanged = !deepEqual(was.meta?.name, now.meta?.name);
    const hiddenChanged = !!was.meta?.hidden !== !!now.meta?.hidden;
    const params = now.params as Record<string, unknown>;
    const fields = Object.keys({ ...(was.params as object), ...params }).filter(
      (field) => !deepEqual((was.params as Record<string, unknown>)[field], params[field]),
    );
    if (fields.length === 0 && !metaChanged && !hiddenChanged) continue;

    if (id === groupId) {
      editOps.push((remap) => [
        ...fields.map(
          (field): Op => ({
            type: 'setParam',
            nodeId: remap(id),
            paramPath: field,
            value: params[field],
          }),
        ),
        ...metaOps(remap(id), now, metaChanged, hiddenChanged),
      ]);
      continue;
    }
    // The take the director picked is carried as mutes (below); any other clip-selector edit is not.
    if (
      id === selectId &&
      !metaChanged &&
      !hiddenChanged &&
      fields.every((f) => f === 'selectedClipName')
    )
      continue;

    if (now.type === 'Object') {
      const index = childIndex.get(id);
      // A per-slot material the director gave the mesh Object (`setObjectSlotMaterial`): the same
      // record on the native Object drawing that mesh, skinned or not — it is not a transform.
      if (
        index !== undefined &&
        typeof json.nodes?.[index] === 'object' &&
        (json.nodes[index] as { mesh?: number }).mesh !== undefined &&
        fields.includes('slotOverrides')
      ) {
        const withMaps = Object.entries((params.slotOverrides ?? {}) as Record<string, unknown>)
          .filter(([, m]) => materialHasMaps(m))
          .map(([slot]) => slot);
        if (withMaps.length > 0) {
          why.push(
            `${label(id)}'s material for slot ${withMaps.join(', ')} holds a texture, which the old structure stored elsewhere`,
          );
          continue;
        }
        slotOverrideEdits.push({
          index,
          label: label(id),
          value: params.slotOverrides,
          slots: cloneSlots(edgeTarget(graph[id], 'data')),
        });
        fields.splice(fields.indexOf('slotOverrides'), 1);
        if (fields.length === 0 && !metaChanged && !hiddenChanged) continue;
      }
      const unknown = fields.filter(
        (f) => !['position', 'rotation', 'scale', 'overridden'].includes(f),
      );
      const refusal = carryable(id);
      const isBone = index !== undefined && skinOfBone.has(index);
      if (refusal !== null && !isBone) {
        const what = fields.length > 0 ? 'was moved' : metaChanged ? 'was renamed' : 'was hidden';
        why.push(`${label(id)} ${what}, and it ${refusal}`);
        continue;
      }
      if (unknown.length > 0) {
        why.push(`${label(id)} has edited ${unknown.join(', ')}`);
        continue;
      }
      if (isBone && (metaChanged || hiddenChanged)) {
        why.push(`${label(id)} was ${metaChanged ? 'renamed' : 'hidden'}, and it ${refusal}`);
        continue;
      }
      // What the clone DREW for each component (`resolveGltfChildTrs`): the Object's value when its
      // `overridden` bit is set, or when nothing plays the node; otherwise the motion, and the
      // stored value is dormant.
      const overridden = (params.overridden ?? {}) as Partial<Record<Component, boolean>>;
      const moved = isBone ? movedByMotion(index!) : playingKeys(index!);
      const drawn = COMPONENTS.filter(
        (c) =>
          (fields.includes(c) || (fields.includes('overridden') && overridden[c] === true)) &&
          (overridden[c] === true || !moved),
      );
      if (isBone) {
        const pose = { forced: {} as BonePose, plain: {} as BonePose };
        for (const c of drawn) {
          (overridden[c] === true ? pose.forced : pose.plain)[c] = params[c] as Vec3;
        }
        if (drawn.length > 0) boneObjectPose.set(index!, pose);
        continue;
      }
      // Blender: a value set under an F-curve is overwritten by it. The clone let the gizmo win.
      const underKeys = drawn.filter((c) => playingKeys(index!, c));
      if (underKeys.length > 0) {
        notes.push(
          `the file's animation now plays ${label(id)}'s ${underKeys.join(', ')} over the value it was moved to, as a value set under an F-curve is in Blender`,
        );
      }
      editOps.push((remap) => [
        ...objectTransformOps(remap(id), drawn, params),
        ...metaOps(remap(id), now, metaChanged, hiddenChanged),
      ]);
      continue;
    }
    if (now.type === 'GltfData' && dataIndex.has(id) && !metaChanged && !hiddenChanged) {
      const other = fields.filter((f) => f !== 'material' && f !== 'materialSlots');
      if (other.length > 0) {
        why.push(`${label(id)} has edited ${other.join(', ')}`);
        continue;
      }
      const before = was.params as Record<string, unknown>;
      const leaves = [
        ...materialLeaves(before.material, params.material, 'material'),
        ...materialLeaves(before.materialSlots, params.materialSlots, 'materialSlots'),
      ];
      const unmappable = leaves.filter(
        (leaf) => leaf.value === undefined || /(^|\.)maps(\.|$)/.test(leaf.path),
      );
      if (unmappable.length > 0) {
        why.push(
          `${label(id)}'s material has ${unmappable
            .map((leaf) => leaf.path)
            .join(
              ', ',
            )} edited, a texture or a removed field the native material cannot take as it is`,
        );
        continue;
      }
      materialEdits.push({
        index: dataIndex.get(id)!,
        label: label(id),
        leaves,
        slots: cloneSlots(id),
      });
      continue;
    }
    why.push(
      `${label(id)} (${now.type}) has edits this step does not carry yet: ${[
        ...fields,
        ...(metaChanged ? ['name'] : []),
        ...(hiddenChanged ? ['hidden'] : []),
      ].join(', ')}`,
    );
  }

  // ── Hand-poses on bound motions: the clone's `PoseOverride` chains. ────────────────────────────
  // The clone drew every override reaching a bound clip (its pose band, retired with the clone
  // road's character half, #1053), a bone's first by sorted id winning per component; each becomes
  // the same bone's member in the hand-pose layer.
  const overrideIds = new Set<string>();
  for (const clip of bound) {
    for (const o of overrideChain(graph, clip.clipId)) overrideIds.add(o.id);
  }
  const overridePose = new Map<number, BonePose>();
  for (const id of [...overrideIds].sort()) {
    const p = state.nodes[id].params as {
      bone?: string;
      position?: Vec3;
      rotation?: Vec3;
      overridden?: { position?: boolean; rotation?: boolean };
    };
    const index = p.bone !== undefined ? indexOfKey.get(p.bone) : undefined;
    if (index === undefined || !skinOfBone.has(index) || !(p.bone! in nodeNameMap)) {
      notes.push(`${label(id)} posed no bone of this character, and is removed`);
      continue;
    }
    const pose = overridePose.get(index) ?? {};
    if (p.overridden?.position === true && p.position) pose.position ??= p.position;
    if (p.overridden?.rotation === true && p.rotation) pose.rotation ??= p.rotation;
    overridePose.set(index, pose);
  }
  // ── Keys edited on a bone: the clone's per-bone channels (copy-on-write of a clip, or seeded). ──
  // A channel belongs to a bone of this character by the clone's own test (`bakedGltfChannels`:
  // its `childName` names a node of the asset and its `target` is that node's Object). The clone
  // drew it over every motion and every pose on that component, under only the bone Object's own
  // forced value; natively it is a curve in the hand-pose layer, which sits above them all.
  const boneChannels: { id: string; index: number; component: Component }[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'KeyframeChannelVec3') continue;
    const p = node.params as {
      assetRef?: unknown;
      childName?: unknown;
      target?: unknown;
      paramPath?: unknown;
    };
    if (p.assetRef !== assetRef || typeof p.childName !== 'string') continue;
    const index = indexOfKey.get(p.childName);
    if (index === undefined || !skinOfBone.has(index)) continue;
    if (nodeNameMap[p.childName] !== p.target) continue;
    if (p.paramPath !== 'position' && p.paramPath !== 'rotation' && p.paramPath !== 'scale')
      continue;
    boneChannels.push({ id: node.id, index, component: p.paramPath });
  }
  // ── Keys edited on a node of the file that is not a bone (#1263): the same channels, on an Object. ─
  // The clone drew such a channel over the file's clip on that component, under only the Object's
  // own forced value. Natively the node's curve for the component is where its keys live: the file's
  // `<node>_<param>_channel`, rewritten in place (the take lists name it by that id). Rotation is
  // the clone's XYZ euler degrees, sampled axis by axis; the native node is in quaternion mode and
  // its curve slerps, so the node switches to euler mode (the inspector's switch) and the curve keys
  // `rotation` — the clone's own curve, drawn by the same sampler. The file's quaternion curve stays
  // on it and composes nothing, as a quaternion F-curve on an euler-mode object does in Blender.
  const objectChannels: {
    id: string;
    index: number;
    target: string;
    component: Component;
    forced: boolean;
  }[] = [];
  /** Such channels that keep the character as saved: named once, here, not again as referrers. */
  const refusedChannels: string[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'KeyframeChannelVec3') continue;
    const p = node.params as {
      assetRef?: unknown;
      childName?: unknown;
      target?: unknown;
      paramPath?: unknown;
    };
    if (p.assetRef !== assetRef || typeof p.childName !== 'string') continue;
    const index = indexOfKey.get(p.childName);
    if (index === undefined || skinOfBone.has(index)) continue;
    if (typeof p.target !== 'string' || nodeNameMap[p.childName] !== p.target) continue;
    if (p.paramPath !== 'position' && p.paramPath !== 'rotation' && p.paramPath !== 'scale')
      continue;
    const refusal = carryable(p.target);
    if (refusal !== null) {
      why.push(`${label(node.id)} keys ${label(p.target)}, which ${refusal}`);
      refusedChannels.push(node.id);
      continue;
    }
    // The native curve rewritten is the FIRST animation's; with another take playing it is muted.
    // A file with no animation has no takes to mute (`playing` is -1 there too).
    if (clipIds.length > 0 && playing !== 0) {
      why.push(
        `${label(node.id)} keys ${label(p.target)} while ${
          playing > 0
            ? `the file's animation ${label(clipIds[playing])}`
            : 'none of the file’s animations'
        } plays, and natively those keys live in the first animation's curve`,
      );
      refusedChannels.push(node.id);
      continue;
    }
    const overridden = (
      state.nodes[p.target]?.params as { overridden?: Partial<Record<Component, boolean>> }
    )?.overridden;
    objectChannels.push({
      id: node.id,
      index,
      target: p.target,
      component: p.paramPath,
      forced: overridden?.[p.paramPath] === true,
    });
  }
  const channelIds = new Set([
    ...[...boneChannels, ...objectChannels].map((c) => c.id),
    ...refusedChannels,
  ]);
  // The clone's bone band samples keys, extend and modifiers only; a curve in a layer honours its
  // mute and weight, and has no solo (an F-curve has none in Blender). Said, not refused.
  for (const { id } of [...boneChannels, ...objectChannels.filter((c) => !c.forced)]) {
    // Read through the channel's own schema, typed: a curve's flags, not an operator's bypass.
    const parsed = KeyframeChannelVec3Params.safeParse(state.nodes[id].params);
    if (!parsed.success) continue;
    const p = parsed.data;
    const now: string[] = [];
    if (p.mute === true) now.push('muted');
    if (p.weight !== 1) now.push(`weighted ${p.weight}`);
    if (p.blendMode !== 'replace') now.push(`blended by ${p.blendMode}`);
    if (now.length > 0) {
      notes.push(
        `${label(id)} is now ${now.join(' and ')} as it is marked (the old structure drew it regardless)`,
      );
    }
    if (p.solo === true) notes.push(`${label(id)} was soloed; a curve in a pose layer has no solo`);
  }

  // An override leaves only when nothing but its own chain reads it. (A channel needs no such check:
  // no node takes a `KeyframeChannel` input, so nothing can read one through an edge.)
  for (const node of Object.values(state.nodes)) {
    if (overrideIds.has(node.id) && node.type === 'PoseOverride') continue;
    for (const [socket, binding] of Object.entries(node.inputs)) {
      for (const ref of refsOf(binding)) {
        if (overrideIds.has(ref.node)) {
          why.push(`${label(node.id)} reads the pose ${label(ref.node)} through "${socket}"`);
        }
      }
    }
  }
  for (const [output, ref] of Object.entries(state.outputs)) {
    if (overrideIds.has(ref.node))
      why.push(`the project's "${output}" output is ${label(ref.node)}`);
  }

  // ── Everything outside the import that names one of its nodes. ────────────────────────────────
  const referrers: string[] = [];
  const isRig = (id: string): boolean => state.nodes[id]?.type === 'GltfSkeleton';
  const mappable = (id: string): boolean =>
    id === groupId || (childIndex.has(id) && carryable(id) === null) || dataIndex.has(id);
  const retargets = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    if (footprint.has(node.id) || channelIds.has(node.id)) continue;
    let names = false;
    for (const [socket, binding] of Object.entries(node.inputs)) {
      for (const ref of refsOf(binding)) {
        if (!footprint.has(ref.node)) continue;
        names = true;
        // A retarget's rig becomes the native skeleton: the bind the retarget mutator writes.
        if (isRig(ref.node) && node.type === 'RetargetClip' && socket === 'skeleton') {
          retargets.add(node.id);
          continue;
        }
        if (!mappable(ref.node))
          why.push(`${label(node.id)} reads ${label(ref.node)} through "${socket}"`);
      }
    }
    for (const ref of getNodeType(node.type)?.idRefs ?? []) {
      for (const target of refIdsAt(node.params, ref.path, ref.shape)) {
        if (!footprint.has(target)) continue;
        names = true;
        if (!mappable(target)) why.push(`${label(node.id)} names ${label(target)} (${ref.path})`);
        const keyed = (node.params as { paramPath?: unknown }).paramPath;
        // A channel on a child's data keys its material: the native mesh data holds the same
        // material, at the same path. Nothing else of the data node has a native counterpart.
        if (dataIndex.has(target)) {
          if (typeof keyed !== 'string' || !keyed.startsWith('material.')) {
            why.push(
              `${label(node.id)} keys "${String(keyed)}" of ${label(target)}, which has no native counterpart`,
            );
          }
          continue;
        }
        if (target === groupId || ref.role !== 'subject') continue;
        // Nothing that names a child by id as its subject ever moved it on the clone: the clone
        // draws a child from its own params and the curves that name it by `childName`
        // (`bakedGltfChannels`), and nothing else (#1265, #1267, #1269 — measured for a curve, a
        // driver, a Track-To, a Follow-Path and a strip). Natively each would act, so each comes
        // across bypassed, by its own flag: kept, and still moving nothing. The node stays in
        // quaternion mode, so an unmuted rotation curve or driver turns nothing either, as an
        // euler F-curve on a quaternion-mode object does in Blender.
        const acts = subjectActs(node.type, keyed);
        if (acts !== null) {
          const { flag, says } = acts;
          // Read through the node's own schema, typed: its declared flag, not a cast.
          const parsed = getNodeType(node.type)?.paramSchema.safeParse(node.params);
          if (!(parsed?.success && (parsed.data as Record<string, unknown>)[flag] === true)) {
            editOps.push(() => [
              { type: 'setParam', nodeId: node.id, paramPath: flag, value: true },
            ]);
            notes.push(
              `${label(node.id)} ${says} ${label(target)}, which the old structure never drew; it is kept muted`,
            );
          }
          continue;
        }
        // Anything else keying a child (a param other than its transform, or a curve of another
        // type): what the clone drew of it is not measured, so the character is kept.
        why.push(
          `${label(node.id)} keys "${String(keyed)}" of ${label(target)}, which the converter does not carry`,
        );
      }
    }
    if ((node.params as { assetRef?: unknown } | undefined)?.assetRef === assetRef) {
      why.push(`${label(node.id)} (${node.type}) edits the file's own data by name`);
    }
    if (names) referrers.push(node.id);
  }
  for (const [output, ref] of Object.entries(state.outputs)) {
    if (footprint.has(ref.node)) why.push(`the project's "${output}" output is ${label(ref.node)}`);
  }

  // A retarget's bone map names the rig's bones in the clone's spelling; natively they are the
  // skeleton's. A map another rig's retarget also reads cannot be re-spelled for this one alone.
  const maps = new Map<string, string>();
  for (const id of retargets) {
    const map = edgeTarget(graph[id], 'boneMap');
    if (map !== null) maps.set(map, id);
  }
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'RetargetClip' || retargets.has(node.id)) continue;
    const map = edgeTarget(graph[node.id], 'boneMap');
    if (map !== null && maps.has(map)) {
      why.push(
        `${label(map)} maps bones for ${label(node.id)} too, a rig this conversion does not touch`,
      );
    }
  }

  const motion: MotionPlan = {
    leaving: [...overrideIds, ...channelIds],
    apply: (initial, native) => {
      let next = initial;
      const run = (ops: readonly Op[]): void => {
        for (const op of ops) next = applyOp(next, op).next;
      };
      /** The native bone name for glTF node `index`, and the armature Object that stands it. */
      const boneAt = (index: number): { objectId: string; name: string } | null => {
        const skin = skinOfBone.get(index);
        const skeleton =
          skin === undefined ? undefined : native.skeletons[native.skinSkeleton[skin]];
        const name = skeleton?.boneNames.get(index);
        return skeleton && name !== undefined ? { objectId: skeleton.objectId, name } : null;
      };

      // Bone maps: each target name resolved on the clone rig as the retarget resolves it, then
      // re-spelled through the node index.
      for (const [mapId, retargetId] of maps) {
        const skin = (
          state.nodes[edgeTarget(graph[retargetId], 'skeleton') ?? '']?.params as
            | { skinIndex?: number }
            | undefined
        )?.skinIndex;
        const jointKeys = assetParams?.skins?.[skin ?? 0]?.jointKeys ?? [];
        const cloneBones = jointKeys.map((name) => ({ name }) as BoneSpec);
        const map = (next.nodes[mapId].params as { map?: Record<string, string> }).map ?? {};
        const resolved = resolveBoneNames(Object.values(map), cloneBones);
        const respelled = Object.fromEntries(
          Object.entries(map).map(([from, to]) => {
            const index = indexOfKey.get(resolved[to] ?? to);
            const bone = index === undefined ? null : boneAt(index);
            return [from, bone?.name ?? to];
          }),
        );
        if (!deepEqual(respelled, map)) {
          run([{ type: 'setParam', nodeId: mapId, paramPath: 'map', value: respelled }]);
        }
      }

      // Binds: the clip the clone played on each rig becomes the one bound, through the bind's own
      // builder; every other retarget on that rig stands down, as a later bind stands it down.
      for (const [skin, clips] of boundBySkin) {
        const skeleton = native.skeletons[native.skinSkeleton[skin]];
        if (!skeleton) continue;
        const playingId = clips[0].clipId;
        for (const id of retargets) {
          if (edgeTarget(graph[id], 'skeleton') !== gltfSkeletonDagId(assetRef, skin)) continue;
          const active = id === playingId;
          if ((next.nodes[id].params as { active?: unknown }).active !== active) {
            run([{ type: 'setParam', nodeId: id, paramPath: 'active', value: active }]);
          }
        }
        run(bindPosedOps(next, playingId, skeleton.objectId));
      }

      // Hand-poses: per bone, the Object's forced value over the override's over the Object's plain one.
      const posed = new Set([...overridePose.keys(), ...boneObjectPose.keys()]);
      for (const index of [...posed].sort((a, b) => a - b)) {
        const bone = boneAt(index);
        if (!bone) continue;
        const fromObject = boneObjectPose.get(index);
        const pose: BonePose = {
          ...fromObject?.plain,
          ...overridePose.get(index),
          ...fromObject?.forced,
        };
        if (Object.keys(pose).length === 0) continue;
        run(handPoseOps(next, bone.objectId, bone.name, pose));
      }

      // Keys edited on a bone: a curve in the hand-pose layer, written by the key tools' own writer.
      // The member is made first through the hand-pose builder, so it takes the clone's euler order
      // (the key writer alone would add one in Blender's XYZ). A component the bone's Object forces
      // was drawn by that value on the clone, never by the channel: it is not carried.
      for (const channel of [...boneChannels].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const bone = boneAt(channel.index);
        if (!bone) continue;
        if (boneObjectPose.get(channel.index)?.forced[channel.component] !== undefined) continue;
        run(handPoseOps(next, bone.objectId, bone.name, {}));
        const layerId = handPoseLayerOf(
          next.nodes as unknown as Readonly<Record<string, GraphNodeLike>>,
          bone.objectId,
        );
        if (layerId === null) throw new Error(`no hand-pose layer on "${bone.objectId}"`);
        const resolved = resolveChannelAddress(
          next,
          { layer: { layerId, bone: bone.name, component: channel.component } },
          { mint: true },
        );
        if (!resolved.ok) throw new Error(resolved.reason);
        // The clone's label for the channel (`<childName> — <component>`, in the clone's spelling) is
        // its own and nobody authored it: the curve takes the name the key writer gives any curve.
        const { name: _label, ...fields } = state.nodes[channel.id].params as Record<
          string,
          unknown
        >;
        void _label;
        run(resolved.write(fields));
      }

      // Keys edited on a node of the file: its curve for that component. A component the Object
      // forces was drawn by that value on the clone, never by the channel: not carried (the file's
      // curve then plays over the value, as the moved-child rule says).
      for (const channel of [...objectChannels].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (channel.forced) continue;
        const nodeId = native.nodeIds[channel.index];
        if (!nodeId || !next.nodes[nodeId])
          throw new Error(`${label(channel.id)} has no native node`);
        if (channel.component === 'rotation') {
          const before = next.nodes[nodeId].params as RotationModeFields & { rotation?: unknown };
          if (before.rotationMode === 'quaternion') {
            run(rotationModeOps(nodeId, before, 'euler'));
            notes.push(
              `${label(channel.target)} now turns in euler mode, as its keys were edited in euler angles (the file's quaternion keys stay on it and no longer turn it, as in Blender)`,
            );
          }
        }
        // The curve's own fields; the clone's name for it and its tie to the file stay behind.
        const {
          name: _name,
          target: _target,
          paramPath: _path,
          assetRef: _asset,
          childName: _child,
          sourceClipId: _clip,
          sourceHash: _hash,
          ...fields
        } = state.nodes[channel.id].params as Record<string, unknown>;
        void [_name, _target, _path, _asset, _child, _clip, _hash];
        const channelId = `${nodeId}_${channel.component}_channel`;
        if (!next.nodes[channelId]) {
          // No curve of the file's on it: the one the key tools mint for this param (addChannel's id
          // and name), holding the clone's keys.
          run([
            {
              type: 'addNode',
              nodeId: channelId,
              nodeType: 'KeyframeChannelVec3',
              params: {
                ...fields,
                name: channel.component,
                target: nodeId,
                paramPath: channel.component,
              },
            },
          ]);
          continue;
        }
        const resolved = resolveChannelAddress(next, { channelId }, { mint: false });
        if (!resolved.ok) throw new Error(resolved.reason);
        run(resolved.write(fields));
      }

      // The take: the one the ClipSelect picked plays, every other one is muted (#1154's shape).
      if (playing !== 0) {
        const first = native.takes[0];
        const mute = (id: string, value: boolean): Op => ({
          type: 'setParam',
          nodeId: id,
          paramPath: 'mute',
          value,
        });
        if (first) run([...first.layers, ...first.channels].map((id) => mute(id, true)));
        const take = playing > 0 ? native.takes[playing] : undefined;
        if (take) {
          run([...take.layers, ...(take.track ? [take.track] : [])].map((id) => mute(id, false)));
        }
      }
      return next;
    },
  };
  if (playing < 0 && clipIds.length > 0) {
    notes.push(
      `none of the file's animations plays, as it was saved (${label(selectId)} picked none)`,
    );
  }

  return {
    why,
    notes,
    footprint: saved,
    childIndex,
    referrers,
    addedInputs,
    edits: (remap) => editOps.flatMap((make) => make(remap)),
    motion,
    dataIndex,
    materials: (state_, native) => {
      let next = state_;
      /** How many slots the native mesh data numbers (one when it holds no table). */
      const nativeSlots = (dataId: string): number =>
        (next.nodes[dataId]?.params as { materialSlots?: unknown[] } | undefined)?.materialSlots
          ?.length ?? 1;
      for (const edit of materialEdits) {
        const mesh = native.meshes[edit.index];
        if (!mesh) throw new Error(`${edit.label} has no native mesh`);
        if (nativeSlots(mesh.dataId) !== edit.slots) {
          throw new Error(
            `${edit.label} numbers ${edit.slots} material slots, the native mesh ${nativeSlots(mesh.dataId)}`,
          );
        }
        for (const leaf of edit.leaves) {
          next = applyOp(next, {
            type: 'setParam',
            nodeId: mesh.dataId,
            paramPath: leaf.path,
            value: leaf.value,
          }).next;
        }
      }
      for (const edit of slotOverrideEdits) {
        const mesh = native.meshes[edit.index];
        if (!mesh) throw new Error(`${edit.label} has no native mesh`);
        if (nativeSlots(mesh.dataId) !== edit.slots) {
          throw new Error(
            `${edit.label} numbers ${edit.slots} material slots, the native mesh ${nativeSlots(mesh.dataId)}`,
          );
        }
        next = applyOp(next, {
          type: 'setParam',
          nodeId: mesh.objectId,
          paramPath: 'slotOverrides',
          value: edit.value,
        }).next;
      }
      return next;
    },
  };
}

/** One changed material leaf: the dotted param path and its new value (`undefined` = removed). */
interface MaterialLeaf {
  readonly path: string;
  readonly value: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The leaves where `after` differs from `before`, as dotted paths under `path`. Objects are walked
 * key by key, and arrays of one length element by element; anything else (a scalar, an array whose
 * length changed, an object replacing null) is one leaf. Only what the director changed is carried,
 * because the untouched values are the native reader's own (it converts a file's materials with
 * this project's image keys, where the clone road's point elsewhere).
 */
function materialLeaves(before: unknown, after: unknown, path: string): MaterialLeaf[] {
  if (deepEqual(before, after)) return [];
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      materialLeaves(before[key], after[key], `${path}.${key}`),
    );
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return after.flatMap((item, i) => materialLeaves(before[i], item, `${path}.${i}`));
  }
  return [{ path, value: after }];
}

/** A material with any texture map set. */
function materialHasMaps(material: unknown): boolean {
  const maps = isRecord(material) ? material.maps : undefined;
  return isRecord(maps) && Object.values(maps).some((m) => m !== null && m !== undefined);
}

/** A clone TransformClip's index among the file's animations (its id is `clip/<assetRef>/<i>`). */
function clipIndexOf(assetRef: string, id: string, state: DagState): number {
  for (let i = 0; state.nodes[hashId('clip', assetRef, String(i))]; i++) {
    if (hashId('clip', assetRef, String(i)) === id) return i;
  }
  return Number.MAX_SAFE_INTEGER;
}

function metaOps(nodeId: string, now: Node, name: boolean, hidden: boolean): Op[] {
  const ops: Op[] = [];
  if (name) ops.push({ type: 'setMeta', nodeId, name: now.meta?.name });
  if (hidden) ops.push({ type: 'setHidden', nodeId, hidden: !!now.meta?.hidden });
  return ops;
}

/**
 * What a node naming a clone child as its subject does to it natively, and the flag that bypasses
 * it; null when it is not one the converter carries bypassed. A curve or a driver acts on the
 * param it keys, so only a transform one; a Track-To, a Follow-Path and a strip act on the whole
 * Object. (`Strip` spells the flag `muted`, the rest `mute`.)
 */
function subjectActs(
  type: string,
  keyed: unknown,
): { flag: 'mute' | 'muted'; says: string } | null {
  const transform = keyed === 'position' || keyed === 'rotation' || keyed === 'scale';
  if (type === 'KeyframeChannelVec3' && transform)
    return { flag: 'mute', says: `keys "${String(keyed)}" of` };
  if (type === 'ParamDriver' && transform)
    return { flag: 'mute', says: `drives "${String(keyed)}" of` };
  if (type === 'TrackTo') return { flag: 'mute', says: 'aims' };
  if (type === 'FollowPath') return { flag: 'mute', says: 'sets a path for' };
  if (type === 'Strip') return { flag: 'muted', says: 'plays an action on' };
  return null;
}

/**
 * A clone child's moved transform onto its native Object. The clone states rotation as XYZ euler
 * DEGREES; every native imported node is in quaternion mode, so a moved rotation is written as the
 * same rotation's quaternion. `overridden` (the clone's gizmo-over-clip precedence) has no native
 * counterpart: natively the file's keys play over a static value, as in Blender.
 */
function objectTransformOps(
  nodeId: string,
  fields: readonly string[],
  params: Record<string, unknown>,
): Op[] {
  const ops: Op[] = [];
  for (const field of fields) {
    if (field === 'position' || field === 'scale') {
      ops.push({ type: 'setParam', nodeId, paramPath: field, value: params[field] });
    } else if (field === 'rotation') {
      const [x, y, z] = params.rotation as [number, number, number];
      const toRad = Math.PI / 180;
      ops.push({
        type: 'setParam',
        nodeId,
        paramPath: 'quaternion',
        value: quatFromEulerXYZ([x * toRad, y * toRad, z * toRad]),
      });
    }
  }
  return ops;
}

/**
 * #1216 — the load-time door: a loaded project with its clone-road characters converted, their
 * images written into THIS project's folder (the id is known here; `setCurrent` has not run yet, so
 * the open-project image store would have nowhere to write). Returns the project itself when it
 * holds no clone character.
 */
export async function convertLoadedProject(
  project: Project,
  storage: StorageCapability,
): Promise<{ readonly project: Project; readonly report: CharacterConversionReport }> {
  const state: DagState = { nodes: project.state.nodes, outputs: project.state.outputs };
  if (cloneImportAssets(state).length === 0) {
    return { project, report: { converted: [], kept: [] } };
  }
  const result = await convertCloneCharacters(state, {
    read: (path) => storage.read(path),
    storeImage: (bytes, mime) => writeProjectImage(storage, project.id, bytes, mime),
    decodeDraco: decodeDracoInBrowser,
  });
  if (result.state === state) return { project, report: result.report };
  return {
    project: {
      ...project,
      state: { ...project.state, nodes: result.state.nodes, outputs: result.state.outputs },
    },
    report: result.report,
  };
}

/**
 * The banner row an import's load notice is written under. Its own row, not the file's: the
 * renderer reports and clears the file's row (`assetRef`) as the file loads or fails, and a kept
 * import whose file is gone fails to load — which replaced the one row that said why (#1264).
 */
const noticeKey = (kind: CloneImportKind, assetRef: string): string => `${kind}:${assetRef}`;

/** What a converted import now loads as, by kind. */
const LOADS_AS: Record<CloneImportKind, string> = {
  character: 'a native character (a skeleton and an Armature modifier)',
  model: 'native geometry',
};

/** One notice row per import the load converted or kept, under `noticeKey`. */
export function reportCharacterConversion(
  report: CharacterConversionReport,
  notify: (row: string, message: string, label: string) => void,
): void {
  for (const { kind, name, assetRef, notes } of report.converted) {
    notify(
      noticeKey(kind, assetRef),
      `"${name}" was saved on the old imported-file structure and now loads as ${LOADS_AS[kind]}; the project's next save keeps it that way.${
        notes.length > 0 ? ` Now: ${notes.join('; ')}.` : ''
      }`,
      `${kind} converted:`,
    );
  }
  // #1053 — the clone road is retired, so a kept import has nothing left to draw it: it is NOT
  // DRAWN, and said so (user decision, 2026-09-30). Its nodes stay as saved; every load tries
  // again, so it converts on its own once what kept it is fixed.
  for (const { kind, name, assetRef, why } of report.kept) {
    notify(
      noticeKey(kind, assetRef),
      `"${name}" is not drawn: it was saved on the old imported-file structure and cannot be converted (${why.join('; ')}). It stays in the project as saved and converts on a later load once that is fixed.`,
      `${kind} not converted:`,
    );
  }
}
