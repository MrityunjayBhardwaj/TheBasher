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

export function CameraLookAtTarget({ nodeId }: { nodeId: string }) {
  const nodes = useDagStore((s) => s.state.nodes);
  const dispatch = useDagStore((s) => s.dispatch);
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  const frame = useTimeStore((s) => s.frame);
  const seconds = useTimeStore((s) => s.seconds);
  const normalized = useTimeStore((s) => s.normalized);

  // Targetable = any OTHER scene object that has a world position (mesh, group,
  // light, camera). Excludes self and the edge-less constraint nodes.
  const options = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    for (const [id, n] of Object.entries(nodes)) {
      // #317 — the SPECIES predicate, not a hardcoded type: Follow-Path / Copy-Location
      // are relational pose nodes too and must never appear as aim TARGETS.
      if (id === nodeId || isRelationalPoseNode(n)) continue;
      const p = (n.params ?? {}) as Record<string, unknown>;
      if (!isVec3(p.position)) continue;
      out.push({ id, name: typeof p.name === 'string' && p.name ? p.name : id });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [nodes, nodeId]);

  // #317 — the dropdown must show and edit the constraint the camera ACTUALLY OBEYS.
  // The aim band is last-writer-wins, so that is the TOP of the stack — which is what
  // `resolveTrackToTarget` resolves and what the viewport renders. This used to read
  // `trackToForTarget` (the BOTTOM member) and scan for its own first `type === 'TrackTo'`
  // match: identical for a single constraint, but the moment the Constraints panel adds a
  // second one, the dropdown displayed and re-targeted the LOSER while the camera aimed
  // somewhere else. Both now come from the ONE shared stack enumeration.
  const boundTargetId = useMemo(
    () => activeConstraintForTarget(nodes, nodeId)?.aimNode ?? '',
    [nodes, nodeId],
  );
  // The constraint this dropdown edits/removes — THE SAME member it displays. Anything
  // else is incoherent: reading the winner while writing a different node means "clear"
  // could delete a bypassed constraint and leave the camera still aimed by an active one
  // below it. So: operate on the winner, or (when nothing is aiming) create a new one on
  // top. A MUTED constraint is deliberately left alone — the user bypassed it in the
  // Constraints panel, and this dropdown must not silently resurrect it.
  const existingTTId = useMemo(
    () => activeConstraintForTarget(nodes, nodeId)?.nodeId,
    [nodes, nodeId],
  );

  const onChange = (value: string) => {
    const state = useDagStore.getState().state;
    if (!value) {
      // Clear — freeze the current aim into the authored lookAt (no jump), remove.
      if (!existingTTId) return;
      const ctx = { time: { frame, seconds, normalized } };
      const aim = resolveTrackToTarget(state, nodeId, ctx);
      const ops: Op[] = [];
      if (aim) ops.push({ type: 'setParam', nodeId, paramPath: 'lookAt', value: aim });
      ops.push({ type: 'removeNode', nodeId: existingTTId });
      dispatchAtomic(ops, 'user', 'clear look-at target');
      return;
    }
    if (existingTTId) {
      dispatchAtomic(
        [{ type: 'setParam', nodeId: existingTTId, paramPath: 'aimNode', value }],
        'user',
        'set look-at target',
      );
      return;
    }
    const cam = state.nodes[nodeId]?.params as { lookAt?: unknown } | undefined;
    const aimPoint = isVec3(cam?.lookAt) ? cam.lookAt : [0, 0, 0];
    dispatch(
      {
        type: 'addNode',
        nodeId: newId('tt'),
        nodeType: 'TrackTo',
        params: {
          name: 'lookAt',
          target: nodeId,
          aimNode: value,
          aimPoint,
          up: [0, 1, 0],
          mute: false,
          // #317 — land it on TOP of whatever the camera already carries. The hardcoded
          // 0 this replaces TIED with an existing constraint, and the stable sort then
          // fell back to node-table order — so which one aimed the camera was arbitrary.
          // An unconstrained camera (the common case) still gets 0: byte-identical.
          order: nextConstraintOrder(nodes, nodeId),
        },
      },
      'user',
      'set look-at target',
    );
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
