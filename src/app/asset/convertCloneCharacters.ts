// #1216 — a saved project's clone-road characters become native when the project loads.
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
// This is not a format migration: migrations are synchronous (`migrations.ts`), and the source bytes
// live in the browser's import storage, not in the project. It runs before every hydrate of a loaded
// project (`hydrateLoadedProject`, boot.ts).
//
// REF: src/core/import/nativeGltfImport.ts (`buildSavedCharacterOps`, `nodeIds`);
//      src/core/import/gltfImportChain.ts (`buildGltfImportOps`, `importGroupNodeIds`);
//      src/core/dag/idRefSweep.ts (`remapIdRefs`); issues #1216 #1227 #1205 #1053.

import { applyOp } from '../../core/dag/ops';
import { getNodeType } from '../../core/dag/registry';
import type { DagState } from '../../core/dag/state';
import type { InputBinding, Node, NodeRef, Op } from '../../core/dag/types';
import { refIdsAt, remapIdRefs } from '../../core/dag/idRefSweep';
import { parseGltfContainer } from '../../core/import/glb';
import { buildGltfImportOps, hashId, importGroupNodeIds } from '../../core/import/gltfImportChain';
import {
  buildSavedCharacterOps,
  type NativeImportRefusal,
  type NativeImportResult,
} from '../../core/import/nativeGltfImport';
import { quatFromEulerXYZ } from '../../nodes/bonePose';
import { nodeDisplayName } from '../sceneTreeWalk';
import { opfsSiblingPath } from './opfsGltfResolver';
import type { Project } from '../../core/project/schema';
import { writeProjectImage } from '../../core/project/projectImages';
import type { StorageCapability } from '../../core/storage';

export interface ConvertCloneCharactersDeps {
  /** The bytes at a storage path; throws when there is no file there. */
  readonly read: (path: string) => Promise<Uint8Array>;
  /** Store an image in THIS project's image folder and return its key (#1050). */
  readonly storeImage: (bytes: Uint8Array, mime: string) => Promise<string>;
}

export interface CharacterConversionReport {
  readonly converted: readonly { readonly name: string; readonly assetRef: string }[];
  /** A character left as it was saved, and why — each edit it could not carry, by name. */
  readonly kept: readonly {
    readonly name: string;
    readonly assetRef: string;
    readonly why: readonly string[];
  }[];
}

/** A saved clone-road character: an import whose asset carries a skin. */
export function cloneCharacterAssets(state: DagState): readonly Node[] {
  return Object.values(state.nodes).filter(
    (node) =>
      node.type === 'GltfAsset' &&
      ((node.params as { skins?: readonly unknown[] }).skins?.length ?? 0) > 0,
  );
}

/**
 * Every clone-road character in `state`, converted to the native structure where it can be, and
 * the report of what happened to each. Returns `state` itself when there is nothing to convert.
 */
export async function convertCloneCharacters(
  state: DagState,
  deps: ConvertCloneCharactersDeps,
): Promise<{ readonly state: DagState; readonly report: CharacterConversionReport }> {
  const converted: { name: string; assetRef: string }[] = [];
  const kept: { name: string; assetRef: string; why: string[] }[] = [];
  let next = state;
  for (const asset of cloneCharacterAssets(state)) {
    const assetRef = (asset.params as { assetRef: string }).assetRef;
    const name = characterName(next, assetRef);
    // A conversion that throws (a corrupt file, an op the reducer refuses) keeps the character as
    // saved and says why: converting must never be the reason a project does not open.
    const one = await convertOne(next, assetRef, deps).catch((err: unknown) => ({
      why: [`it could not be converted (${err instanceof Error ? err.message : String(err)})`],
    }));
    if ('why' in one) kept.push({ name, assetRef, why: one.why });
    else {
      next = one.state;
      converted.push({ name, assetRef });
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
): Promise<{ state: DagState } | { why: string[] }> {
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
  };

  // The import exactly as the clone road wrote it, applied on its own beside a bare scene.
  const untouched = await buildGltfImportOps(args, { nodes: {}, outputs: {} });
  let pristine: DagState = {
    nodes: { [sceneId]: { ...state.nodes[sceneId], inputs: {} } },
    outputs: {},
  };
  for (const op of untouched.ops) pristine = applyOp(pristine, op).next;

  const json = parseGltfContainer(copy.buffer).json as {
    nodes?: { skin?: number }[];
    skins?: { joints: number[] }[];
  };
  const keyByIndex = (
    pristine.nodes[untouched.gltfAssetId]?.params as { keyByGltfNodeIndex?: Record<number, string> }
  )?.keyByGltfNodeIndex;
  const plan = planEdits(
    state,
    pristine,
    sceneId,
    untouched.gltfAssetId,
    assetRef,
    json,
    keyByIndex,
  );
  if (plan.why.length > 0) return { why: plan.why };

  // Only now the native build: it writes the file's images into the project, and a character that
  // is kept must leave nothing behind.
  let native: NativeImportResult | NativeImportRefusal;
  try {
    native = await buildSavedCharacterOps(args);
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

  // 1. The clone import leaves.
  const footprint = new Set(plan.footprint);
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(state.nodes)) if (!footprint.has(id)) nodes[id] = node;
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
  return { state: next };
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

interface EditPlan {
  /** Every edit this step cannot carry, by name. Non-empty ⇒ the character is kept. */
  readonly why: string[];
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
}

function planEdits(
  state: DagState,
  pristine: DagState,
  sceneId: string,
  assetId: string,
  assetRef: string,
  json: { nodes?: { skin?: number }[]; skins?: { joints: number[] }[] },
  keyByIndex: Record<number, string> | undefined,
): EditPlan {
  const why: string[] = [];
  const saved = importGroupNodeIds(assetRef, state);
  const footprint = new Set(saved);
  const untouchedIds = Object.keys(pristine.nodes).filter((id) => id !== sceneId);
  const label = (id: string): string => `"${nodeDisplayName(state.nodes, id)}"`;

  for (const id of untouchedIds) {
    if (!state.nodes[id]) why.push(`${label(id)} was deleted from the import`);
  }
  for (const id of saved) {
    if (!pristine.nodes[id]) why.push(`${label(id)} is not part of the file as it reads today`);
  }

  // The glTF node index each clone child Object stands for — the one join the roads share.
  const childIndex = new Map<string, number>();
  const nodeNameMap =
    (pristine.nodes[assetId]?.params as { nodeNameMap?: Record<string, string> })?.nodeNameMap ??
    {};
  for (const [index, key] of Object.entries(keyByIndex ?? {})) {
    const objectId = nodeNameMap[key];
    if (objectId) childIndex.set(objectId, Number(index));
  }
  const bones = new Set((json.skins ?? []).flatMap((skin) => skin.joints));
  const animated = new Set<string>();
  for (const node of Object.values(pristine.nodes)) {
    if (node.type !== 'TransformClip') continue;
    // A clip key names the file's node by its KEY, not by the child Object's id.
    for (const k of (node.params as { keyframes: { targetNodeId: string }[] }).keyframes) {
      const objectId = nodeNameMap[k.targetNodeId];
      if (objectId) animated.add(objectId);
    }
  }
  const groupId = hashId('grp', assetRef);

  // A child Object whose edits carry across: a plain node of the file — not a bone (its pose is the
  // skeleton's, slice 2), not a skinned mesh (it stands at identity under its armature natively),
  // not one the file animates (a gizmo edit on the clone outranked the clip; natively the file's
  // keys would win, and that difference is slice 2's to decide).
  const carryable = (id: string): string | null => {
    const index = childIndex.get(id);
    if (index === undefined) return 'is not a node of the file';
    if (bones.has(index)) return 'is a bone, whose pose this step does not carry yet';
    if (typeof json.nodes?.[index]?.skin === 'number') return 'is a skinned mesh';
    if (animated.has(id)) return 'is animated by the file';
    return null;
  };

  const editOps: ((remap: (id: string) => string) => Op[])[] = [];
  const addedInputs: [string, { socket: string; refs: NodeRef[] }][] = [];

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
    if (now.type === 'Object') {
      const refusal = carryable(id);
      const unknown = fields.filter(
        (f) => !['position', 'rotation', 'scale', 'overridden'].includes(f),
      );
      if (refusal !== null) {
        const what = fields.length > 0 ? 'was moved' : metaChanged ? 'was renamed' : 'was hidden';
        why.push(`${label(id)} ${what}, and it ${refusal}`);
        continue;
      }
      if (unknown.length > 0) {
        why.push(`${label(id)} has edited ${unknown.join(', ')}`);
        continue;
      }
      editOps.push((remap) => [
        ...objectTransformOps(remap(id), fields, params),
        ...metaOps(remap(id), now, metaChanged, hiddenChanged),
      ]);
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

  // Everything outside the import that names one of its nodes.
  const referrers: string[] = [];
  const mappable = (id: string): boolean =>
    id === groupId || (childIndex.has(id) && carryable(id) === null);
  for (const node of Object.values(state.nodes)) {
    if (footprint.has(node.id)) continue;
    let names = false;
    for (const [socket, binding] of Object.entries(node.inputs)) {
      for (const ref of refsOf(binding)) {
        if (!footprint.has(ref.node)) continue;
        names = true;
        if (!mappable(ref.node))
          why.push(`${label(node.id)} reads ${label(ref.node)} through "${socket}"`);
      }
    }
    for (const ref of getNodeType(node.type)?.idRefs ?? []) {
      for (const target of refIdsAt(node.params, ref.path, ref.shape)) {
        if (!footprint.has(target)) continue;
        names = true;
        if (!mappable(target)) why.push(`${label(node.id)} names ${label(target)} (${ref.path})`);
        // A channel on a child keys one of its params; the clone's rotation is XYZ euler degrees
        // and the native node is in quaternion mode, so only position and scale carry as they are.
        const keyed = (node.params as { paramPath?: unknown }).paramPath;
        if (
          target !== groupId &&
          typeof keyed === 'string' &&
          keyed !== 'position' &&
          keyed !== 'scale'
        ) {
          why.push(
            `${label(node.id)} keys "${keyed}" of ${label(target)}, which the native node holds as a quaternion`,
          );
        }
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

  return {
    why,
    footprint: saved,
    childIndex,
    referrers,
    addedInputs,
    edits: (remap) => editOps.flatMap((make) => make(remap)),
  };
}

function metaOps(nodeId: string, now: Node, name: boolean, hidden: boolean): Op[] {
  const ops: Op[] = [];
  if (name) ops.push({ type: 'setMeta', nodeId, name: now.meta?.name });
  if (hidden) ops.push({ type: 'setHidden', nodeId, hidden: !!now.meta?.hidden });
  return ops;
}

/**
 * A clone child's moved transform onto its native Object. The clone states rotation as XYZ euler
 * DEGREES; every native imported node is in quaternion mode, so a moved rotation is written as the
 * same rotation's quaternion. `overridden` (the clone's gizmo-over-clip precedence) has no native
 * meaning on a node the file does not animate, which is the only kind carried here.
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
  if (cloneCharacterAssets(state).length === 0) {
    return { project, report: { converted: [], kept: [] } };
  }
  const result = await convertCloneCharacters(state, {
    read: (path) => storage.read(path),
    storeImage: (bytes, mime) => writeProjectImage(storage, project.id, bytes, mime),
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

/** One notice row per character the load converted or kept, keyed by its file. */
export function reportCharacterConversion(
  report: CharacterConversionReport,
  notify: (assetRef: string, message: string, label: string) => void,
): void {
  for (const { name, assetRef } of report.converted) {
    notify(
      assetRef,
      `"${name}" was saved on the old imported-file structure and now loads as a native character (a skeleton and an Armature modifier); the project's next save keeps it that way.`,
      'character converted:',
    );
  }
  for (const { name, assetRef, why } of report.kept) {
    notify(
      assetRef,
      `"${name}" still loads on the old imported-file structure: ${why.join('; ')}.`,
      'character not converted:',
    );
  }
}
