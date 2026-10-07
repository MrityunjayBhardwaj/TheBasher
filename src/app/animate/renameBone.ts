// #1201 — renaming a bone renames it everywhere it is written, in one undo step, as Blender does.
//
// ── WHY A RENAME TOUCHES MORE THAN THE SKELETON ─────────────────────────────────────────────────
//
// A bone is found BY NAME, and its name is stored by value beside every record that addresses it
// (rule 10 of "Bones as Channels", #1233: a name is a field, never part of a param path). Renaming only
// the skeleton's copy leaves every other copy naming a bone that no longer exists, and each reader
// fails silently: a layer's keys play nothing, a bone-parented Object falls to the armature's origin,
// a vertex stays at rest. So a rename rewrites each record whole, found through the graph's edges from
// the armature Object — never by what kind of file the rig came from.
//
// ── WHAT BLENDER REWRITES, AND OUR COUNTERPART ──────────────────────────────────────────────────
//
// `ED_armature_bone_rename` (`editors/armature/armature_naming.cc:165-392`, Blender 5.1.1):
//   the bone, made unique among its armature's (`:195-198`)          → `Skeleton.bones[].name`
//   every action/NLA path `bones["old"]`, exact match (`anim_data.cc`
//     `rna_path_rename_fix`, `nlastrips_path_rename_fix`)              → the `PoseLayer`s in the chain under
//                                                                        each armature Object: members and
//                                                                        channels, held muted layers too
//   an Object parented to the bone (`parsubstr`, `:266-273`)           → a child Object's `parentBone`
//   the vertex group on each mesh whose Armature modifier uses the
//     armature, UNLESS that mesh already has a group of the new name:
//     then it warns and leaves the groups alone (`:275-297`)          → `vertexGroups` of the mesh data an
//                                                                        `ArmatureModifier` reads
//   constraint subtargets (`:250-263`)                                 → a `RetargetClip`'s `BoneNameMap`
// Measured (`ref/probes/blender-native-character/q1201_bone_rename_oracle.py`): after a rename, plain,
// dotted or colliding with another bone (→ `.001`), the deform is unchanged to 0.0 at frames 0/12/24.
//
// A record this cannot rewrite safely is LEFT and named in the report, never skipped silently: a mesh
// with a group already called the new name (Blender's warning), a bone map another rig also reads.
//
// REF: src/app/animate/poseChain.ts (`poseLayerChain`, the one chain walk); src/nodes/PoseLayer.ts;
//      src/nodes/armatureDeform.ts (`boneOfGroups`); src/nodes/boneParent.ts; issue #1201.

import type { DagState } from '../../core/dag/state';
import type { Node, Op } from '../../core/dag/types';
import type { PoseLayerChannel, PoseLayerIk, PoseLayerMember } from '../../nodes/PoseLayer';
import type { SkeletonParams } from '../../nodes/Skeleton';
import { uniqueBoneName } from '../../core/import/nativeGltfSkeleton';
import { isPackedMeshData } from '../meshGeometryData';
import { chainSocketOf } from '../operatorChain';
import { producerOf } from '../asset/bakeGeneratedClip';
import { resolveBoneNames } from '../../core/import/retarget';
import { edgeTarget } from './graphNodes';
import { poseLayerChain } from './poseChain';

/** What a rename did: the name the bone now has, each record rewritten, and each one left as it was. */
export interface BoneRenameReport {
  /** The bone's name now — the asked-for name, made unique among its skeleton's bones. */
  readonly name: string;
  readonly skeleton: string;
  readonly layers: readonly string[];
  readonly parented: readonly string[];
  readonly meshes: readonly string[];
  readonly maps: readonly string[];
  /** Records that name the bone and were NOT rewritten, each with why. */
  readonly left: readonly { readonly node: string; readonly why: string }[];
}

export type BoneRenameResult =
  | { readonly ok: true; readonly ops: readonly Op[]; readonly report: BoneRenameReport }
  | { readonly ok: false; readonly reason: string };

const inputList = (node: Node | undefined, socket: string): string[] => {
  const s = node?.inputs?.[socket];
  const list = Array.isArray(s) ? s : s ? [s] : [];
  return list
    .map((b) => (b as { node?: unknown }).node)
    .filter((n): n is string => typeof n === 'string');
};

/**
 * The skeleton a retarget's SOURCE poses, found by walking the pose wire producer-side to where a rig
 * enters it: a skeleton's rest pose, or the `skeleton` edge of a clip or a retarget. Null when the wire
 * starts somewhere else — then which rig it reads cannot be told from the graph.
 */
function sourceSkeletonOf(state: DagState, retargetId: string): string | null {
  let at = edgeTarget(state.nodes[retargetId], 'source');
  for (let hops = 0; at && hops <= Object.keys(state.nodes).length; hops++) {
    const node = state.nodes[at];
    if (!node) return null;
    if (node.type === 'Skeleton') return at;
    if (node.type === 'AnimationClip' || node.type === 'RetargetClip') {
      return edgeTarget(node, 'skeleton');
    }
    if (node.type !== 'PoseLayer') return null;
    at = edgeTarget(node, 'pose');
  }
  return null;
}

/** The mesh data an operator stack reads, walked down its chain from `start`; null when none is. */
function meshDataUnder(state: DagState, start: string | null): string | null {
  let at = start;
  for (let hops = 0; at && hops <= Object.keys(state.nodes).length; hops++) {
    const node = state.nodes[at];
    if (!node) return null;
    if (isPackedMeshData((node.params as { mesh?: unknown } | undefined)?.mesh)) return at;
    const socket = chainSocketOf(node);
    at = socket ? edgeTarget(node, socket) : null;
  }
  return null;
}

/**
 * Every node that can hold a bone name of the skeleton an armature Object stands — the one walk a
 * rename rewrites through, and the scope an agent's rename is allowed to touch (closure kind `rig`).
 * Null when `objectId` is not an armature Object.
 */
export interface RigReach {
  readonly skeleton: string;
  /** Every Object standing this skeleton — Blender walks every Object whose data is the armature. */
  readonly armatures: readonly string[];
  /** The pose layers under each: the counterpart of the actions and NLA strips bound to it. */
  readonly layers: readonly string[];
  /** Each armature Object's children: the Objects that may be parented to a bone. */
  readonly children: readonly string[];
  /** The mesh data each Armature modifier deforming by one of the armatures reads. */
  readonly meshes: readonly string[];
  readonly retargets: readonly string[];
  /** The bone map of every retarget in the graph: whether this rig is on a side is decided per map. */
  readonly maps: readonly string[];
}

export function rigReach(state: DagState, objectId: string): RigReach | null {
  const object = state.nodes[objectId];
  const skeleton = edgeTarget(object, 'data');
  if (!object || object.type !== 'Object' || !skeleton) return null;
  if (state.nodes[skeleton]?.type !== 'Skeleton') return null;
  const nodes = Object.values(state.nodes);
  const armatures = nodes
    .filter((n) => n.type === 'Object' && edgeTarget(n, 'data') === skeleton)
    .map((n) => n.id);
  const retargets = nodes.filter((n) => n.type === 'RetargetClip');
  const unique = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => !!id))];
  return {
    skeleton,
    armatures,
    layers: unique(armatures.flatMap((id) => poseLayerChain(state.nodes, id).layers)),
    children: unique(armatures.flatMap((id) => inputList(state.nodes[id], 'children'))),
    meshes: unique(
      nodes
        .filter(
          (n) =>
            n.type === 'ArmatureModifier' && armatures.includes(edgeTarget(n, 'armature') ?? ''),
        )
        .map((n) => meshDataUnder(state, edgeTarget(n, chainSocketOf(n) ?? 'target'))),
    ),
    retargets: retargets.map((n) => n.id),
    maps: unique(retargets.map((r) => edgeTarget(r, 'boneMap'))),
  };
}

/** All of a reach's nodes, for a scope. */
export function rigReachNodes(reach: RigReach): string[] {
  return [
    reach.skeleton,
    ...reach.armatures,
    ...reach.layers,
    ...reach.children,
    ...reach.meshes,
    ...reach.retargets,
    ...reach.maps,
  ];
}

/**
 * Rename bone `oldName` of the skeleton standing as armature Object `objectId` to `requested` — made
 * unique among that skeleton's bones as Blender makes it — and rewrite every record that names it.
 * Every op sets a whole list or record (rule 10). Dispatch them as ONE atomic step.
 */
export function renameBone(
  state: DagState,
  objectId: string,
  oldName: string,
  requested: string,
): BoneRenameResult {
  const reach = rigReach(state, objectId);
  if (!reach) return { ok: false, reason: 'Only an armature Object’s bones can be renamed.' };
  const skeletonId = reach.skeleton;
  const bones = (state.nodes[skeletonId].params as SkeletonParams).bones;
  const at = bones.findIndex((b) => b.name === oldName);
  if (at < 0) return { ok: false, reason: `This armature has no bone named “${oldName}”.` };
  const generated = Object.values(state.nodes).find(
    (n) =>
      n.type === 'AnimationClip' &&
      edgeTarget(n, 'skeleton') === skeletonId &&
      producerOf(state, n.id) !== null,
  );
  if (generated) {
    return {
      ok: false,
      reason:
        'This rig is generated with its motion: each new take rewrites its bones, so a rename would not last.',
    };
  }

  // Blender compares the asked-for name before making it unique: asking for the name it has is no rename.
  const empty: BoneRenameReport = {
    name: oldName,
    skeleton: skeletonId,
    layers: [],
    parented: [],
    meshes: [],
    maps: [],
    left: [],
  };
  if (requested === oldName) return { ok: true, ops: [], report: empty };
  const name = uniqueBoneName(requested, (n) => bones.some((b, i) => i !== at && b.name === n));
  if (name === oldName) return { ok: true, ops: [], report: empty };

  const ops: Op[] = [
    {
      type: 'setParam',
      nodeId: skeletonId,
      paramPath: 'bones',
      value: bones.map((b, i) => (i === at ? { ...b, name } : b)),
    },
  ];
  const left: { node: string; why: string }[] = [];

  const rewrittenLayers: string[] = [];
  for (const id of reach.layers) {
    const params = state.nodes[id].params as {
      members?: PoseLayerMember[];
      channels?: PoseLayerChannel[];
      ik?: PoseLayerIk;
    };
    const members = params.members ?? [];
    const channels = params.channels ?? [];
    const namesMember = members.some((m) => m.bone === oldName);
    const namesChannel = channels.some((c) => c.bone === oldName);
    if (namesMember) {
      ops.push({
        type: 'setParam',
        nodeId: id,
        paramPath: 'members',
        value: members.map((m) => (m.bone === oldName ? { ...m, bone: name } : m)),
      });
    }
    if (namesChannel) {
      ops.push({
        type: 'setParam',
        nodeId: id,
        paramPath: 'channels',
        value: channels.map((c) => (c.bone === oldName ? { ...c, bone: name } : c)),
      });
    }
    // #1343 — an ik layer names its chain and control bones by name too.
    const ik = params.ik;
    const namesIk =
      ik !== undefined &&
      [ik.root, ik.mid, ik.tip, ik.goal, ik.pole].some((bone) => bone === oldName);
    if (namesIk) {
      const swap = (bone: string) => (bone === oldName ? name : bone);
      ops.push({
        type: 'setParam',
        nodeId: id,
        paramPath: 'ik',
        value: {
          ...ik,
          root: swap(ik.root),
          mid: swap(ik.mid),
          tip: swap(ik.tip),
          goal: swap(ik.goal),
          ...(ik.pole !== undefined ? { pole: swap(ik.pole) } : {}),
        },
      });
    }
    if (namesMember || namesChannel || namesIk) rewrittenLayers.push(id);
  }

  // Objects parented to the bone.
  const parented: string[] = [];
  for (const child of reach.children) {
    if (
      (state.nodes[child]?.params as { parentBone?: unknown } | undefined)?.parentBone !== oldName
    ) {
      continue;
    }
    ops.push({ type: 'setParam', nodeId: child, paramPath: 'parentBone', value: name });
    parented.push(child);
  }

  // The vertex group on every mesh an Armature modifier deforms by one of these Objects.
  const meshes: string[] = [];
  for (const id of reach.meshes) {
    const mesh = (state.nodes[id].params as { mesh: { vertexGroups: readonly string[] } }).mesh;
    if (mesh.vertexGroups.includes(name)) {
      left.push({
        node: id,
        why: `its mesh already has a vertex group named “${name}”, so its groups were left as they were`,
      });
      continue;
    }
    if (!mesh.vertexGroups.includes(oldName)) continue;
    ops.push({
      type: 'setParam',
      nodeId: id,
      paramPath: 'mesh',
      value: { ...mesh, vertexGroups: mesh.vertexGroups.map((g) => (g === oldName ? name : g)) },
    });
    meshes.push(id);
  }

  // Bone maps: values name the target rig's bones, keys the source's. A map is rewritten on a side only
  // when every retarget reading it has this skeleton on that side; otherwise another rig still means the
  // old name, and the map is left and reported.
  const retargets = reach.retargets.map((id) => state.nodes[id]);
  const maps: string[] = [];
  for (const mapId of reach.maps) {
    const map = (state.nodes[mapId]?.params as { map?: Record<string, string> } | undefined)?.map;
    if (!map) continue;
    const readers = retargets.filter((r) => edgeTarget(r, 'boneMap') === mapId);
    const asTarget = readers.map((r) => edgeTarget(r, 'skeleton') === skeletonId);
    const sources = readers.map((r) => sourceSkeletonOf(state, r.id));
    const asSource = sources.map((id) => id === skeletonId);
    // Which entries name the bone is the retarget's own question (`resolveBoneNames`: the exact name,
    // else the one bone sharing its separator-free spelling), asked of the bones before the rename — an
    // exact-match test here would leave a `mixamorigHips` naming a bone that is gone.
    const resolvedValues = resolveBoneNames(Object.values(map), bones);
    const resolvedKeys = resolveBoneNames(Object.keys(map), bones);
    const isOldValue = (to: string) => (resolvedValues[to] ?? to) === oldName;
    const isOldKey = (from: string) => (resolvedKeys[from] ?? from) === oldName;
    const valueNames = Object.values(map).some(isOldValue) && asTarget.some(Boolean);
    const keyNames = Object.keys(map).some(isOldKey) && asSource.some(Boolean);
    // #1253 — a key naming the bone, read by a retarget whose source rig the graph does not say: it may
    // mean this rig's bone or another's. Not guessed, and not silent either.
    if (!keyNames && Object.keys(map).some(isOldKey) && sources.some((id) => id === null)) {
      left.push({
        node: mapId,
        why: `its bone map has an entry for “${oldName}” read from a motion whose rig cannot be told from the graph, so it was left`,
      });
    }
    if (!valueNames && !keyNames) continue;
    const values = valueNames && asTarget.every(Boolean);
    const keys = keyNames && asSource.every(Boolean) && !(name in map);
    if ((valueNames && !values) || (keyNames && !keys)) {
      left.push({
        node: mapId,
        why:
          keyNames && name in map
            ? `its bone map already has an entry for “${name}”`
            : 'its bone map is shared with another rig, which still names the old bone',
      });
    }
    if (!values && !keys) continue;
    const next: Record<string, string> = {};
    for (const [from, to] of Object.entries(map)) {
      next[keys && isOldKey(from) ? name : from] = values && isOldValue(to) ? name : to;
    }
    ops.push({ type: 'setParam', nodeId: mapId, paramPath: 'map', value: next });
    maps.push(mapId);
  }

  return {
    ok: true,
    ops,
    report: { name, skeleton: skeletonId, layers: rewrittenLayers, parented, meshes, maps, left },
  };
}

/**
 * #1341 — a symmetrize's bone-map entries: for each of `listed` that has a twin on `bonesAfter`, every
 * map entry naming it gets a twin entry — the twin on this rig's side, the other rig's bone with its
 * side flipped — when that flipped bone exists on the other rig and nothing maps the twin yet.
 *
 * The counterpart of Blender's symmetrize on a bone constraint (measured, 5.1.1): the twin gets the
 * constraint, its subtarget flipped when the flipped bone exists (`armature_add.cc`
 * `update_duplicate_subtarget`: `Hand.L` copying `Ctl.L` → `Hand.R` copying `Ctl.R`). Symmetrize copies
 * nothing else that names a bone there — no pose values, no keys, no bone-parented Object, no vertex
 * group — and none is copied here.
 *
 * An entry against a bone with no side is not mirrored (Blender keeps the one subtarget for both; a
 * map key holds one bone). A map another rig also reads on this side, or one read from a motion whose
 * rig the graph does not say, is LEFT and named, as a rename leaves it.
 */
export function mirroredBoneMapOps(
  state: DagState,
  objectId: string,
  listed: readonly string[],
  bonesAfter: readonly { readonly name: string }[],
  flip: (name: string) => string,
): { ops: Op[]; mirrored: string[]; left: { node: string; why: string }[] } {
  const none = { ops: [], mirrored: [], left: [] };
  const reach = rigReach(state, objectId);
  if (!reach) return none;
  const names = new Set(bonesAfter.map((b) => b.name));
  const twins = new Map<string, string>();
  for (const bone of listed) {
    const twin = flip(bone);
    if (twin !== bone && names.has(bone) && names.has(twin)) twins.set(bone, twin);
  }
  if (twins.size === 0) return none;
  const bonesOf = (skeleton: string | null) =>
    skeleton === null
      ? null
      : ((state.nodes[skeleton]?.params as SkeletonParams | undefined)?.bones ?? null);
  const mine = bonesAfter as SkeletonParams['bones'];
  const retargets = reach.retargets.map((id) => state.nodes[id]);
  const ops: Op[] = [];
  const mirrored: string[] = [];
  const left: { node: string; why: string }[] = [];
  for (const mapId of reach.maps) {
    const map = (state.nodes[mapId]?.params as { map?: Record<string, string> } | undefined)?.map;
    if (!map) continue;
    const readers = retargets.filter((r) => edgeTarget(r, 'boneMap') === mapId);
    const targets = readers.map((r) => edgeTarget(r, 'skeleton'));
    const sources = readers.map((r) => sourceSkeletonOf(state, r.id));
    // Keys name the motion's bones, values the target rig's.
    for (const side of ['target', 'source'] as const) {
      const here = side === 'target' ? targets : sources;
      const there = side === 'target' ? sources : targets;
      if (!here.some((id) => id === reach.skeleton)) continue;
      const entries = Object.entries(map).map(([from, to]) =>
        side === 'target' ? { own: to, other: from } : { own: from, other: to },
      );
      const resolved = resolveBoneNames(
        entries.map((e) => e.own),
        mine,
      );
      const boneOf = (own: string) => resolved[own] ?? own;
      const wanted = entries.filter(
        (e) =>
          twins.has(boneOf(e.own)) &&
          flip(e.other) !== e.other &&
          !entries.some((x) => boneOf(x.own) === twins.get(boneOf(e.own))),
      );
      if (wanted.length === 0) continue;
      if (!here.every((id) => id === reach.skeleton)) {
        left.push({
          node: mapId,
          why: 'its bone map is shared with another rig, so the mirrored bones were not added to it',
        });
        continue;
      }
      const others = there.map(bonesOf);
      if (others.some((b) => b === null)) {
        left.push({
          node: mapId,
          why: 'its bone map is read with a rig the graph does not say, so the mirrored bones were not added to it',
        });
        continue;
      }
      const next: Record<string, string> = { ...map };
      const added: string[] = [];
      for (const e of wanted) {
        const flipped = flip(e.other);
        // `resolveBoneNames` hands an unresolved name back as itself: the bone must really be there.
        const onEvery = others.every((b) => {
          const found = resolveBoneNames([flipped], b!)[flipped];
          return b!.some((bone) => bone.name === found);
        });
        if (!onEvery) continue;
        const twin = twins.get(boneOf(e.own))!;
        const [from, to] = side === 'target' ? [flipped, twin] : [twin, flipped];
        if (from in next) continue;
        next[from] = to;
        added.push(`${from} → ${to}`);
      }
      if (added.length === 0) continue;
      ops.push({ type: 'setParam', nodeId: mapId, paramPath: 'map', value: next });
      mirrored.push(...added);
      break;
    }
  }
  return { ops, mirrored, left };
}
