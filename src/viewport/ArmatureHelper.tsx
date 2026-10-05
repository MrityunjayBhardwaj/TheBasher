// ArmatureHelper — draws every rig in the scene as Blender-style octahedral
// bones, so a character's skeleton is visible and its ROLL is judgeable by eye
// (#972, epic #971; closes the gap #970 names).
//
// Sibling of LightHelpers.tsx / CameraHelpers.tsx: a camera gets a frustum, a
// light gets a gizmo, an empty gets a glyph, a curve gets a line — and until
// now a rig got nothing. Same contract as those: renders only, marked
// `editorChrome` so the image render's hide-pass excludes it (V37), hidden in
// `rendered` shading at the mount site. V8 holds — no dispatch, no DAG write.
//
// Every rig it draws is an Object whose data is a Skeleton (#1056): a native character's
// armature and a motion's own rig alike, posed from the graph at the playhead. It once also
// scanned the scene for live three.js `Bone`s — the clone road's characters — and that scan
// retired with the clone road's character half (#1053): a native character's bones are never in
// the scene.
//
// The geometry and the roll handling live in boneShape.ts, which is pure and
// unit-tested; this file is placement and plumbing.
//
// REF: THESIS.md §11; vyapti V1, V8, V37;
//      ref/GROUND_TRUTH_BLENDER_ARMATURE_DISPLAY.md.

import { useCallback, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  type BoneFrame,
  poseTransforms,
  degenerateBasisCount,
  degenerateBasisNames,
  octahedralIndices,
  octahedralPositions,
  resetDegenerateBasisCount,
} from './boneShape';
import { armatureBounds, referencePlacement } from './referenceRig';
import type { ReferenceRig } from '../app/animate/referenceRigs';
import { skeletonObjectFrames } from './skeletonObjectPose';
import { useTimeStore } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';
import { useBoneSelectionStore } from '../app/stores/boneSelectionStore';
import { getActiveBone } from '../app/boneSelection';
import { armatureModeFor } from '../app/armatureMode';
import { selectNode, type SelectClickLike } from './selectNodeOnClick';
import { pickBone } from './armaturePick';
import { collectSkeletonObjects, type SkeletonObject } from '../app/skeletonObjects';
import { useDagStore } from '../core/dag/store';
import { uiEvaluatorCache } from '../app/uiEvaluatorCache';

/** Blender's default unselected bone wire. Chrome, so it reads as an overlay. */
const BONE_COLOR = '#c8d4e4';
/** The selected bone, drawn in the same accent the rest of the editor selects
 *  with. Colour, not size: a bone that grew on selection would move the very
 *  thing a director is trying to judge. */
const SELECTED_BONE_COLOR = '#f0a000';
/** The two per-instance colours. The material's own colour is white so these
 *  multiply through unchanged — a tinted material would make the selected bone
 *  a blend of two decisions rather than the colour it says it is. */
const BASE_COLOR = new THREE.Color(BONE_COLOR);
/** How far ahead of the skin a bone sorts when it is pickable at all. Small
 *  enough that no ordinary geometry can come between, and a MULTIPLIER rather
 *  than a subtraction so bones keep their own order among themselves. */
const PICK_DEPTH_BIAS = 1e-3;
const SELECTED_COLOR = new THREE.Color(SELECTED_BONE_COLOR);

/** The SOURCE rig, drawn in a different colour so the two are never confused —
 *  the entire value of the comparison depends on knowing which is which. */
const SOURCE_BONE_COLOR = '#ffb454';

/** Hard ceiling on instances, so a pathological rig cannot allocate unboundedly.
 *  Rigs here run to ~78 bones (BVH) and a few hundred at the very most. */
const MAX_BONES = 4096;

/** A source rig to draw beside the character it drives (#977), as `collectReferenceRigs` finds it. */
export type ReferenceRigInput = ReferenceRig;

/**
 * A bone name reduced to what every spelling of it agrees on, for the selected-bone highlight.
 *
 * Measured when the clone road drew its own live bones: the same glTF bone reached two readers
 * as `mixamorig_Hips` and `mixamorigHips` (three strips `[].:/`, the projection writes an
 * underscore), and compared raw they overlapped by ZERO names. Only skeleton Objects are drawn
 * now; the reduction stays so a bone named from any surface still lights.
 */
function normalizeBoneName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * One InstancedMesh for ALL armatures in the scene.
 *
 * `grep -rn "InstancedMesh" src/` was 0 hits before this — rigs run to ~78
 * bones, so a mesh per bone would add ~78 draw calls per character. One
 * octahedron geometry with a per-instance matrix keeps it at one, and gives v2
 * an `instanceId` to map back to a bone name for selection.
 */
export function ArmatureHelper({
  sourceRigs,
  showSourceRigs = false,
  skeletonObjects,
}: {
  /** Source rigs to draw beside their characters. Empty when nothing is
   *  retargeted, or when the diagnostic is off. */
  readonly sourceRigs?: readonly ReferenceRigInput[];
  readonly showSourceRigs?: boolean;
  /** #1056 — Objects whose data is a Skeleton: every rig this draws, posed from the DAG. */
  readonly skeletonObjects?: readonly SkeletonObject[];
} = {}) {
  const boneDisplay = useViewportStore((s) => s.boneDisplay);
  const bonesInFront = useViewportStore((s) => s.bonesInFront);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const refMeshRef = useRef<THREE.InstancedMesh>(null);
  const parentInverse = useRef(new THREE.Matrix4());
  // What the LAST fill drew, so a click can be answered by the same flattening
  // that produced the instance it hit. Read in an event handler, never in
  // render, so a ref rather than state — and written in the same loop that sets
  // the matrices, so the two cannot describe different frames.
  const picks = useRef<{
    offsets: number[];
    frames: BoneFrame[];
    /** Per armature: the skeleton Object a click on it selects. */
    owners: string[];
  }>({ offsets: [], frames: [], owners: [] });
  // Which instance is currently painted as selected, so the colour buffer is
  // rewritten when it CHANGES rather than on every frame of a 4096-instance
  // mesh.
  const lastHighlight = useRef(-2);
  /** How many instances the last repaint actually reached. The highlight alone does not
   *  say it: the drawn count grows on events that never touch it, and every instance past
   *  this number is still at three's white default (#1148). */
  const lastPaintedCount = useRef(0);
  const lineRef = useRef<THREE.LineSegments>(null);
  /** What was last WRITTEN to the three materials, not read back from one. */
  const depthApplied = useRef<boolean | null>(null);
  /** The skeleton-Object set last drawn: a bone selection made against an older set may name a
   *  bone that is no longer there, so it is checked when the set changes. */
  const standaloneSignature = useRef('');

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(octahedralPositions(), 3));
    g.setIndex(octahedralIndices());
    return g;
  }, []);

  /**
   * STICK MODE (#973). Blender's stick is not a mesh: `drw_shgroup_bone_stick`
   * pushes `{head, tail}` into a buffer (`overlay_armature.cc:210-231`) and the
   * shader widens the segment in SCREEN space — `stick_size = theme.sizes.pixel
   * * 5.0`, applied along a screen-aligned perpendicular
   * (`overlay_armature_stick_vert.glsl:63-75`). Constant screen width is the
   * property that makes it declutter: a hand's fingers stay readable at any zoom
   * because the bones do not shrink into each other.
   *
   * So ours is lines, not thin geometry. WebGL ignores `linewidth`, so a segment
   * is one device pixel against Blender's five — the same behaviour, a thinner
   * stroke. Fat lines (`LineSegments2`) would match the width and cost a second
   * geometry pipeline for a diagnostic overlay; that trade is not worth taking
   * until someone asks for it.
   */
  const lineGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_BONES * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_BONES * 6), 3));
    g.setDrawRange(0, 0);
    return g;
  }, []);

  const lineMaterial = useMemo(
    () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    [],
  );

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        // WHITE, with the bone colour carried per instance — see BASE_COLOR.
        color: '#ffffff',
        // The octahedron's 8 triangles have exactly the 12 edges of
        // `OCTAHEDRAL_WIRE_LINES`, so wireframe draws Blender's bone outline
        // with no second buffer — and an unshaded solid would read as a blob.
        wireframe: true,
        transparent: true,
        opacity: 0.9,
        // DRAWN THROUGH THE SKIN, and this is not a preference. Observed on
        // mixamo-xbot: with depth testing on, the bones sit INSIDE the mesh and
        // only fragments at the shins and feet are visible — so the one thing
        // this helper exists for, judging the leg chain's roll by eye, is
        // exactly the thing you cannot do. #971 filed x-ray as a v2 nicety;
        // the picture says it is v1's exit condition. Blender has the same
        // switch ("In Front") for the same reason. A toggle belongs in v2.
        depthTest: false,
        depthWrite: false,
      }),
    [],
  );

  const sourceMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: SOURCE_BONE_COLOR,
        wireframe: true,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      }),
    [],
  );

  /**
   * Bones pick in FRONT of what they are drawn over. The helper draws with `depthTest: false`
   * because a bone inside a mesh is invisible and the helper exists to be looked at (#972). A
   * thing drawn in front that picks from behind is a pointer that disagrees with the picture, so
   * the distance is scaled down, which orders bones ahead of any mesh while keeping bones in their
   * own depth order among themselves.
   *
   * Every rig here is a skeleton Object, which picks without a selection gate (#1056): a first
   * click selects the Object, as a click on an armature does in object mode, and its bones pick
   * once it is the thing being worked on. (The clone road's live bones picked only once their
   * character was selected, so they would not take every click over a torso; that gate retired
   * with them, #1053.)
   */
  const raycastBones = useCallback(
    (raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => {
      const mesh = meshRef.current;
      if (!mesh || !mesh.visible || mesh.count === 0) return;
      const { offsets, frames } = picks.current;

      const hits: THREE.Intersection[] = [];
      THREE.InstancedMesh.prototype.raycast.call(mesh, raycaster, hits);
      if (hits.length === 0) return;

      for (const hit of hits) {
        const id = hit.instanceId;
        if (id === undefined) continue;
        const bone = pickBone(id, offsets, frames);
        if (!bone) continue;
        intersects.push({ ...hit, distance: hit.distance * PICK_DEPTH_BIAS });
      }
    },
    [],
  );

  const onBoneClick = useCallback((e: SelectClickLike & { instanceId?: number | null }) => {
    const id = e.instanceId;
    if (id === undefined || id === null) return;
    const { offsets, frames, owners } = picks.current;
    const hit = pickBone(id, offsets, frames);
    if (!hit) return;
    const nodeId = owners[hit.armature] ?? null;
    // No owning node means nothing to select. The click is deliberately NOT
    // consumed in that case — `selectNode` leaves propagation alone for a null
    // id, so an unroutable click still reaches OrbitControls, which is what
    // every other picker in the viewport does.
    if (!nodeId) return;
    // #1335 — in object mode a click on the bones selects the OBJECT, as a click on an armature
    // does in Blender's object mode; its bones pick in Edit and Pose mode. (Before the modes, the
    // second click on a selected rig picked a bone, which made every click on a selected
    // character's torso a bone pick.)
    if (armatureModeFor(nodeId) === 'object') {
      selectNode(nodeId, e);
      return;
    }
    useBoneSelectionStore.getState().selectBone(nodeId, hit.name, hit.chain);
    // The NODE selection goes through the one handler (#211): a helper earns
    // selection by calling `selectNode`, never by writing the store itself.
    selectNode(nodeId, e);
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Kept PER ARMATURE, not flattened away: a reference rig has to be sized
    // and placed against the bounds of the one character it belongs beside.
    resetDegenerateBasisCount();
    // #1056 — skeleton Objects: rigs the DAG owns, posed from their one clip at the playhead (the
    // rest pose when there is none, or several) and carried into the world by the Object.
    const standaloneInputs = skeletonObjects ?? [];
    const standaloneSig = standaloneInputs.map((o) => `${o.id}:${o.bones.length}`).join('|');
    if (standaloneSig !== standaloneSignature.current) {
      // #1339 — cleared only when the selected bone is no longer there. Edit mode changes a rig's
      // bone count on purpose (an extrude selects the bone it made), and clearing on any change
      // dropped that selection the moment it was made.
      // #1526 — and "no longer there" is asked of the live graph, not of these props: the canvas is
      // its own React root and can hold the rig one edit behind, so a second quick extrude's bone
      // was missing here and its selection was cleared the frame after it was made.
      const sel = useBoneSelectionStore.getState();
      if (standaloneSignature.current !== '' && sel.nodeId !== null) {
        const owner = collectSkeletonObjects(useDagStore.getState().state, uiEvaluatorCache).find(
          (o) => o.id === sel.nodeId,
        );
        if (!owner || !owner.bones.some((b) => b.name === sel.boneName)) sel.clear();
      }
      standaloneSignature.current = standaloneSig;
    }
    const playhead = useTimeStore.getState().seconds;
    // #1179 — posed and placed by the SAME function Frame Selected measures, so the camera
    // fits exactly the bones drawn here.
    // #1335 — the armature in Edit mode draws its REST bones: Edit mode edits the rest, and
    // Blender draws edit bones, never the pose, there.
    const standalone = standaloneInputs.map((o) =>
      skeletonObjectFrames(armatureModeFor(o.id) === 'edit' ? { ...o, pose: null } : o, playhead),
    );
    const armatures = standalone;
    const frames = armatures.flat();

    // The offsets ARE the flattening, recorded rather than re-derived: a click
    // handler that recomputed them from `armatures` would be a second copy of
    // this loop's arithmetic, free to disagree with it by a frame.
    const offsets: number[] = [];
    let running = 0;
    for (const armature of armatures) {
      offsets.push(running);
      running += armature.length;
    }
    const owners = standaloneInputs.map((o) => o.id);
    picks.current = { offsets, frames, owners };

    // Instance matrices are in the mesh's LOCAL space; the bone matrices are
    // world. Without this the whole armature rides any ancestor transform twice.
    if (mesh.parent) {
      mesh.parent.updateWorldMatrix(true, false);
      parentInverse.current.copy(mesh.parent.matrixWorld).invert();
    } else {
      parentInverse.current.identity();
    }

    const count = Math.min(frames.length, MAX_BONES);
    mesh.count = count;
    mesh.visible = count > 0;
    const local = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      local.multiplyMatrices(parentInverse.current, frames[i].matrix);
      mesh.setMatrixAt(i, local);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // #1507 — three tests a click against the mesh's bounding sphere before any bone, and computes
    // that sphere only when it is null (`InstancedMesh.raycast`). Kept, it stays where the bones
    // stood at the first click, and a bone that has moved outside it since (a chain grown in Edit
    // mode, a limb animated away) cannot be clicked. Dropped here, the next click measures it anew.
    mesh.boundingSphere = null;
    mesh.boundingBox = null;

    // ── the two display switches ────────────────────────────────────────────
    // Written every frame from the store rather than through a React effect:
    // the fill already runs here, and a material flag set in two places is a
    // material flag that will one day disagree with itself.
    // 🔴 The applied value is tracked HERE, not read back off one of the three
    // materials. Reading `material.depthTest` was tried and is a silent
    // no-op-forever: the mesh material is CONSTRUCTED with depthTest false, so
    // the condition was already satisfied on frame one and the line material —
    // constructed with three's default of TRUE — never received it. Sticks drew
    // inside the skin and read as "stick mode draws nothing", which is [[H697]]
    // wearing a different hat. One writer, one record of what it wrote.
    const wantDepth = !bonesInFront;
    if (depthApplied.current !== wantDepth) {
      depthApplied.current = wantDepth;
      for (const m of [material, sourceMaterial, lineMaterial]) {
        m.depthTest = wantDepth;
        m.depthWrite = wantDepth ? false : m.depthWrite;
        m.needsUpdate = true;
      }
    }
    const stick = boneDisplay === 'stick';
    // In stick mode the octahedra stay MOUNTED AND RAYCASTABLE and stop
    // drawing: `visible = false` would remove them from the ray, and picking a
    // bone would quietly stop working in one of two display modes. The pick
    // volume is the bone's shape either way — which is what Blender does too,
    // where selection in stick mode still hits the bone.
    if (material.colorWrite === stick) {
      material.colorWrite = !stick;
      material.needsUpdate = true;
    }

    // ── the selected bone, in a second colour ───────────────────────────────
    // Per-instance colour rather than a second mesh: one draw call is the whole
    // reason this helper is instanced, and a highlight that cost a second one
    // would trade the property the design was chosen for.
    const active = getActiveBone();
    const wantedNode = active?.nodeId ?? null;
    const wantedBone = active ? normalizeBoneName(active.boneName) : null;
    let highlighted = -1;
    if (wantedBone !== null) {
      for (let a = 0; a < armatures.length && highlighted < 0; a++) {
        // The owner is checked per armature, not per bone: two characters can
        // carry identically named bones, and a name alone would light the wrong
        // one on whichever rig the scan happened to reach first.
        if (owners[a] !== wantedNode) continue;
        const base = offsets[a];
        const end = a + 1 < offsets.length ? offsets[a + 1] : frames.length;
        for (let i = base; i < end && i < count; i++) {
          if (normalizeBoneName(frames[i].name) === wantedBone) {
            highlighted = i;
            break;
          }
        }
      }
    }
    // 🔴 The drawn COUNT is part of this condition, not the highlight alone (#1148).
    // `setColorAt` allocates the buffer as `new Float32Array(...).fill(1)` — WHITE — and
    // the material is white too, so any instance the last repaint did not reach draws
    // #ffffff rather than the bone colour. The count grows on events that leave the
    // highlight exactly where it was: a motion's rig Object unhidden in the outliner, a
    // second character imported. Those bones then drew brighter than the character beside
    // them, for no reason a director could see.
    if (
      highlighted !== lastHighlight.current ||
      count !== lastPaintedCount.current ||
      mesh.instanceColor === null
    ) {
      lastHighlight.current = highlighted;
      lastPaintedCount.current = count;
      for (let i = 0; i < count; i++) {
        mesh.setColorAt(i, i === highlighted ? SELECTED_COLOR : BASE_COLOR);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // ── the sticks ──────────────────────────────────────────────────────────
    const lines = lineRef.current;
    if (lines) {
      lines.visible = stick && count > 0;
      if (lines.visible) {
        const pos = lineGeometry.getAttribute('position') as THREE.BufferAttribute;
        const col = lineGeometry.getAttribute('color') as THREE.BufferAttribute;
        const p = new THREE.Vector3();
        for (let i = 0; i < count; i++) {
          const f = frames[i];
          const c = i === highlighted ? SELECTED_COLOR : BASE_COLOR;
          p.set(f.head[0], f.head[1], f.head[2]).applyMatrix4(parentInverse.current);
          pos.setXYZ(i * 2, p.x, p.y, p.z);
          p.set(f.tail[0], f.tail[1], f.tail[2]).applyMatrix4(parentInverse.current);
          pos.setXYZ(i * 2 + 1, p.x, p.y, p.z);
          col.setXYZ(i * 2, c.r, c.g, c.b);
          col.setXYZ(i * 2 + 1, c.r, c.g, c.b);
        }
        pos.needsUpdate = true;
        col.needsUpdate = true;
        lineGeometry.setDrawRange(0, count * 2);
      }
    }

    // ── the SOURCE rigs, beside the characters they drive (#977) ────────────
    // Deliberately NOT behind the `count === 0` early return that used to sit
    // here: the two meshes are independent, and a frame with no live armature
    // must still leave the reference mesh in a defined state rather than
    // showing whatever it held last.
    const refMesh = refMeshRef.current;
    // Kept for the DEV seam: the source rig's drawn frames, so a probe can
    // compare limb directions against the live rig without a second sampling
    // path (which would be a second answer to the pose it is measuring).
    const refNames: string[] = [];
    const refMatrices: number[][] = [];
    if (refMesh) {
      let refCount = 0;
      if (showSourceRigs && sourceRigs && sourceRigs.length > 0 && armatures.length > 0) {
        const seconds = useTimeStore.getState().seconds;
        for (const rig of sourceRigs) {
          // Which armature is this retarget's character? The skeleton Object standing the very
          // skeleton the retarget drives (#1273) — identity, not a guess. A motion's own rig Object
          // stands the SOURCE skeleton, never a target, so it is never taken for the character.
          const standing = standaloneInputs.findIndex((o) => o.skeletonId === rig.targetSkeletonId);
          if (standing < 0) continue;
          const best = standalone[standing];

          const posed = poseTransforms(rig.pose.skeleton.bones, rig.pose.sample(seconds));
          if (posed.length === 0) continue;
          const srcB = armatureBounds(posed);
          const tgtB = armatureBounds(best);
          const place = referencePlacement(srcB, tgtB);
          for (const f of posed) {
            if (refCount >= MAX_BONES) break;
            // Skip the rig's transport node for the same reason armatureBounds
            // excludes it: its octahedron runs from the world origin toward the
            // pelvis, a connector rather than anatomy, and it dominates the very
            // comparison this rig is drawn for. (Before #1206 it also stretched
            // to the walking pelvis; it now keeps its rest length.)
            if (f.parent < 0) continue;
            local.multiplyMatrices(parentInverse.current, place).multiply(f.matrix);
            refMesh.setMatrixAt(refCount++, local);
            if (import.meta.env.DEV) {
              refNames.push(f.name);
              refMatrices.push([...local.elements]);
            }
          }
        }
      }
      refMesh.count = refCount;
      refMesh.visible = refCount > 0;
      refMesh.instanceMatrix.needsUpdate = true;
    }

    // DEV observation seam, the LightHelpers pattern: what the helper actually
    // drew this frame, so an e2e can assert on the rig rather than on pixels.
    // #1450 — written at ZERO bones too. A `count === 0` return left over from
    // when it guarded the drawing kept the last non-empty frame here, so a rig
    // that stopped drawing still read as drawn.
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __basher_armature?: {
          armatures: number;
          bones: number;
          names: string[];
          matrices: number[][];
          // #977 — the REFERENCE rigs get their own counters. Without them the
          // seam reports the live mesh only, and "the source rig did not draw"
          // is indistinguishable from "it drew outside the camera frustum".
          sourceRigsOffered: number;
          sourceBones: number;
          sourceNames: string[];
          sourceMatrices: number[][];
          degenerateBases: number;
          degenerateNames: string[];
          highlightedBone: string | null;
          // #1056 — the skeleton Objects among `armatures`, each with the reason it is or is
          // not posed: without `clipCount`, a rig resting because two clips are wired reads
          // the same as a rig whose clip failed to sample.
          skeletonObjects: { id: string; bones: number; clipCount: number; posed: boolean }[];
          // #1087 — the colours actually drawn, read off the two meshes: every distinct colour
          // among the drawn bones, and the source rig's. The source rig and a rig Object can
          // both show one motion, and the colour is what tells them apart on screen.
          boneColors: string[];
          sourceColor: string | null;
        };
      };
      w.__basher_armature = {
        armatures: armatures.length,
        skeletonObjects: standaloneInputs.map((o, i) => ({
          id: o.id,
          bones: standalone[i].length,
          clipCount: o.clipCount,
          posed: o.pose !== null,
        })),
        bones: count,
        names: frames.slice(0, count).map((f) => f.name),
        matrices: frames.slice(0, count).map((f) => [...f.matrix.elements]),
        boneColors: (() => {
          const seen = new Set<string>();
          const c = new THREE.Color();
          for (let i = 0; i < count; i++) {
            mesh.getColorAt(i, c);
            seen.add(`#${c.getHexString()}`);
          }
          return [...seen].sort();
        })(),
        sourceColor:
          refMesh && refMesh.count > 0
            ? `#${(refMesh.material as THREE.MeshBasicMaterial).color.getHexString()}`
            : null,
        sourceRigsOffered: showSourceRigs ? (sourceRigs?.length ?? 0) : 0,
        sourceBones: refMeshRef.current?.count ?? 0,
        sourceNames: refNames,
        sourceMatrices: refMatrices,
        degenerateBases: degenerateBasisCount,
        degenerateNames: [...degenerateBasisNames],
        // WHICH bone is painted as selected, by name rather than by index —
        // an index means nothing to a reader and would have to be resolved
        // against this same array to say anything, which is a second chance to
        // resolve it differently. null when nothing is highlighted (#973).
        highlightedBone: highlighted >= 0 ? (frames[highlighted]?.name ?? null) : null,
      };
    }
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[geometry, material, MAX_BONES]}
        frustumCulled={false}
        renderOrder={999}
        visible={false}
        onClick={onBoneClick}
        raycast={raycastBones}
        // Never part of a production render — Blender does not render armatures
        // either. V37's hide-pass keys on exactly this flag.
        userData={{ editorChrome: true }}
      />
      {/* The sticks. Deliberately NOT applied to the reference rig below: that
          rig exists to judge ROLL against the live one, and a stick is a head
          and a tail with no third axis — comparing roll with sticks is
          comparing something neither shape carries. */}
      <lineSegments
        ref={lineRef}
        args={[lineGeometry, lineMaterial]}
        frustumCulled={false}
        renderOrder={999}
        visible={false}
        userData={{ editorChrome: true }}
      />
      <instancedMesh
        ref={refMeshRef}
        args={[geometry, sourceMaterial, MAX_BONES]}
        frustumCulled={false}
        renderOrder={999}
        visible={false}
        userData={{ editorChrome: true }}
      />
    </>
  );
}
