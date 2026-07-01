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
// One Track-To per camera (v1, first-wins — mirrors trackToForTarget). Reuses the
// existing TrackTo node when re-targeting; removes it on clear (no orphan nodes).
//
// REF: src/app/nodeConstraints.ts (trackToForTarget / resolveTrackToTarget),
//      src/app/activeCamera.ts (lookAt derivation), issue #204 / vyapti V60.

import { useMemo } from 'react';
import { useDagStore } from '../core/dag/store';
import type { Op } from '../core/dag/types';
import { resolveTrackToTarget, trackToForTarget } from './nodeConstraints';
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
      if (id === nodeId || n.type === 'TrackTo') continue;
      const p = (n.params ?? {}) as Record<string, unknown>;
      if (!isVec3(p.position)) continue;
      out.push({ id, name: typeof p.name === 'string' && p.name ? p.name : id });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [nodes, nodeId]);

  // The currently-bound target (active constraint), and the reusable TrackTo id.
  const boundTargetId = useMemo(
    () => trackToForTarget(nodes, nodeId)?.aimNode ?? '',
    [nodes, nodeId],
  );
  const existingTTId = useMemo(() => {
    const e = Object.entries(nodes).find(
      ([, n]) => n.type === 'TrackTo' && (n.params as { target?: unknown })?.target === nodeId,
    );
    return e?.[0];
  }, [nodes, nodeId]);

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
        [
          { type: 'setParam', nodeId: existingTTId, paramPath: 'aimNode', value },
          { type: 'setParam', nodeId: existingTTId, paramPath: 'mute', value: false },
        ],
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
