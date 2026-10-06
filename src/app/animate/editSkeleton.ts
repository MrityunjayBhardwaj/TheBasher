// Edit mode's skeleton operations (#1339): build and change a rest skeleton by hand.
//
// Pure over a `BoneSpec[]`, so every rule is tested without a graph; `mutator.rig.editSkeleton` and
// the Edit-mode keys and panel all call `applySkeletonEdit`, so a director and the agent build the
// same skeleton the same way.
//
// THE MODEL IS JOINTS. A Basher bone is a joint: a local transform under its parent, its tail being
// its child (the glTF, Houdini KineFX and Maya model). So the operations are the joint ones —
// Houdini's Skeleton SOP (create, split link, delete with or without reparent, tweak with Child
// Compensate) and Maya's (`insertJoint`, `removeJoint`, `reroot`) — under Blender's names where one
// maps: extrude adds a child, subdivide splits the link to the child, switch direction is a reroot.
// (Blender's own operators work on head/tail bones, `editors/armature/armature_add.cc:1580-1974`,
// `armature_edit.cc:685-1025`, `armature_relations.cc:836-1190`; the counterpart of "fill between
// two joints" here is parenting one to the other.)
//
// WHAT EVERY OPERATION KEEPS. A joint nobody asked to move stays where it stands in the world: a
// re-parented, rerooted or orphaned joint gets the local transform that keeps its world one, and
// "transform, children stay" is Houdini's Child Compensate. Exactly, with one limit: a joint's
// transform is position, rotation and scale, so it cannot hold the shear a rotated joint picks up
// under a non-uniformly scaled parent (nor can Maya's or Houdini's). There the head stays exactly
// where it was, and the rotation and scale are the nearest the joint can carry. New joints go to the END of the list,
// so every existing joint keeps its index and its name.
//
// NAMES. A bone name is part of a channel address (`bones.<name>.rotation`), so every name an
// operation gives is free of the path separators `.`, `[`, `]`, `:`, `/` (the importers'
// `sanitizeBoneName`) and unique among the skeleton's bones with a `_001` suffix — never Blender's
// `.001`, which would put a separator back.
//
// REF: src/agent/mutators/builders/editSkeleton.ts (the agent's door); src/viewport/boneShape.ts
//      (`boneWorldMatrices`, the one rest walk); issue #1339.

import * as THREE from 'three';
import { boneWorldMatrices } from '../../viewport/boneShape';
import { eulerXYZFromQuat, quatFromEulerXYZ } from '../../nodes/bonePose';
import { sanitizeBoneName } from '../../core/import/threeAdapter';
import type { BoneSpec, Vec3 } from '../../nodes/types';

export type SkeletonEdit =
  /** A new joint: a root, or a child of `parent`, at `position` in its parent's frame. */
  | {
      readonly op: 'add';
      readonly parent: string | null;
      readonly position: Vec3;
      readonly name?: string;
    }
  /**
   * A new child of `from` (Blender's extrude from a tip). `offset` is in `from`'s frame; without
   * one, the chain continues: the child sits as far from `from`, in the same direction, as `from`
   * sits from its parent (one unit up +Y for a root).
   */
  | {
      readonly op: 'extrude';
      readonly from: string;
      readonly offset?: Vec3;
      readonly name?: string;
    }
  /** Split the link from `bone` to its one child into `cuts + 1` equal pieces; the child moves to the last. */
  | { readonly op: 'subdivide'; readonly bone: string; readonly cuts: number }
  /** Remove `bone`. Its children go to its parent (`reparent`), or become roots; both keep their place. */
  | { readonly op: 'delete'; readonly bone: string; readonly reparent: boolean }
  /** Make `parent` the parent of `bone` (null = a root), keeping `bone` where it stands. */
  | { readonly op: 'parent'; readonly bone: string; readonly parent: string | null }
  /** Make `bone` the root, reversing every link on the way from the old root (Maya `reroot`). */
  | { readonly op: 'reroot'; readonly bone: string }
  /**
   * Set `bone`'s rest transform in its parent's frame (any of the three). Its children follow it,
   * or stay where they stand (Houdini's Child Compensate).
   */
  | {
      readonly op: 'transform';
      readonly bone: string;
      readonly position?: Vec3;
      readonly rotation?: Vec3;
      readonly scale?: Vec3;
      readonly children: 'follow' | 'stay';
    }
  /**
   * #1340 — orient `bone` (and with `chain`, everything below it): its +Y aims at its child (the
   * mean of its children's heads), and its +Z turns about that aim toward `up` (Blender's Recalculate
   * Roll, Maya's orient joint, Houdini's Orient Joints). A joint with no child keeps the way it
   * points; within a `chain`, it takes its parent's orientation (Maya's end joints, zeroed). Heads
   * stay where they are, and so does every joint not oriented.
   */
  | {
      readonly op: 'orient';
      readonly bone: string;
      readonly up: OrientUp;
      readonly chain?: boolean;
      /** Blender's Shortest Rotation: flip the result when it would turn +Z more than 90°. */
      readonly axisOnly?: boolean;
    }
  /** #1340 — store `bone`'s preferred angle (XYZ radians), or clear it with null. */
  | { readonly op: 'preferredAngle'; readonly bone: string; readonly angle: Vec3 | null }
  /**
   * #1341 — make the skeleton symmetric across the armature's plane through the origin ⟂ `axis`:
   * each of `bones` with a side in its name (`flipSideName`) gets a mirror twin, made or updated.
   * When both twins are listed, `direction` picks the source, as Blender's does: `negative` copies
   * the one on the − side onto the + side.
   */
  | {
      readonly op: 'symmetrize';
      readonly bones: readonly string[];
      readonly axis?: 'X' | 'Y' | 'Z';
      readonly direction?: 'negative' | 'positive';
    };

/**
 * #1340 — what an oriented joint's +Z turns toward, Blender's roll types in joint terms:
 * - `axis`: a direction in the armature's space (Global ±X/±Y/±Z, or the view axis);
 * - `tangent`: Local ±X / ±Z Tangent — the bisector of the bone and its parent bone (X), or their
 *   cross product (Z), from the first ancestor that does not lie on a straight line;
 * - `matchBone`: the +Z of another bone (Active Bone);
 * - `point`: toward a point in the armature's space (Cursor).
 */
export type OrientUp =
  | { readonly kind: 'axis'; readonly axis: Vec3 }
  | { readonly kind: 'tangent'; readonly axis: '+X' | '-X' | '+Z' | '-Z' }
  | { readonly kind: 'matchBone'; readonly bone: string }
  | { readonly kind: 'point'; readonly point: Vec3 };

export type SkeletonEditResult =
  | {
      readonly ok: true;
      readonly bones: BoneSpec[];
      /** The names the edit gave to new joints, in the order made. */
      readonly added: readonly string[];
      /** The bone a director would select next: the new tip, or the one edited. Null after a delete. */
      readonly active: string | null;
    }
  | { readonly ok: false; readonly reason: string };

const IDENTITY_SCALE_EPS = 1e-9;

/** A name free of the path separators and unique among `taken`, `_001`-suffixed when it must be. */
export function boneNameFor(wanted: string, taken: ReadonlySet<string>): string {
  const clean = sanitizeBoneName(wanted.trim()) || 'Bone';
  if (!taken.has(clean)) return clean;
  const suffix = /^(.*)_(\d{3,})$/.exec(clean);
  const base = suffix ? suffix[1] : clean;
  let n = suffix ? Number(suffix[2]) : 0;
  let candidate: string;
  do candidate = `${base}_${String(++n).padStart(3, '0')}`;
  while (taken.has(candidate));
  return candidate;
}

function localMatrix(b: BoneSpec): THREE.Matrix4 {
  const q = quatFromEulerXYZ(b.rotation);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...b.position),
    new THREE.Quaternion(q[0], q[1], q[2], q[3]),
    new THREE.Vector3(...(b.scale ?? [1, 1, 1])),
  );
}

/** `b` with the local transform `m`; scale written only when it is not 1 or the bone had one. */
function withLocal(b: BoneSpec, m: THREE.Matrix4): BoneSpec {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(p, q, s);
  const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  const rotation = eulerXYZFromQuat([q.x, q.y, q.z, q.w]).map(clean) as unknown as Vec3;
  const scale: Vec3 = [s.x, s.y, s.z];
  const unit = scale.every((c) => Math.abs(c - 1) < IDENTITY_SCALE_EPS);
  const next: BoneSpec = {
    ...b,
    position: [clean(p.x), clean(p.y), clean(p.z)],
    rotation,
  };
  if (unit && b.scale === undefined) {
    const { scale: _drop, ...rest } = next as BoneSpec & { scale?: Vec3 };
    void _drop;
    return rest;
  }
  return { ...next, scale };
}

function childrenOf(bones: readonly BoneSpec[], i: number): number[] {
  return bones.flatMap((b, k) => (b.parent === i ? [k] : []));
}

/** Is `maybe` `of` itself or below it? */
function isUnder(bones: readonly BoneSpec[], maybe: number, of: number): boolean {
  for (let at = maybe, hops = 0; at >= 0 && hops <= bones.length; at = bones[at].parent, hops++) {
    if (at === of) return true;
  }
  return false;
}

/**
 * Re-solve, parents first, every joint that should stand still (`keep`) but no longer does: its
 * local becomes the one that puts it back where it stood (`was`), under its parent's world as it is
 * NOW. A joint that still stands where it stood keeps its local untouched, so a rest edit rewrites
 * only what it has to. Going parents first is what keeps the shear limit (above) local: a joint bent
 * a little by it does not carry the error down to its children, which are solved against it as bent.
 */
function settle(
  next: BoneSpec[],
  was: ReadonlyMap<string, THREE.Matrix4>,
  keep: (name: string) => boolean,
): BoneSpec[] {
  const now: (THREE.Matrix4 | null)[] = next.map(() => null);
  const same = (a: THREE.Matrix4, b: THREE.Matrix4) =>
    a.elements.every((x, i) => Math.abs(x - b.elements[i]) < 1e-9);
  const solve = (i: number, depth: number): THREE.Matrix4 => {
    const known = now[i];
    if (known) return known;
    const p = next[i].parent;
    const parentWorld =
      p >= 0 && p < next.length && depth <= next.length ? solve(p, depth + 1) : new THREE.Matrix4();
    const target = was.get(next[i].name);
    let world = parentWorld.clone().multiply(localMatrix(next[i]));
    if (target && keep(next[i].name) && !same(world, target)) {
      next[i] = withLocal(next[i], parentWorld.clone().invert().multiply(target));
      world = parentWorld.clone().multiply(localMatrix(next[i]));
    }
    now[i] = world;
    return world;
  };
  for (let i = 0; i < next.length; i++) solve(i, 0);
  return next;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const headOf = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
const axisOf = (m: THREE.Matrix4, i: 0 | 1 | 2) =>
  new THREE.Vector3().setFromMatrixColumn(m, i).normalize();

/**
 * The +Z an oriented joint turns toward, in the armature's space, or null when the rule gives none
 * (a tangent on a straight chain to the root). `aim` is the joint's new +Y; `worlds` are the rest
 * worlds, and `oriented` the frames already given to joints above it in this edit.
 */
function upFor(
  bones: readonly BoneSpec[],
  i: number,
  aim: THREE.Vector3,
  up: OrientUp,
  worlds: readonly THREE.Matrix4[],
  oriented: ReadonlyMap<number, THREE.Matrix4>,
): THREE.Vector3 | null {
  const head = headOf(worlds[i]);
  switch (up.kind) {
    case 'axis':
      return new THREE.Vector3(...up.axis).normalize();
    case 'point':
      return new THREE.Vector3(...up.point).sub(head).normalize();
    case 'matchBone': {
      const k = bones.findIndex((b) => b.name === up.bone);
      if (k < 0) return null;
      return axisOf(oriented.get(k) ?? worlds[k], 2);
    }
    case 'tangent': {
      // Blender: dir_a is the bone, dir_b runs from the parent bone's tail back to its head; walk
      // up while the two lie on a line (`armature_edit.cc`, CALC_ROLL_TAN_*).
      const v = new THREE.Vector3();
      for (let at = i, p = bones[i].parent; p >= 0; at = p, p = bones[p].parent) {
        const dirB = headOf(worlds[p]).sub(headOf(worlds[at])).normalize();
        if (up.axis.endsWith('Z')) v.crossVectors(aim, dirB);
        else v.addVectors(aim, dirB);
        if (v.length() >= 1e-5) {
          v.normalize();
          return up.axis.startsWith('-') ? v.negate() : v;
        }
      }
      return null;
    }
  }
}

/** A frame whose +Y is `aim` and whose +Z is `up` made perpendicular to it (Gram–Schmidt). */
function frameFor(aim: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion | null {
  const z = up.clone().sub(aim.clone().multiplyScalar(up.dot(aim)));
  if (z.length() < 1e-9) return null;
  z.normalize();
  const x = new THREE.Vector3().crossVectors(aim, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, aim, z));
}

/**
 * #1341 — a bone name with its side flipped, or the name itself when it has no side. Blender's rules
 * (`BLI_string_flip_side_name`): a side letter L/R (either case) after a final separator `.` `_`
 * `-` or space, or before a leading one; or `left`/`right` (any case, kept) at the start or the end.
 * ONE addition, measured on the example character: a capitalised `Left`/`Right` word inside the name
 * (`mixamorig_LeftArm`), which Blender misses and Houdini's token rename finds.
 */
export function flipSideName(name: string): string {
  const swap = (side: string) => {
    const map: Record<string, string> = { L: 'R', R: 'L', l: 'r', r: 'l' };
    return map[side] ?? side;
  };
  const suffix = /^(.*[._\- ])([LRlr])$/.exec(name);
  if (suffix) return suffix[1] + swap(suffix[2]);
  const prefix = /^([LRlr])([._\- ].*)$/.exec(name);
  if (prefix) return swap(prefix[1]) + prefix[2];
  const word = (w: string) =>
    ({ left: 'right', right: 'left', Left: 'Right', Right: 'Left', LEFT: 'RIGHT', RIGHT: 'LEFT' })[
      w
    ] ?? w;
  const ends = /^(left|right|Left|Right|LEFT|RIGHT)(.*)$/.exec(name);
  if (ends) return word(ends[1]) + ends[2];
  const tail = /^(.*?)(left|right|Left|Right|LEFT|RIGHT)$/.exec(name);
  if (tail) return tail[1] + word(tail[2]);
  const inner = /^(.*?[a-z0-9_])(Left|Right)([A-Z0-9_].*)$/.exec(name);
  if (inner) return inner[1] + word(inner[2]) + inner[3];
  return name;
}

export function applySkeletonEdit(
  bones: readonly BoneSpec[],
  edit: SkeletonEdit,
): SkeletonEditResult {
  const indexOf = new Map(bones.map((b, i) => [b.name, i]));
  const find = (name: string): number | null => indexOf.get(name) ?? null;
  const missing = (name: string) => ({
    ok: false as const,
    reason: `bone "${name}" is not on this skeleton. Its bones are: ${bones
      .slice(0, 12)
      .map((b) => b.name)
      .join(', ')}${bones.length > 12 ? `, … (${bones.length} total)` : ''}.`,
  });
  const taken = new Set(bones.map((b) => b.name));
  const worlds = boneWorldMatrices(bones);
  const was = new Map(bones.map((b, i) => [b.name, worlds[i]]));
  const all = () => true;

  switch (edit.op) {
    case 'add': {
      const parent = edit.parent === null ? -1 : find(edit.parent);
      if (parent === null) return missing(edit.parent!);
      const name = boneNameFor(edit.name ?? 'Bone', taken);
      return {
        ok: true,
        bones: [
          ...bones,
          { name, parent, position: [...edit.position] as Vec3, rotation: [0, 0, 0] },
        ],
        added: [name],
        active: name,
      };
    }

    case 'extrude': {
      const from = find(edit.from);
      if (from === null) return missing(edit.from);
      const own = bones[from];
      const offset: Vec3 =
        edit.offset ??
        (own.parent >= 0 && Math.hypot(...own.position) > 1e-9 ? [...own.position] : [0, 1, 0]);
      const name = boneNameFor(edit.name ?? own.name, taken);
      return {
        ok: true,
        bones: [...bones, { name, parent: from, position: offset, rotation: [0, 0, 0] }],
        added: [name],
        active: name,
      };
    }

    case 'subdivide': {
      const at = find(edit.bone);
      if (at === null) return missing(edit.bone);
      const cuts = Math.floor(edit.cuts);
      if (!(cuts >= 1)) return { ok: false, reason: 'subdivide needs at least one cut.' };
      const kids = childrenOf(bones, at);
      if (kids.length !== 1) {
        return {
          ok: false,
          reason:
            kids.length === 0
              ? `"${edit.bone}" has no child, so there is no link to split; extrude to add one.`
              : `"${edit.bone}" has ${kids.length} children, so which link to split is not one answer; subdivide the link's child's parent chain from a joint with one child.`,
        };
      }
      const child = kids[0];
      const step = bones[child].position.map((c) => c / (cuts + 1)) as unknown as Vec3;
      const next = bones.map((b) => ({ ...b }));
      const added: string[] = [];
      let parent = at;
      for (let k = 0; k < cuts; k++) {
        const name = boneNameFor(bones[at].name, taken);
        taken.add(name);
        added.push(name);
        next.push({ name, parent, position: [...step] as Vec3, rotation: [0, 0, 0] });
        parent = next.length - 1;
      }
      // The child moves to the last piece. Every piece is unrotated and unscaled, so the child's
      // world is unchanged: W_at · T(k·step) · T(step) · R · S = W_at · T(p) · R · S.
      next[child] = { ...next[child], parent, position: step };
      return { ok: true, bones: next, added, active: added[0] };
    }

    case 'delete': {
      const at = find(edit.bone);
      if (at === null) return missing(edit.bone);
      if (bones.length === 1) {
        return {
          ok: false,
          reason: 'a skeleton keeps at least one bone; delete the armature to remove it all.',
        };
      }
      const newParent = edit.reparent ? bones[at].parent : -1;
      // The children change parent here; `settle` gives each the local that keeps its place.
      const kept = bones.map((b) => (b.parent === at ? { ...b, parent: newParent } : b));
      const shift = (p: number) => (p > at ? p - 1 : p);
      const out = kept
        .filter((_, i) => i !== at)
        .map((b) => ({ ...b, parent: b.parent < 0 ? b.parent : shift(b.parent) }));
      return { ok: true, bones: settle(out, was, all), added: [], active: null };
    }

    case 'parent': {
      const at = find(edit.bone);
      if (at === null) return missing(edit.bone);
      const parent = edit.parent === null ? -1 : find(edit.parent);
      if (parent === null) return missing(edit.parent!);
      if (parent >= 0 && isUnder(bones, parent, at)) {
        return {
          ok: false,
          reason: `"${edit.parent}" is "${edit.bone}" or below it, so parenting would make a loop.`,
        };
      }
      const next = bones.map((b) => ({ ...b }));
      next[at] = { ...bones[at], parent };
      return { ok: true, bones: settle(next, was, all), added: [], active: bones[at].name };
    }

    case 'reroot': {
      const at = find(edit.bone);
      if (at === null) return missing(edit.bone);
      const path: number[] = [];
      for (let i = at, hops = 0; i >= 0 && hops <= bones.length; i = bones[i].parent, hops++) {
        path.push(i);
      }
      // path: at, its parent, …, the old root. Each one's parent becomes the one before it; `settle`
      // then solves every joint, parents first, against its new parent's world as recomposed.
      const next = bones.map((b) => ({ ...b }));
      next[at] = { ...next[at], parent: -1 };
      for (let k = 1; k < path.length; k++) {
        next[path[k]] = { ...next[path[k]], parent: path[k - 1] };
      }
      return { ok: true, bones: settle(next, was, all), added: [], active: bones[at].name };
    }

    case 'orient': {
      const at = find(edit.bone);
      if (at === null) return missing(edit.bone);
      const scope: number[] = [at];
      if (edit.chain) {
        for (let k = 0; k < scope.length; k++) scope.push(...childrenOf(bones, scope[k]));
      }
      // Parents first, so a joint's end-joint rule and a matched bone read frames already set.
      const oriented = new Map<number, THREE.Matrix4>();
      for (const i of scope) {
        worlds[i].decompose(_p, _q, _s);
        const head = _p.clone();
        const scale = _s.clone();
        const kids = childrenOf(bones, i);
        const toKids = kids
          .reduce((sum, k) => sum.add(headOf(worlds[k])), new THREE.Vector3())
          .divideScalar(Math.max(kids.length, 1))
          .sub(head);
        let rotation: THREE.Quaternion | null = null;
        if (kids.length > 0 && toKids.length() > 1e-9) {
          const aim = toKids.normalize();
          const up = upFor(bones, i, aim, edit.up, worlds, oriented);
          rotation = up ? frameFor(aim, up) : null;
          // No usable up (parallel to the aim, or a straight chain): only the aim changes, the
          // current +Z made perpendicular to it.
          rotation ??= frameFor(aim, axisOf(worlds[i], 2)) ?? _q.clone();
          if (
            edit.axisOnly &&
            axisOf(worlds[i], 2).dot(new THREE.Vector3(0, 0, 1).applyQuaternion(rotation)) < 0
          ) {
            rotation =
              frameFor(aim, new THREE.Vector3(0, 0, -1).applyQuaternion(rotation)) ?? rotation;
          }
        } else if (edit.chain && i !== at) {
          // An end joint within a chain takes its parent's orientation (Maya's zeroed end joint).
          const parent = oriented.get(bones[i].parent) ?? worlds[bones[i].parent];
          rotation = new THREE.Quaternion().setFromRotationMatrix(
            new THREE.Matrix4().extractRotation(parent),
          );
        } else {
          // A lone end joint keeps the way it points and turns about it.
          const aim = axisOf(worlds[i], 1);
          const up = upFor(bones, i, aim, edit.up, worlds, oriented);
          rotation = (up && frameFor(aim, up)) ?? _q.clone();
        }
        oriented.set(i, new THREE.Matrix4().compose(head, rotation, scale));
      }
      const target = new Map(was);
      for (const [i, m] of oriented) target.set(bones[i].name, m);
      return {
        ok: true,
        bones: settle(
          bones.map((b) => ({ ...b })),
          target,
          all,
        ),
        added: [],
        active: bones[at].name,
      };
    }

    case 'preferredAngle': {
      const at = find(edit.bone);
      if (at === null) return missing(edit.bone);
      const next = bones.map((b) => ({ ...b }));
      if (edit.angle === null) {
        const { preferredAngle: _gone, ...rest } = next[at] as BoneSpec & { preferredAngle?: Vec3 };
        void _gone;
        next[at] = rest;
      } else {
        next[at] = { ...next[at], preferredAngle: [...edit.angle] as Vec3 };
      }
      return { ok: true, bones: next, added: [], active: bones[at].name };
    }

    case 'symmetrize': {
      const axis = 'XYZ'.indexOf(edit.axis ?? 'X');
      const normal = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
      // The mirror S = I − 2nnᵀ, and the twin's frame is −S·R — a half turn about the normal, a
      // proper rotation — so its local transform is the source's with the translation negated and
      // the rotation unchanged, and equal rotations pose the two sides as mirror images (Maya's
      // mirrorJoint behaviour).
      const mirror = new THREE.Matrix4().makeScale(
        axis === 0 ? -1 : 1,
        axis === 1 ? -1 : 1,
        axis === 2 ? -1 : 1,
      );
      const listed = new Set(edit.bones);
      const sources: number[] = [];
      for (const name of edit.bones) {
        const i = find(name);
        if (i === null) return missing(name);
        const twin = flipSideName(name);
        if (twin === name) continue; // no side, nothing to mirror (Blender skips it too)
        const j = find(twin);
        if (j !== null && listed.has(twin)) {
          // Both listed: the direction decides which is the source, by head along the axis.
          const delta = headOf(worlds[j]).getComponent(axis) - headOf(worlds[i]).getComponent(axis);
          const iOnNegative = delta > 0;
          if (delta === 0 || iOnNegative !== ((edit.direction ?? 'negative') === 'negative'))
            continue;
        }
        sources.push(i);
      }
      if (sources.length === 0) {
        return {
          ok: false,
          reason:
            'nothing to mirror: none of the bones has a side in its name (L/R, Left/Right), so none has a twin.',
        };
      }
      const next = bones.map((b) => ({ ...b }));
      const target = new Map(was);
      const names = new Set(next.map((b) => b.name));
      const added: string[] = [];
      // Twins first, so each twin's parent can be looked up by name below.
      for (const i of sources) {
        const twin = flipSideName(bones[i].name);
        if (!names.has(twin)) {
          names.add(twin);
          added.push(twin);
          next.push({ name: twin, parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] });
        }
      }
      const index = new Map(next.map((b, k) => [b.name, k]));
      for (const i of sources) {
        const src = bones[i];
        const j = index.get(flipSideName(src.name))!;
        const parentName = src.parent >= 0 ? bones[src.parent].name : null;
        const twinParent =
          parentName === null
            ? -1
            : (index.get(flipSideName(parentName)) ?? index.get(parentName)!);
        next[j] = {
          ...next[j],
          parent: twinParent,
          ...(src.preferredAngle ? { preferredAngle: [...src.preferredAngle] as Vec3 } : {}),
        };
        // Head at S·p; frame −S·R, which is the half turn about the normal applied to R.
        const head = headOf(worlds[i]).applyMatrix4(mirror);
        worlds[i].decompose(_p, _q, _s);
        const rot = new THREE.Quaternion().setFromAxisAngle(normal, Math.PI).multiply(_q);
        target.set(next[j].name, new THREE.Matrix4().compose(head, rot, _s.clone()));
      }
      return { ok: true, bones: settle(next, target, all), added, active: null };
    }

    case 'transform': {
      const at = find(edit.bone);
      if (at === null) return missing(edit.bone);
      const b = bones[at];
      const moved: BoneSpec = {
        ...b,
        ...(edit.position ? { position: [...edit.position] as Vec3 } : {}),
        ...(edit.rotation ? { rotation: [...edit.rotation] as Vec3 } : {}),
        ...(edit.scale ? { scale: [...edit.scale] as Vec3 } : {}),
      };
      const next = bones.map((x) => ({ ...x }));
      next[at] = moved;
      // Children follow: their locals are untouched, so the whole subtree rides the joint. Children
      // stay: every joint but this one is put back where it stood (Child Compensate), grandchildren
      // included, through the same `settle` every other op uses.
      if (edit.children === 'stay') settle(next, was, (name) => name !== b.name);
      return { ok: true, bones: next, added: [], active: b.name };
    }
  }
}
