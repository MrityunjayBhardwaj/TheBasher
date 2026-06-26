// ComfyRenderProgress — the live progress surface for a "Render coherent clip" batch
// (Inc 4 slice 5b). Renders ONLY while a render is active: a step bar (sampler k/N),
// the executing node, and the latest streaming preview thumbnail from ComfyUI's /ws
// stream. Reads the ephemeral comfyRenderProgressStore (fed by compileComfyBatch's
// onEvent). Without a preview-capable server it still shows the step bar (progress
// events stream regardless of --preview-method).

import { useComfyRenderProgressStore } from '../stores/comfyRenderProgressStore';

export function ComfyRenderProgress() {
  const active = useComfyRenderProgressStore((s) => s.active);
  const label = useComfyRenderProgressStore((s) => s.label);
  const value = useComfyRenderProgressStore((s) => s.value);
  const max = useComfyRenderProgressStore((s) => s.max);
  const node = useComfyRenderProgressStore((s) => s.node);
  const previewUrl = useComfyRenderProgressStore((s) => s.previewUrl);

  if (!active) return null;
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;

  return (
    <div
      data-testid="comfy-render-progress"
      className="m-2 flex flex-col gap-1 rounded border border-line bg-bg-2 p-2 text-[11px] text-fg"
    >
      <div className="flex items-center justify-between">
        <span className="truncate text-mute">Rendering · {label}</span>
        <span className="tabular-nums text-mute" data-testid="comfy-render-progress-pct">
          {max > 0 ? `${pct}%` : '…'}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-bg">
        <div
          className="h-full bg-accent transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
      {node !== null && (
        <span className="text-[9px] uppercase tracking-wide text-fg/40">
          node {node} · step {value}/{max}
        </span>
      )}
      {previewUrl && (
        <img
          src={previewUrl}
          alt="live preview"
          data-testid="comfy-render-progress-preview"
          className="mt-1 w-full rounded border border-line object-contain"
        />
      )}
    </div>
  );
}
