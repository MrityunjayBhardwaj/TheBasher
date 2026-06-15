// RenderAnimationProgress — the modal overlay shown while an animation render
// runs (#189). Subscribes to renderAnimationStore: a frame counter + progress
// bar + Cancel. Mounted once in App; renders nothing when idle.

import { useRenderAnimationStore } from './stores/renderAnimationStore';

export function RenderAnimationProgress() {
  const active = useRenderAnimationStore((s) => s.active);
  const done = useRenderAnimationStore((s) => s.done);
  const total = useRenderAnimationStore((s) => s.total);
  const format = useRenderAnimationStore((s) => s.format);
  const cancel = useRenderAnimationStore((s) => s.cancel);

  if (!active) return null;

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const label = format === 'mp4' ? 'MP4 video' : 'PNG sequence';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rendering animation"
      data-testid="render-animation-progress"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
    >
      <div className="flex w-80 flex-col gap-3 rounded-lg border border-border bg-bg-2 p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-fg">Rendering {label}…</span>
          <span className="font-mono text-xs text-fg/60" data-testid="render-animation-count">
            {done}/{total}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${pct}%` }}
            data-testid="render-animation-bar"
          />
        </div>
        <button
          type="button"
          data-testid="render-animation-cancel"
          onClick={() => cancel?.()}
          className="self-end rounded border border-border bg-muted px-3 py-1 text-xs text-fg/80 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
