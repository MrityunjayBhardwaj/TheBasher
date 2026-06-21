// GltfEntryChooser — the modal shown when an imported folder has more than one
// glTF file, so the user picks which model to import instead of Basher silently
// auto-guessing the shallowest one (#214 follow-up). Store-driven, mounted once
// in App; renders nothing when idle. Mirrors RenderAnimationProgress.

import { useEffect } from 'react';
import { useGltfEntryChooserStore, type GltfEntryOption } from './stores/gltfEntryChooserStore';

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function countLabel(opt: GltfEntryOption): string {
  if (opt.materials === null) return 'binary .glb';
  const mats = `${opt.materials} material${opt.materials === 1 ? '' : 's'}`;
  const texs = `${opt.textures ?? 0} texture${opt.textures === 1 ? '' : 's'}`;
  return `${mats} · ${texs}`;
}

export function GltfEntryChooser() {
  const request = useGltfEntryChooserStore((s) => s.request);
  const choose = useGltfEntryChooserStore((s) => s.choose);
  const chooseAll = useGltfEntryChooserStore((s) => s.chooseAll);
  const cancel = useGltfEntryChooserStore((s) => s.cancel);

  // Esc dismisses (→ resolves null → the import aborts). Bound only while open.
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, cancel]);

  if (!request) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose which glTF to import"
      data-testid="gltf-entry-chooser"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="flex w-[26rem] max-w-[90vw] flex-col gap-3 rounded-lg border border-border bg-bg-2 p-5 shadow-xl">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-fg">This folder has multiple glTF files</span>
          <span className="text-xs text-fg/60">
            Choose which model to import — textures are shared from the same folder.
          </span>
        </div>
        <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-auto">
          {request.options.map((opt, i) => (
            <button
              key={opt.relativePath}
              type="button"
              autoFocus={i === 0}
              data-testid="gltf-entry-option"
              data-relpath={opt.relativePath}
              onClick={() => choose(opt.relativePath)}
              className="flex flex-col items-start gap-0.5 rounded border border-border bg-muted px-3 py-2 text-left hover:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <span className="font-mono text-xs text-fg">{basename(opt.relativePath)}</span>
              <span className="text-[11px] text-fg/60">{countLabel(opt)}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid="gltf-entry-import-all"
            onClick={chooseAll}
            className="rounded border border-border bg-muted px-3 py-1 text-xs text-fg/80 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Import all {request.options.length} as separate models
          </button>
          <button
            type="button"
            data-testid="gltf-entry-cancel"
            onClick={cancel}
            className="rounded border border-border bg-muted px-3 py-1 text-xs text-fg/80 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
