// cameraTrajectory Mutator — a named shot becomes a wired, aimed camera path (#774).
//
//   CurveData ──data──▶ Object ──▶ scene.children
//                          ▲
//                          └── FollowPath { target: camera }   writes the POSITION band
//                              TrackTo    { target: camera }   writes the ROTATION band
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS A MUTATOR AND NOT A GENERATION CAPABILITY
// ─────────────────────────────────────────────────────────────────────────
// A1 and A4 each needed an HTTP service because their artefact is high-dimensional
// — a clip is thousands of numbers, a mesh is more — and that boundary is what
// dragged in a licence gate, an offline stub and a transport. A camera trajectory
// is about five `Vec3`s, which is squarely what a language model emits well. The
// A3 trial built every path in it with `addNode` + `setParam` through `dag.exec`
// and scored 13/13 on pre-registered criteria: no service, no stub, no transport,
// no licence verdict. So the model emits the points and this wires them.
//
// ─────────────────────────────────────────────────────────────────────────
// 🔴 THE POINTS ARE WORLD COORDINATES, AND THE OBJECT IS MINTED AT THE ORIGIN
// ─────────────────────────────────────────────────────────────────────────
// `CurveData.points` are LOCAL to the owning Object's TRS — its own docstring says
// so. A model told "the subject is at [3, 0, -4]" emits points around [3, 0, -4],
// in the world. If this minted the Object anywhere but the origin those two
// readings would compose and the path would land at the sum of them, which is a
// silent doubling that looks like a model that cannot count. So the Object is
// minted at the origin with an identity pose, the spec's points go in verbatim,
// and the two spellings of "where" cannot disagree because only one is used.
//
// ─────────────────────────────────────────────────────────────────────────
// A SECOND REQUEST RE-POINTS THE EXISTING CONSTRAINTS; IT DOES NOT STACK
// ─────────────────────────────────────────────────────────────────────────
// "Now make it a dolly instead" is the ordinary second thing a director says. Two
// Follow-Paths on one camera is not two paths — both write the POSITION band, the
// fold is last-writer-wins by `order`, and the loser is still drawn in the
// constraint panel: a displayed-≠-rendered split ([[V446]]/H40), authored by a
// road that looked like it worked. So an existing Follow-Path on this camera has
// its `curve` re-pointed at the new Object, and an existing Track-To its
// `aimNode`. The superseded curve stays in the scene — visible, selectable and
// deletable — rather than being removed underneath a director who may want it
// back. Same idempotence `poseBone` gives an override and `ensureChannelForBone`
// a channel, and for the same reason: every repeat must land on the thing already
// driving the subject.
//
// ─────────────────────────────────────────────────────────────────────────
// 🔑 THE DECISION #774 ASKED FOR: THE VOCABULARY RESOLVES AGAINST THE SUBJECT'S
//     BOUNDS, NEVER AGAINST HUMAN SCALE
// ─────────────────────────────────────────────────────────────────────────
// The trial's vocabulary presumes a person — "eye level", "over the shoulder",
// "hero" — and a scene may hold a cube. Told the bounds, the trial framed 0.7 m
// above a 1 m cube; told nothing, it used human anthropometry at 1.6 m. They
// differ by a metre and neither is wrong until somebody decides.
//
// It resolves against the BOUNDS, for a reason that is about what is knowable
// rather than about taste: the graph can measure a subject's extent and cannot
// know whether it is a person. Human scale is right for exactly one kind of
// subject and silently wrong for every other, and its wrongness grows with how
// far the subject departs from 1.6 m — a hand prop and a building both get a
// camera at chest height on a human who is not there. Bounds-relative is correct
// for a person too, because a person's bounds ARE their height.
//
// So "eye level" means a height near the top of the subject's extent, "over the
// shoulder" a standoff proportional to its width, and the caller resolving those
// words is given the bounds to resolve them with. The words are the director's;
// the numbers are the scene's.
//
// ⚠️ This mutator does not itself interpret a word — it receives points already
// resolved. The decision is recorded HERE because this is where the shot is
// assembled and the next person to add a vocabulary will read this file.
//
// REF: ref/architecture/A3-CAMERA-TRAJECTORY-AUDIT.md (why a mutator);
//      ref/architecture/A3-PROMPT-TRIAL.md (the prompt contract, and the frames
//      that showed the numbers misleading); src/nodes/FollowPath.ts (the position
//      band, and why `evalTime` is the speed profile); src/nodes/TrackTo.ts (the
//      rotation band); src/app/addPrimitives.ts (the Curve mint this mirrors);
//      issues #774, #772, #731.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import { isCameraNode } from '../../../app/cameraNode';
import { nextConstraintOrder } from '../../../app/nodeConstraints';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const CameraTrajectorySpec = z.object({
  /** The camera to constrain — the Object half of the split (the node a director selects). */
  cameraId: z.string().min(1),
  /**
   * The path, in WORLD coordinates, in travel order. Two points is a straight
   * dolly; four or five describe an arc or a crane without over-fitting.
   */
  points: z.array(Vec3Schema).min(2),
  /** The node the camera aims at for the whole move. One of this or `aimPoint`. */
  subjectId: z.string().optional(),
  /** A fixed world point to aim at, when the shot has no node to name. */
  aimPoint: Vec3Schema.optional(),
  /** A closed path loops; the camera wraps past the end instead of clamping. */
  closed: z.boolean().default(false),
  /** Samples per span — bounds the arc-length table's accuracy. */
  resolution: z.number().int().min(1).max(128).default(16),
  /** Shown on the curve and the constraints, so a stack of shots is readable. */
  name: z.string().default('shot'),
  /** Where along the path the camera sits now. KEYFRAME THIS: because the seam is
   *  arc-length parameterised, an F-curve here is the shot's speed profile and a
   *  linear ramp is genuinely constant speed. */
  evalTime: z.number().default(0),
  curveDataId: z.string().optional(),
  curveObjectId: z.string().optional(),
});
export type CameraTrajectorySpec = z.infer<typeof CameraTrajectorySpec>;

interface GraphNode {
  readonly type: string;
  readonly params?: Record<string, unknown>;
}

/** A stable slug for the deterministic ids, as `addChannel`/`poseBone` build theirs. */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function curveDataIdFor(spec: CameraTrajectorySpec): NodeId {
  return spec.curveDataId ?? `${spec.cameraId}_${safeName(spec.name)}_path_data`;
}
function curveObjectIdFor(spec: CameraTrajectorySpec): NodeId {
  return spec.curveObjectId ?? `${spec.cameraId}_${safeName(spec.name)}_path`;
}

/** The first constraint of `type` already aimed at `cameraId`, or null. */
function existingConstraint(state: DagState, type: string, cameraId: string): NodeId | null {
  const ids = Object.keys(state.nodes).sort();
  for (const id of ids) {
    const node = state.nodes[id] as unknown as GraphNode;
    if (node.type !== type) continue;
    if ((node.params as { target?: unknown } | undefined)?.target === cameraId) return id;
  }
  return null;
}

export const cameraTrajectoryMutator: MutatorDefinition<CameraTrajectorySpec> = {
  name: 'mutator.camera.trajectory',
  // 🔴 THE FIRST SENTENCE IS THE PICKER PAYLOAD, so it ends before a CAPITAL.
  description:
    'Give a camera a path to travel and something to aim at, as one shot: mints a ' +
    'Curve from world-space control points, wires it into the scene, and puts a ' +
    'Follow-Path and a Track-To on the camera. Points are WORLD coordinates in ' +
    'travel order, two or more. Aim at a node with subjectId or a fixed place with ' +
    'aimPoint; one of the two is required, because an unaimed camera on a path is a ' +
    'spline and not a shot. Calling it again for the same camera re-points the ' +
    'constraints it already has rather than stacking a second path. Keyframe the ' +
    "Follow-Path's evalTime to author the shot's speed.",
  spec: CameraTrajectorySpec,
  // Every field, including the ones with defaults: the picker payload is what the
  // model copies, and a field it never sees is a field it never sets.
  specExample: {
    cameraId: 'n_camera',
    subjectId: 'n_box',
    name: 'slow arc',
    points: [
      [4, 1.6, 3],
      [1, 1.6, 5],
      [-3, 1.6, 3],
    ],
    closed: false,
    resolution: 16,
    evalTime: 0,
  },
  contract: {
    requiredEdges: [],
    // The camera is NOT declared here, for the reason `shotCreate` records: a split
    // camera is an Object posing a CameraData, and `requiredNodeTypes` compares
    // `node.type` against a token, so a type check rejects every camera in the
    // product. The possession test in `preconditions` owns it and is stronger — it
    // validates THIS `cameraId` rather than "some camera exists somewhere".
    requiredNodeTypes: ['Scene'],
    // 🔴 POSITION AND ROTATION ARE NOT PRESERVED, and that is the honest reading
    // even though this mutator writes neither of the camera's params. `preserves`
    // is a plan-level PREVIEW — the sentence a director is shown before applying —
    // and a Follow-Path plus a Track-To put the camera somewhere else and point it
    // somewhere else. Claiming otherwise on the strength of "the params are
    // untouched" would be true about the bag and false about the shot, which is the
    // lying-label shape this repo keeps filing. Everything the constraints do not
    // derive IS preserved, and that is what is listed.
    //
    // It is also what separates this from `mutator.shot.create` under V14: the two
    // had byte-identical contract signatures until this line told the truth.
    preserves: ['scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [
        spec.cameraId,
        ...(spec.subjectId ? [spec.subjectId] : []),
        curveDataIdFor(spec),
        curveObjectIdFor(spec),
      ],
      followedEdges: ['parent'],
    };
  },
  preconditions(spec, _closure, state) {
    const camera = state.nodes[spec.cameraId];
    if (!camera) return { ok: false, reason: `camera "${spec.cameraId}" not in DAG.` };
    if (!isCameraNode(state, spec.cameraId)) {
      return {
        ok: false,
        reason: `cameraId "${spec.cameraId}" is a ${camera.type} that poses no CameraData; expected a camera.`,
      };
    }
    if (spec.subjectId !== undefined && spec.aimPoint !== undefined) {
      return {
        ok: false,
        reason:
          'give subjectId or aimPoint, not both — Track-To reads aimNode when it is set and ' +
          'ignores aimPoint, so supplying both would silently discard one of them.',
      };
    }
    if (spec.subjectId === undefined && spec.aimPoint === undefined) {
      return {
        ok: false,
        reason:
          'a shot needs something to aim at: pass subjectId (a node) or aimPoint (a world ' +
          'position). A camera on a path aiming nowhere keeps whatever rotation it had, which ' +
          'is a spline rather than a shot.',
      };
    }
    if (spec.subjectId !== undefined && !state.nodes[spec.subjectId]) {
      return { ok: false, reason: `subjectId "${spec.subjectId}" not in DAG.` };
    }
    if (spec.subjectId === spec.cameraId) {
      return {
        ok: false,
        reason:
          'a camera cannot aim at itself — Track-To would derive its rotation from its own world.',
      };
    }
    if (!state.outputs.scene) {
      return { ok: false, reason: 'no Scene output in the DAG to wire the path into.' };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const sceneRef = state.outputs.scene!;
    const dataId = curveDataIdFor(spec);
    const objectId = curveObjectIdFor(spec);
    const ops: Op[] = [];

    // The control points, with the stable per-point ids the curve's own schema
    // requires — a selection or a keyframe reference survives an insert, a delete
    // and an undo because of them (epic #453). Minted in order rather than through
    // `mintId`, because a fresh curve's ids start from a clean slate.
    const points = spec.points.map((co, i) => ({ id: `cp${i}`, co }));

    ops.push({
      type: 'addNode',
      nodeId: dataId,
      nodeType: 'CurveData',
      params: { points, closed: spec.closed, resolution: spec.resolution },
    });
    ops.push({
      type: 'addNode',
      nodeId: objectId,
      nodeType: 'Object',
      // AT THE ORIGIN, deliberately — see the header. The points are world.
      params: {
        name: `${spec.name} path`,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    });
    ops.push({
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    });
    // Into the scene, so the path is DRAWN and its points are draggable. That is
    // not decoration: "grab a control point and the shot updates" is the whole
    // difference between a trajectory and a rendered camera move, and a curve
    // nobody can see cannot be grabbed.
    ops.push({
      type: 'connect',
      from: { node: objectId, socket: 'out' },
      to: { node: sceneRef.node, socket: 'children' },
    });

    const follow = existingConstraint(state, 'FollowPath', spec.cameraId);
    if (follow) {
      ops.push({ type: 'setParam', nodeId: follow, paramPath: 'curve', value: objectId });
      ops.push({ type: 'setParam', nodeId: follow, paramPath: 'evalTime', value: spec.evalTime });
    } else {
      ops.push({
        type: 'addNode',
        nodeId: `${objectId}_follow`,
        nodeType: 'FollowPath',
        params: {
          name: `${spec.name} follow`,
          target: spec.cameraId,
          curve: objectId,
          evalTime: spec.evalTime,
          // On top of whatever stack the camera already carries, the way every other
          // road that adds a constraint lands one (#317).
          order: nextConstraintOrder(
            state.nodes as unknown as Readonly<Record<string, { type: string }>>,
            spec.cameraId,
          ),
        },
      });
    }

    const track = existingConstraint(state, 'TrackTo', spec.cameraId);
    const aimParams =
      spec.subjectId !== undefined
        ? { aimNode: spec.subjectId }
        : { aimNode: '', aimPoint: spec.aimPoint! };
    if (track) {
      for (const [path, value] of Object.entries(aimParams)) {
        ops.push({ type: 'setParam', nodeId: track, paramPath: path, value });
      }
    } else {
      ops.push({
        type: 'addNode',
        nodeId: `${objectId}_aim`,
        nodeType: 'TrackTo',
        params: {
          name: `${spec.name} aim`,
          target: spec.cameraId,
          ...aimParams,
          // Reads the count AFTER the Follow-Path above would have taken its slot,
          // so the two land on adjacent rungs rather than both on the same one.
          // They write different bands and never contend, but a stack that reads
          // 0, 0 in the panel invites a director to reorder something that has no
          // order.
          order:
            nextConstraintOrder(
              state.nodes as unknown as Readonly<Record<string, { type: string }>>,
              spec.cameraId,
            ) + (follow ? 0 : 1),
        },
      });
    }

    return ops;
  },
};
