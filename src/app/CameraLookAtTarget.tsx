// #247 increment 2 — the camera's "look at target" object-picker.
//
// Binds a camera's lookAt to any scene object via a Track-To constraint (#204 /
// V60): the SAME machinery lights use. When a target is set, resolveCameraPoseAt
// DERIVES the lookAt from the target's world position, so the look-through camera
// AND the editor reticle both follow the object (the reticle re-seeds from the
// resolved pose on selection / scrub / playback). Picking "— free —" removes the
// constraint, first freezing the current aim into the authored lookAt so the
// camera does not jump.
//
// This is a CONVENIENCE surface over the constraint stack, not a second constraint system
// (#317). It reads, edits, and clears exactly ONE member: the WINNER — the top of the
// stack, which is the member the aim band's last-writer-wins fold actually obeys and the
// viewport renders (`activeConstraintForTarget`, the same enumeration the resolvers and
// the Constraints panel use). New aims land on top via the shared `nextConstraintOrder`.
// A camera may legitimately carry several constraints now that the Constraints panel
// (#312) exists; managing the rest of the stack is that panel's job, not this dropdown's —
// which is also why a MUTED member is left strictly alone here.
//
// REF: src/app/nodeConstraints.ts (activeConstraintForTarget / nextConstraintOrder /
//      resolveTrackToTarget),
//      src/app/activeCamera.ts (lookAt derivation), issue #204 / vyapti V60.

import { useMemo } from 'react';
import { useDagStore } from '../core/dag/store';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import {
  activeConstraintForTarget,
  isRelationalPoseNode,
  nextConstraintOrder,
} from './nodeConstraints';
import { resolveCameraPoseAt } from './activeCamera';
import { filmSecondsOf } from './subjectClock';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { rotationWriteOf } from './resolvedRotation';
import type { RotationModeFields } from '../nodes/types';
import { useTimeStore } from './stores/timeStore';
import { paramAnimationState } from './animate/paramAnimationState';
import { routeAnimatedGrab } from './animate/autoKeyCommit';
import { clockFor } from './subjectClock';

const ROW = 'flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80';
const LABEL = 'font-mono text-fg/60';
const SELECT =
  'max-w-[9rem] truncate rounded border border-border bg-muted px-1 py-0.5 text-[10px] text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

type Vec3 = [number, number, number];
function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** The two node ids a camera's aim binding spans. See {@link CameraLookAtTarget}. */
export interface LookAtIds {
  /** The lens half — the node the inspector control is mounted for. */
  readonly nodeId: string;
  /** The pose half (the Object) — owns the constraint stack. */
  readonly poseNodeId: string;
}

/**
 * The targetable objects for a camera's aim dropdown: any OTHER node with a world
 * position (mesh, group, light, camera), excluding the camera itself and the
 * edge-less relational pose nodes.
 *
 * Extracted from the component so the id question is ASSERTABLE. This project has no
 * React Testing Library (new deps are forbidden), so a decision left inline in a
 * component is reachable only from e2e — and the failure this guards is that the
 * camera's OWN Object appears in its own aim list, which is a plain list-membership
 * fact that should not need a browser to catch.
 */
export function lookAtTargetOptions(
  nodes: DagState['nodes'],
  poseNodeId: string,
): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const [id, n] of Object.entries(nodes)) {
    // #317 — the SPECIES predicate, not a hardcoded type: Follow-Path / Copy-Location
    // are relational pose nodes too and must never appear as aim TARGETS.
    // #387 — exclude the POSE half: that is the node carrying `position`, so that is
    // the node that would otherwise show up as a targetable object. The lens half has
    // no `position` and is filtered by the check below regardless of which id we hold.
    if (id === poseNodeId || isRelationalPoseNode(n)) continue;
    const p = (n.params ?? {}) as Record<string, unknown>;
    if (!isVec3(p.position)) continue;
    out.push({ id, name: typeof p.name === 'string' && p.name ? p.name : id });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** What the dropdown dispatches for a pick — ops, undo label, and whether today's
 *  code path used `dispatchAtomic`. `ops: []` means "nothing to do". */
export interface LookAtBinding {
  readonly ops: Op[];
  readonly label: string;
  readonly atomic: boolean;
  /** #1772 — a write to an ANIMATED param, kept out of `ops`: a plain `setParam` on it is
   *  overridden by its keys at once. The shell writes it as every edit to an animated param is
   *  written (`routeAnimatedGrab`): a key with Auto-Key on, a held edit with it off. */
  readonly animatedWrite?: {
    readonly nodeId: string;
    readonly paramPath: string;
    readonly value: unknown;
  };
}

/**
 * The ops a pick in the aim dropdown produces: clear (`value === ''`), re-target an
 * existing winner, or create a new Track-To on top.
 *
 * Extracted for the same reason as {@link lookAtTargetOptions}, and it is the more
 * important of the two: the emitted constraint's `target` decides whether the camera
 * actually aims, and getting it wrong produces a constraint that is valid, saved,
 * displayed by this very dropdown, and read by NOTHING. There is no error and no
 * visual difference until you look at the viewport.
 */
export function bindLookAtTargetOps(
  state: DagState,
  ids: LookAtIds,
  value: string,
  ctx: { time: { frame: number; seconds: number; normalized: number } },
): LookAtBinding {
  const { poseNodeId } = ids;
  const nodes = state.nodes;
  // The constraint this dropdown edits/removes — THE SAME member it displays. Anything
  // else is incoherent: reading the winner while writing a different node means "clear"
  // could delete a bypassed constraint and leave the camera still aimed by an active one
  // below it. So: operate on the winner, or (when nothing is aiming) create a new one on
  // top. A MUTED constraint is deliberately left alone — the user bypassed it in the
  // Constraints panel, and this dropdown must not silently resurrect it.
  const existingTTId = activeConstraintForTarget(nodes, poseNodeId)?.nodeId;

  if (!value) {
    // Clear — freeze the current aim into the camera's own rotation (no jump), remove.
    if (!existingTTId) return { ops: [], label: 'clear look-at target', atomic: true };
    // #1760 — the camera keeps looking where it looked: the orientation it is drawn with (aim
    // and roll, in its parent's space) becomes its own rotation, in its rotation mode — what
    // Blender's Apply Visual Transform does before a constraint is removed (V665). Resolved for
    // the OBJECT, the subject the constraint targets (off the lens half it resolves nothing).
    const drawn = resolveEvaluatedTransform(state, poseNodeId, ctx);
    const ops: Op[] = [];
    let animatedWrite: LookAtBinding['animatedWrite'];
    if (drawn?.rotation) {
      const objParams = (nodes[poseNodeId]?.params ?? {}) as RotationModeFields;
      const write = rotationWriteOf(objParams, drawn.rotation);
      // #1772 — a keyed rotation, hidden while the Track-To aimed the camera, would take over the
      // moment it is gone: the frozen rotation goes through the animated-edit road instead, as the
      // same check `routeAnimatedGrab` makes decides.
      const frame = clockFor(state, poseNodeId, write.paramPath).frame;
      if (paramAnimationState(state, poseNodeId, write.paramPath, frame) !== 'none') {
        animatedWrite = { nodeId: poseNodeId, ...write };
      } else {
        ops.push({ type: 'setParam', nodeId: poseNodeId, ...write });
      }
    }
    ops.push({ type: 'removeNode', nodeId: existingTTId });
    return { ops, label: 'clear look-at target', atomic: true, animatedWrite };
  }

  if (existingTTId) {
    return {
      ops: [{ type: 'setParam', nodeId: existingTTId, paramPath: 'aimNode', value }],
      label: 'set look-at target',
      atomic: true,
    };
  }

  // #1775 — the fallback aim point (what the camera aims at if the target node is later removed)
  // is the WORLD point it is drawn looking at now, in a world-space Track-To: a nested camera falls
  // back to where it looked. World, not parent, space on purpose: a Track-To's space also picks
  // which way is up (#1770), and a new binding keeps world up, level under a tilted rig, as it
  // always has. Read on the playhead, the clock a camera is posed on (#1594), for the Object, the
  // half the pose road poses.
  const aimPoint: Vec3 = [
    ...resolveCameraPoseAt(state, poseNodeId, filmSecondsOf(state, ctx)).lookAt,
  ];
  return {
    ops: [
      {
        type: 'addNode',
        nodeId: newId('tt'),
        nodeType: 'TrackTo',
        params: {
          name: 'lookAt',
          // The constraint's SUBJECT is the Object — that is what the pose resolver
          // enumerates constraints for. Targeting the lens half writes a constraint no
          // road reads: the dropdown updates, the camera does not move, nothing errors.
          target: poseNodeId,
          aimNode: value,
          aimPoint,
          aimSpace: 'world',
          up: [0, 1, 0],
          mute: false,
          // #317 — land it on TOP of whatever the camera already carries. The hardcoded
          // 0 this replaces TIED with an existing constraint, and the stable sort then
          // fell back to node-table order — so which one aimed the camera was arbitrary.
          // An unconstrained camera (the common case) still gets 0: byte-identical.
          // Same subject as `target` above — the order is relative to the constraints
          // ALREADY on this camera, and those are enumerated against the Object. Asked
          // about the lens half it always answers 0, which re-introduces the exact TIE
          // #317 removed the moment a split camera carries a second constraint.
          order: nextConstraintOrder(nodes, poseNodeId),
        },
      },
    ],
    label: 'set look-at target',
    atomic: false,
  };
}

/**
 * #387 — this control spans BOTH halves of a split camera, and the two jobs land on
 * DIFFERENT nodes:
 *
 * @param nodeId      the node owning the LENS params. `lookAt` is a CameraData param
 *   (parity-first, D1), so the freeze-on-clear write and the seed read for a new
 *   constraint's `aimPoint` belong HERE.
 * @param poseNodeId  the node owning the POSE — the `Object`. Constraints are owned by
 *   the Object: `resolveTrackToTarget` enumerates constraints whose `target` is the node
 *   the pose road addresses, which is the Object. Authoring a Track-To against the lens
 *   half writes a constraint NOTHING READS — the dropdown shows the new target, the
 *   camera does not move, and no error is raised anywhere. The self-exclusion below is
 *   against this id too, or the camera's own Object appears in its own aim list.
 *   Defaults to `nodeId` so an un-split camera behaves exactly as before.
 */
export function CameraLookAtTarget({
  nodeId,
  poseNodeId = nodeId,
}: {
  nodeId: string;
  poseNodeId?: string;
}) {
  const nodes = useDagStore((s) => s.state.nodes);
  const dispatch = useDagStore((s) => s.dispatch);
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  const frame = useTimeStore((s) => s.frame);
  const seconds = useTimeStore((s) => s.seconds);
  const normalized = useTimeStore((s) => s.normalized);

  // Targetable = any OTHER scene object that has a world position (mesh, group,
  // light, camera). Excludes self and the edge-less constraint nodes.
  const options = useMemo(() => lookAtTargetOptions(nodes, poseNodeId), [nodes, poseNodeId]);

  // #317 — the dropdown must show and edit the constraint the camera ACTUALLY OBEYS.
  // The aim band is last-writer-wins, so that is the TOP of the stack — which is what
  // `resolveTrackToTarget` resolves and what the viewport renders. This used to read
  // `trackToForTarget` (the BOTTOM member) and scan for its own first `type === 'TrackTo'`
  // match: identical for a single constraint, but the moment the Constraints panel adds a
  // second one, the dropdown displayed and re-targeted the LOSER while the camera aimed
  // somewhere else. Both now come from the ONE shared stack enumeration.
  const boundTargetId = useMemo(
    () => activeConstraintForTarget(nodes, poseNodeId)?.aimNode ?? '',
    [nodes, poseNodeId],
  );
  const onChange = (value: string) => {
    // The whole decision — which ops, which label, which id each op lands on — lives in
    // `bindLookAtTargetOps` so it can be asserted without a DOM. This shell only chooses
    // the dispatch shape, preserving today's exactly (create = one `dispatch`, clear and
    // re-target = `dispatchAtomic`).
    const { ops, label, atomic, animatedWrite } = bindLookAtTargetOps(
      useDagStore.getState().state,
      { nodeId, poseNodeId },
      value,
      { time: { frame, seconds, normalized } },
    );
    if (ops.length === 0) return;
    if (atomic) dispatchAtomic(ops, 'user', label);
    else dispatch(ops[0], 'user', label);
    // #1772 — after the clear, so the camera's own rotation is what the edit lands on. An
    // un-routed answer (no longer animated) falls back to the plain write.
    if (animatedWrite) {
      const { nodeId: id, paramPath, value: v } = animatedWrite;
      if (!routeAnimatedGrab(id, paramPath, v)) {
        dispatch({ type: 'setParam', nodeId: id, paramPath, value: v }, 'user', label);
      }
    }
  };

  return (
    <label className={ROW}>
      <span className={LABEL}>look at target</span>
      <select
        value={boundTargetId}
        data-testid={`inspector-camera-lookat-${nodeId}`}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT}
      >
        <option value="">— free —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
