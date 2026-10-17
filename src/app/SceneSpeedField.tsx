// #1594 — the scene's speed, in the Timebar beside End: 1 is real time, 0.05 near-frozen.
//
// A keyable field on the Scene's `timeSpeed` (the diamond keys it at the playhead), so one drag
// — or two keys — slows every moving thing in the scene together while a camera keeps real
// time. Scene time is the speed added up over the playhead (`sceneClock.ts`).

import { useDagStore } from '../core/dag/store';
import { ParamDiamond } from './ParamDiamond';
import { useAnimatableField } from './animate/useAnimatableField';
import { sceneNodeId } from './sceneRange';

export function SceneSpeedField() {
  const id = useDagStore((s) => sceneNodeId(s.state));
  if (!id) return null;
  return <SpeedField nodeId={id} />;
}

function SpeedField({ nodeId }: { nodeId: string }) {
  const stored = useDagStore(
    (s) => (s.state.nodes[nodeId]?.params as { timeSpeed?: unknown } | undefined)?.timeSpeed,
  );
  const dispatch = useDagStore((s) => s.dispatch);
  const base = typeof stored === 'number' && Number.isFinite(stored) ? stored : 1;
  const field = useAnimatableField(nodeId, 'timeSpeed', base, (v) =>
    dispatch(
      { type: 'setParam', nodeId, paramPath: 'timeSpeed', value: v },
      'user',
      'set scene speed',
    ),
  );
  return (
    <label
      className="flex items-center gap-1"
      title="Scene speed: 1 is real time, below 1 slows every moving thing at once; cameras keep real time"
    >
      <ParamDiamond
        nodeId={nodeId}
        paramPath="timeSpeed"
        value={base}
        testid="timebar-speed-diamond"
      />
      Speed
      <input
        type="number"
        min={0}
        step={0.05}
        value={Number(field.effective.toFixed(3))}
        readOnly={field.readOnly}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= 0) field.onEdit(n);
        }}
        className="w-14 rounded border border-border bg-transparent px-1 font-mono tabular-nums"
        data-testid="timebar-speed"
      />
      ×
    </label>
  );
}
