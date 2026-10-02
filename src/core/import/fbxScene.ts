// #1434 — an FBX file's scene: its empties and its unskinned meshes as Blender's FBX importer lays
// them out, re-expressed in Basher's Y-up.
//
// ── THE SPLIT BLENDER MAKES ───────────────────────────────────────────────────────────────────
//
// Blender's importer turns the file's axes and unit into one `global_matrix` and puts it on the
// TOP-LEVEL objects only (`io_scene_fbx/import_fbx.py:3152-3162`, applied at `:2377-2378`). Every
// other object keeps its local transform as the file states it, and every mesh keeps its vertex
// data as the file holds it (`:1804`). Blender's own exporter writes the reverse on every top-level
// object (−90° about X and ×100), so on a round trip the two cancel and every field reads what was
// authored (measured, 5.1.1: `blender-oracle-fbx-rigless-hierarchy.json`).
//
// three's loader applies nothing, so its top-level nodes read the exporter's −90° and ×100 and the
// meshes draw right through them. Stored like that (#1440), an unskinned mesh's Object read −90°
// about X where Blender reads 0: the drawn result was right and the fields were wrong.
//
// ── RE-EXPRESSED IN Y-UP ──────────────────────────────────────────────────────────────────────
//
// Blender's scene is Z-up and Basher's is Y-up. The same split in Y-up is Blender's scene with every
// object's frame and every point turned by `A`, Z-up → Y-up (`(x, y, z) → (x, z, −y)`): an object's
// matrix is conjugated, `A · M · A⁻¹`, and its points become `A · p`. That is exactly what Blender's
// glTF exporter writes for the same scene, which is the cross-check (`fbxRiglessOracle.test.ts`).
//
// With `U(n)` a node's world as three reads it, in metres, the Y-up world is `U(n) · A⁻¹`, so:
//   - a top-level node's local is `U(n) · A⁻¹`: position `s·t`, rotation `q · A⁻¹`, scale `s·sc`
//     with its Y and Z swapped,
//   - a node under a written node is `A · L · A⁻¹`: position `A·t`, rotation `A · q · A⁻¹`, and the
//     scale's Y and Z swapped — permuted, not decomposed, so a negative scale stays as stated,
//   - a node under a bone is `B⁻¹ · U(n) · A⁻¹`, with `B` the bone's frame in the rig the rig reader
//     built (Basher parents at the bone's head, `boneParent.ts`).
// The drawn world is unchanged: `U(n) · A⁻¹ · A · p = U(n) · p`, which is what three draws.
//
// It assumes the file declares FBX's standard axes (Y up), as three's loader does: the loader never
// reads the declared axes (#1444).
//
// ── KEYS (#1441) ──────────────────────────────────────────────────────────────────────────────
//
// Every case above is one shape: the Y-up local is `G · L · A⁻¹`, with `L` the node's own local as
// three reads it and `G` a frame fixed per node — `A` under a written node, `s` at the top, and
// `P⁻¹ · s · W(parent)` otherwise (`P` the Y-up world of what it hangs under, `W` three's world of its
// own parent). A key replaces `L` and nothing else, so its keys go through the same `G`. When `G` is a
// turn and one scale `k` (a similarity), each track folds on its own, exactly: a position `G · t`, a
// rotation `Q · q · A⁻¹`, a scale `k` times itself with Y and Z swapped. When it is not, a turning key
// would shear, and the keys are left out by name rather than kept wrong.
//
// Blender keys an object's `rotation_euler`, never a quaternion, decomposing each key continuously
// from the one before (`import_fbx.py:702`, `quat_to_euler(rot, rot_mode, prev)`); Basher's euler is
// XYZ degrees, so each key is the XYZ Euler of the folded quaternion, chained by `continuousEuler`.
// Both play LINEAR between keys (`:879`). At a key the two agree exactly; between keys each lerps its
// own Euler (Blender's in Z-up, ours in Y-up), so a turn about two axes at once can differ there.
//
// Blender plays no keys on a MESH whose parent is an armature (`import_fbx.py:1083-1086`): a mesh
// under a bone or under the armature keeps its rest, and its keys are named as left out.
//
// ── WHICH NODES THIS WRITES (V: one reader per node) ──────────────────────────────────────────
//
// The rig reader claims its bones, the empties inside its chain, and the armature node above each
// root, whose transform it folds into the bones (#1190). Those are never written here: written as a
// Group too, the armature's transform would apply twice. Everything else that is an empty or an
// unskinned mesh is written, under the nearest ancestor that stands in the scene: a written node, a
// bone (`parentBone`), the armature (its Object), or the top of the import.
//
// REF: src/core/import/fbx.ts (`parseFbx`, the rig and its claims), src/core/import/fbxMesh.ts (the
//      points this module's frames hold), src/nodes/boneParent.ts; issues #1434, #1440, #1061, #1319.

import { Euler, Matrix4, Quaternion, Vector3, type Object3D } from 'three';
import type { Vec3 } from '../../nodes/types';
import { continuousEuler, quaternionToEulerVec3, sanitizeBoneName } from './threeAdapter';

/** A node's transform as an Object or Group holds it in euler mode: rotation in XYZ degrees. */
export interface FbxNodeTransform {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

/** What a written node hangs under. */
export type FbxNodeParent =
  /** An earlier node of {@link FbxSceneRead.nodes}. */
  | { readonly kind: 'node'; readonly index: number }
  /** A bone of the rig, by its index in the skeleton: the node is parented to the bone. */
  | { readonly kind: 'bone'; readonly bone: number }
  /** The armature: the skeleton's Object. */
  | { readonly kind: 'armature' }
  /** Nothing: the top of the import. */
  | null;

/** #1441 — one keyed field of a node at the file's own key times, folded as its transform is. */
export interface FbxKeyTrack {
  readonly times: readonly number[];
  readonly values: readonly Vec3[];
}

/** #1441 — a node's keys, in its transform's units: rotation in XYZ degrees, continuous. */
export interface FbxNodeKeys {
  readonly position?: FbxKeyTrack;
  readonly rotation?: FbxKeyTrack;
  readonly scale?: FbxKeyTrack;
}

export interface FbxSceneNode {
  readonly name: string;
  /** The mesh it stands, as an index into the file's meshes, or null for an empty. */
  readonly mesh: number | null;
  readonly parent: FbxNodeParent;
  readonly transform: FbxNodeTransform;
  /** #1441 — its keys, or null when it has none. */
  readonly keys: FbxNodeKeys | null;
}

/** #1441 — a track of a node that is not a bone, as three's loader names it. */
export interface FbxNodeTrack {
  /** The node, spelled as `parseTrackName` spells it. */
  readonly node: string;
  readonly property: string;
  readonly times: readonly number[];
  readonly values: readonly number[];
}

/** #1441 — why a node's track does not play in the import. */
export type FbxLeftOutReason =
  /** No node of that name stands in the import: a curve, a skinned mesh, a bone outside the rig. */
  | 'no-node'
  /** More than one node has that name, so the track does not say which it moves. */
  | 'ambiguous'
  /** A mesh whose parent is an armature: Blender plays none of its keys. */
  | 'mesh-under-armature'
  /** Under its parent's stretch a key would shear. */
  | 'shear'
  /** A property that is not position, quaternion or scale. */
  | 'property'
  /** The armature node, keyed away from its rest: the skeleton's Object plays no keys of its own. */
  | 'armature-moves';

export interface FbxLeftOutTrack {
  readonly node: string;
  readonly property: string;
  readonly reason: FbxLeftOutReason;
}

export interface FbxSceneRead {
  /** Every written node, each after the node it hangs under. */
  readonly nodes: readonly FbxSceneNode[];
  readonly notices: readonly string[];
  /** #1441 — every node track that plays nowhere, and why. */
  readonly leftOut: readonly FbxLeftOutTrack[];
  /** #1441 — tracks on the armature node that hold its rest at every key. The fold already put that
   *  rest into the bones (#1190), so nothing of them is lost. */
  readonly armatureRestTracks: number;
}

export interface FbxSceneArgs {
  /** The nodes the rig reader claims: its bones, the empties inside its chain, its armature nodes. */
  readonly claimed: ReadonlySet<Object3D>;
  /** The armature nodes, a subset of `claimed`: a node under one hangs from the skeleton's Object. */
  readonly armatures: ReadonlySet<Object3D>;
  /** A claimed node's bone in the skeleton, or -1. */
  readonly boneIndexOf: (node: Object3D) => number;
  /** Each bone's frame in the rig, in metres, as the skeleton holds it (`boneWorldMatrices`). */
  readonly boneWorlds: readonly Matrix4[];
  /** Each unskinned mesh node, to its index among the file's meshes. */
  readonly meshOf: ReadonlyMap<Object3D, number>;
  readonly metresPerUnit: number;
  /** #1441 — the tracks of the read clip that key no bone of the rig. */
  readonly tracks: readonly FbxNodeTrack[];
}

/** Z-up → Y-up: `(x, y, z) → (x, z, −y)`, a quarter turn about −X. */
const A = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const A_INV = A.clone().invert();
const A_MATRIX = new Matrix4().makeRotationFromQuaternion(A_INV);
/** `G` under a written node: `A` itself. */
const A_FRAME = new Matrix4().makeRotationFromQuaternion(A);
const RAD2DEG = 180 / Math.PI;

/** A point or direction of the file, in Y-up: `A · p`. */
export function toYUp(x: number, y: number, z: number): Vec3 {
  return [x, z, -y];
}

/** Whether a node is one of the file's own, not the scene the loader made around them. */
const isFileNode = (node: Object3D): boolean => (node as { ID?: unknown }).ID !== undefined;

/**
 * The file's empties and unskinned meshes, each with its parent and its transform as Blender's split
 * re-expressed in Y-up (the header). A camera or a light refuses the whole import, as on the glTF
 * road: there is no native node for one yet, and a scene without it is not the file's scene. So does
 * a mesh shared by two nodes: a stored mesh belongs to one Object, and two copies would edit apart.
 */
export function readFbxScene(group: Object3D, args: FbxSceneArgs): FbxSceneRead {
  group.updateMatrixWorld(true);
  const s = args.metresPerUnit;
  const nodes: FbxSceneNode[] = [];
  const notices: string[] = [];
  const indexOf = new Map<Object3D, number>();
  /** Each written node's frame `G` (the header's KEYS). */
  const frames: Matrix4[] = [];
  const sharedBy = new Map<string, string>();

  group.traverse((node) => {
    if (args.claimed.has(node)) return;
    if (node === group && !isFileNode(node)) return; // the loader's own scene
    const kind = node as Object3D & {
      isCamera?: boolean;
      isLight?: boolean;
      isLine?: boolean;
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
      isBone?: boolean;
      geometry?: { uuid: string };
    };
    if (kind.isCamera || kind.isLight) {
      throw new Error(
        `FBX node "${node.name}" is a ${kind.isCamera ? 'camera' : 'light'}, which an import does not bring across yet (#1319).`,
      );
    }
    if (kind.isBone) return; // a bone outside the rig: its own skeleton's, which this file's import does not read
    if (kind.isLine) {
      notices.push(`curve "${node.name}" was left out: curves are not imported`);
      return;
    }
    const mesh = args.meshOf.get(node);
    if (kind.isMesh && mesh === undefined) return; // skinned, or left out with a notice already
    if (kind.isMesh && kind.geometry) {
      const other = sharedBy.get(kind.geometry.uuid);
      if (other !== undefined) {
        throw new Error(
          `FBX nodes "${other}" and "${node.name}" share one mesh, which an import does not bring across yet (#1061).`,
        );
      }
      sharedBy.set(kind.geometry.uuid, node.name);
    }

    // The nearest ancestor that stands in the scene.
    let parent: FbxNodeParent = null;
    let above = node.parent;
    for (; above; above = above.parent) {
      const written = indexOf.get(above);
      if (written !== undefined) {
        parent = { kind: 'node', index: written };
        break;
      }
      const bone = args.boneIndexOf(above);
      if (bone >= 0) {
        parent = { kind: 'bone', bone };
        break;
      }
      if (args.armatures.has(above)) {
        parent = { kind: 'armature' };
        break;
      }
    }

    // The two exact cases first: directly under a written node, or at the top with nothing of the
    // file's above it (the loader's own scene, or no parent at all when it returned this node).
    let transform: FbxNodeTransform;
    let frame: Matrix4;
    if (parent?.kind === 'node' && node.parent === above) {
      transform = underWritten(node);
      frame = A_FRAME;
    } else if (
      parent === null &&
      (node.parent === null || (node.parent === group && !isFileNode(group)))
    ) {
      transform = atTop(node, s);
      frame = new Matrix4().makeScale(s, s, s);
    } else {
      frame = decomposedFrame(node, s, parent, args.boneWorlds, (i) => nodes[i]);
      transform = decomposed(node, frame);
    }
    indexOf.set(node, nodes.length);
    frames.push(frame);
    nodes.push({
      name: node.name || `Empty_${nodes.length}`,
      mesh: mesh ?? null,
      parent,
      transform,
      keys: null,
    });
  });

  // #1441 — each node track to the node it keys, folded through that node's frame.
  const leftOut: FbxLeftOutTrack[] = [];
  let armatureRestTracks = 0;
  const byName = new Map<string, Object3D[]>();
  group.traverse((node) => {
    if ((node as { isBone?: boolean }).isBone || !isFileNode(node)) return;
    const name = sanitizeBoneName(node.name);
    byName.set(name, [...(byName.get(name) ?? []), node]);
  });
  const keyed = new Map<number, Map<string, FbxNodeTrack>>();
  for (const track of args.tracks) {
    const leave = (reason: FbxLeftOutReason) =>
      leftOut.push({ node: track.node, property: track.property, reason });
    const candidates = byName.get(track.node) ?? [];
    if (candidates.length > 1) {
      leave('ambiguous');
      continue;
    }
    const node = candidates[0];
    if (node && args.armatures.has(node)) {
      if (holdsRest(node, track)) armatureRestTracks += 1;
      else leave('armature-moves');
      continue;
    }
    const k = node ? indexOf.get(node) : undefined;
    if (k === undefined) {
      leave('no-node');
      continue;
    }
    if (!KEYED_PROPERTIES.has(track.property)) {
      leave('property');
      continue;
    }
    const { mesh, parent } = nodes[k];
    if (mesh !== null && (parent?.kind === 'bone' || parent?.kind === 'armature')) {
      leave('mesh-under-armature');
      continue;
    }
    if (!similarityOf(frames[k])) {
      leave('shear');
      continue;
    }
    const own = keyed.get(k) ?? new Map<string, FbxNodeTrack>();
    own.set(track.property, track);
    keyed.set(k, own);
  }
  for (const [k, own] of keyed) {
    nodes[k] = { ...nodes[k], keys: foldKeys(frames[k], own) };
  }
  return { nodes, notices, leftOut, armatureRestTracks };
}

const KEYED_PROPERTIES: ReadonlySet<string> = new Set(['position', 'quaternion', 'scale']);
const RELATIVE = 1e-6;

/** Whether every key of an armature node's track is the node's own local at load. */
function holdsRest(node: Object3D, track: FbxNodeTrack): boolean {
  const near = (a: number, b: number) =>
    Math.abs(a - b) <= RELATIVE * Math.max(1, Math.abs(a), Math.abs(b));
  const v = track.values;
  if (track.property === 'quaternion') {
    const q = node.quaternion;
    for (let i = 0; i + 3 < v.length; i += 4) {
      const dot = q.x * v[i] + q.y * v[i + 1] + q.z * v[i + 2] + q.w * v[i + 3];
      if (!near(Math.abs(dot), 1)) return false;
    }
    return true;
  }
  const rest = track.property === 'position' ? node.position : node.scale;
  if (track.property !== 'position' && track.property !== 'scale') return false;
  for (let i = 0; i + 2 < v.length; i += 3) {
    if (!near(v[i], rest.x) || !near(v[i + 1], rest.y) || !near(v[i + 2], rest.z)) return false;
  }
  return true;
}

/** `G` as one turn `q` and one positive scale `k`, or null when it stretches, shears or mirrors. */
function similarityOf(frame: Matrix4): { k: number; q: Quaternion } | null {
  const t = new Vector3();
  const q = new Quaternion();
  const scale = new Vector3();
  frame.decompose(t, q, scale);
  const k = scale.x;
  if (!(k > 0) || Math.abs(scale.y - k) > RELATIVE * k || Math.abs(scale.z - k) > RELATIVE * k) {
    return null;
  }
  const back = new Matrix4().compose(t, q, new Vector3(k, k, k));
  const size = Math.max(1, ...frame.elements.map(Math.abs));
  return back.elements.some((e, i) => Math.abs(e - frame.elements[i]) > RELATIVE * size)
    ? null
    : { k, q };
}

/**
 * A node's tracks through its frame `G` (the header): each at its own key times, a position `G · t`,
 * a rotation `Q · q · A⁻¹` as XYZ degrees chained key to key, a scale `k` times itself with Y and Z
 * swapped. Only called with a similarity `G`.
 */
function foldKeys(frame: Matrix4, tracks: ReadonlyMap<string, FbxNodeTrack>): FbxNodeKeys {
  const { k, q: turn } = similarityOf(frame)!;
  const keys: { -readonly [K in keyof FbxNodeKeys]: FbxKeyTrack } = {};
  const position = tracks.get('position');
  if (position) {
    const values: Vec3[] = [];
    const p = new Vector3();
    for (let i = 0; i < position.times.length; i++) {
      const v = position.values;
      p.set(v[3 * i], v[3 * i + 1], v[3 * i + 2]).applyMatrix4(frame);
      values.push([p.x, p.y, p.z]);
    }
    keys.position = { times: position.times, values };
  }
  const quaternion = tracks.get('quaternion');
  if (quaternion) {
    const values: Vec3[] = [];
    const q = new Quaternion();
    // A SEQUENCE: each key's Euler is chained onto the one before (quaternionToEulerDoors census),
    // as Blender chains its own (`quat_to_euler(rot, rot_mode, prev)`).
    let previous: Vec3 | null = null;
    for (let i = 0; i < quaternion.times.length; i++) {
      const v = quaternion.values;
      q.set(v[4 * i], v[4 * i + 1], v[4 * i + 2], v[4 * i + 3]);
      const folded = turn.clone().multiply(q).multiply(A_INV);
      previous = continuousEuler(quaternionToEulerVec3(folded), previous);
      values.push([previous[0] * RAD2DEG, previous[1] * RAD2DEG, previous[2] * RAD2DEG]);
    }
    keys.rotation = { times: quaternion.times, values };
  }
  const scale = tracks.get('scale');
  if (scale) {
    const v = scale.values;
    keys.scale = {
      times: scale.times,
      values: scale.times.map((_, i) => [k * v[3 * i], k * v[3 * i + 2], k * v[3 * i + 1]] as Vec3),
    };
  }
  return keys;
}

/** `A · L · A⁻¹` of the node's own local transform: exact, the scale permuted. */
function underWritten(node: Object3D): FbxNodeTransform {
  const { x, y, z } = node.position;
  const q = A.clone().multiply(node.quaternion).multiply(A_INV);
  return {
    position: toYUp(x, y, z),
    rotation: degrees(q),
    scale: [node.scale.x, node.scale.z, node.scale.y],
  };
}

/** `U(n) · A⁻¹` for a node whose parent is the loader's own (identity) scene: exact. */
function atTop(node: Object3D, s: number): FbxNodeTransform {
  const q = node.quaternion.clone().multiply(A_INV);
  return {
    position: [node.position.x * s, node.position.y * s, node.position.z * s],
    rotation: degrees(q),
    scale: [node.scale.x * s, node.scale.z * s, node.scale.y * s],
  };
}

/**
 * The frame `G` of every other case — under a bone, under the armature, under the top through a file
 * node the loader returned as its scene, or under a written node across claimed ones: the parent's
 * Y-up world inverted, times three's world of the node's own parent, in metres. `G · L · A⁻¹` is then
 * the node's Y-up world made local, since three's world of the node is its parent's times `L`.
 */
function decomposedFrame(
  node: Object3D,
  s: number,
  parent: FbxNodeParent,
  boneWorlds: readonly Matrix4[],
  nodeAt: (i: number) => FbxSceneNode,
): Matrix4 {
  const unit = new Matrix4().makeScale(s, s, s);
  const above = node.parent ? node.parent.matrixWorld : new Matrix4();
  return worldOf(parent, boneWorlds, nodeAt).invert().multiply(unit).multiply(above);
}

/**
 * A node's local from its frame: `G · L · A⁻¹`, decomposed. Recomposed and compared, so a placement
 * an Object cannot hold (a shear from a non-uniform scale under a turn) is refused rather than kept
 * wrong.
 */
function decomposed(node: Object3D, frame: Matrix4): FbxNodeTransform {
  const local = frame.clone().multiply(node.matrix).multiply(A_MATRIX);
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  local.decompose(position, quaternion, scale);
  const back = new Matrix4().compose(position, quaternion, scale);
  const size = Math.max(1, ...local.elements.map(Math.abs));
  if (back.elements.some((e, i) => Math.abs(e - local.elements[i]) > 1e-6 * size)) {
    throw new Error(
      `FBX node "${node.name}" has a placement an Object cannot hold (a scale that shears under its parent's turn).`,
    );
  }
  return { position: position.toArray(), rotation: degrees(quaternion), scale: scale.toArray() };
}

/** The Y-up world of what a node hangs under: a bone's frame in the rig, the armature's Object
 *  (identity), the top (identity), or a written node, composed down from whichever of those its
 *  own chain starts at. */
function worldOf(
  parent: FbxNodeParent,
  boneWorlds: readonly Matrix4[],
  nodeAt: (i: number) => FbxSceneNode,
): Matrix4 {
  const chain: FbxSceneNode[] = [];
  let at = parent;
  while (at?.kind === 'node') {
    const n = nodeAt(at.index);
    chain.unshift(n);
    at = n.parent;
  }
  const world = at?.kind === 'bone' ? boneWorlds[at.bone].clone() : new Matrix4();
  for (const n of chain) world.multiply(matrixOf(n.transform));
  return world;
}

function matrixOf(t: FbxNodeTransform): Matrix4 {
  const q = new Quaternion().setFromEuler(
    new Euler(t.rotation[0] / RAD2DEG, t.rotation[1] / RAD2DEG, t.rotation[2] / RAD2DEG, 'XYZ'),
  );
  return new Matrix4().compose(new Vector3(...t.position), q, new Vector3(...t.scale));
}

/** A rest orientation in XYZ degrees: one value, read once, never interpolated (point-in-time). */
function degrees(q: Quaternion): Vec3 {
  const [x, y, z] = quaternionToEulerVec3(q);
  return [x * RAD2DEG, y * RAD2DEG, z * RAD2DEG];
}
