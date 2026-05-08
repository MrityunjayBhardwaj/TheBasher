// LayerRowControls — mute / solo toggles for an AnimationLayer row.
//
// V8 file-rooted: dispatch lives here in src/app/, not in src/timeline/.
// The Dopesheet imports this component but never dispatches itself.
//
// Mute and solo are per-layer params (P3 Wave A). Toggling either emits a
// single setParam Op which round-trips through the Op dispatcher → undo
// stack stays clean (one click = one Cmd+Z entry).

import { useDagStore } from '../../core/dag/store';

export function LayerRowControls({
  layerId,
  mute,
  solo,
}: {
  layerId: string;
  mute: boolean;
  solo: boolean;
}) {
  const dispatch = useDagStore((s) => s.dispatch);

  const toggleMute = () => {
    dispatch({ type: 'setParam', nodeId: layerId, paramPath: 'mute', value: !mute });
  };
  const toggleSolo = () => {
    dispatch({ type: 'setParam', nodeId: layerId, paramPath: 'solo', value: !solo });
  };

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        data-testid={`layer-mute-${layerId}`}
        aria-pressed={mute}
        title={mute ? 'Unmute layer' : 'Mute layer'}
        className={`h-5 w-5 rounded border text-[10px] ${mute ? 'bg-warn text-bg' : 'border-line text-mute hover:text-fg'}`}
        onClick={toggleMute}
      >
        M
      </button>
      <button
        type="button"
        data-testid={`layer-solo-${layerId}`}
        aria-pressed={solo}
        title={solo ? 'Unsolo layer' : 'Solo layer'}
        className={`h-5 w-5 rounded border text-[10px] ${solo ? 'bg-accent text-bg' : 'border-line text-mute hover:text-fg'}`}
        onClick={toggleSolo}
      >
        S
      </button>
    </div>
  );
}
