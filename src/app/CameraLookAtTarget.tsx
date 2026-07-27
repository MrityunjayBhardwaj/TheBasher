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
  resolveTrackToTarget,
} from './nodeConstraints';
import { useTimeStore } from './stores/timeStore';

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
  /** The lens half — owns `lookAt`. */
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
  const { nodeId, poseNodeId } = ids;
  const nodes = state.nodes;
  // The constraint this dropdown edits/removes — THE SAME member it displays. Anything
  // else is incoherent: reading the winner while writing a different node means "clear"
  // could delete a bypassed constraint and leave the camera still aimed by an active one
  // below it. So: operate on the winner, or (when nothing is aiming) create a new one on
  // top. A MUTED constraint is deliberately left alone — the user bypassed it in the
  // Constraints panel, and this dropdown must not silently resurrect it.
  const existingTTId = activeConstraintForTarget(nodes, poseNodeId)?.nodeId;

  if (!value) {
    // Clear — freeze the current aim into the authored lookAt (no jump), remove.
    // #387 — BOTH ids are load-bearing in these three lines: the aim is RESOLVED for
    // the Object (that is the subject the constraint targets) and WRITTEN to the lens
    // half (that is where `lookAt` lives). Using one id for both silently breaks one
    // end or the other: resolved off the lens half it is always null → no freeze →
    // the camera jumps back to its stale authored aim on clear; written to the Object
    // it lands on a param nothing reads → same jump, and a stray `lookAt` on an Object.
    if (!existingTTId) return { ops: [], label: 'clear look-at target', atomic: true };
    const aim = resolveTrackToTarget(state, poseNodeId, ctx);
    const ops: Op[] = [];
    if (aim) ops.push({ type: 'setParam', nodeId, paramPath: 'lookAt', value: aim });
    ops.push({ type: 'removeNode', nodeId: existingTTId });
    return { ops, label: 'clear look-at target', atomic: true };
  }

  if (existingTTId) {
    return {
      ops: [{ type: 'setParam', nodeId: existingTTId, paramPath: 'aimNode', value }],
      label: 'set look-at target',
      atomic: true,
    };
  }

  // The seed aim point is the AUTHORED `lookAt` — a lens-half param, so read off
  // `nodeId`. Read off the Object it is always absent → every new binding would seed
  // [0,0,0] and the camera would swing through the world origin on the first bind.
  const cam = nodes[nodeId]?.params as { lookAt?: unknown } | undefined;
  const aimPoint = isVec3(cam?.lookAt) ? cam.lookAt : [0, 0, 0];
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
    const { ops, label, atomic } = bindLookAtTargetOps(
      useDagStore.getState().state,
      { nodeId, poseNodeId },
      value,
      { time: { frame, seconds, normalized } },
    );
    if (ops.length === 0) return;
    if (atomic) dispatchAtomic(ops, 'user', label);
    else dispatch(ops[0], 'user', label);
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
