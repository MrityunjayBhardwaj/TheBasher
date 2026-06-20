// UX #9 slice 3 — the Scene inspector's Environment control.
//
// Authors the scene-level HDRI/IBL config (the Scene node's env params) as ONE
// cohesive control instead of raw param rows: a source mode (None / Preset /
// File), a preset dropdown or an .hdr/.exr import button, and intensity /
// Y-rotation / "show as background" fields. Every edit dispatches a single
// `setParam` Op (V1/V8 — the inspector mutates the DAG only through ops), so it
// saves, undoes, and renders like any creative datum (V34/V47).
//
// Routed under the Environment section (inspectorSections.ts); the generic
// ParamRows for that section are suppressed in NPanel because this control owns
// the env params.
//
// REF: src/nodes/Scene.ts (env params); src/app/asset/importEnvironmentHdri.ts;
//      src/app/envPresets.ts; vyapti V47. Mirrors NPanel MapRow / BooleanField.

import { useRef } from 'react';
import { useDagStore } from '../core/dag/store';
import type { EnvironmentSource } from '../nodes/types';
import { ENV_PRESET_NAMES } from './envPresets';
import { importEnvironmentHdri } from './asset/importEnvironmentHdri';
import { useAssetErrorStore } from './stores/assetErrorStore';
import { ParamDiamond } from './ParamDiamond';
import { useAnimatableField } from './animate/useAnimatableField';

const DEFAULT_SOURCE: EnvironmentSource = { kind: 'none' };

/** Display label for a file source — the user's original filename if known,
 *  else the assetRef basename (legacy file sources predate `name`). */
function fileLabel(source: { assetRef: string; name?: string }): string {
  if (source.name) return source.name;
  const slash = source.assetRef.lastIndexOf('/');
  return slash >= 0 ? source.assetRef.slice(slash + 1) : source.assetRef;
}

const MODE_BTN =
  'rounded border px-2 py-0.5 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

export function SceneEnvironmentControls({ nodeId }: { nodeId: string }) {
  const params = useDagStore((s) => s.state.nodes[nodeId]?.params) as
    | {
        envSource?: EnvironmentSource;
        envIntensity?: number;
        envRotationY?: number;
        envBackground?: boolean;
      }
    | undefined;
  const dispatch = useDagStore((s) => s.dispatch);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const source = params?.envSource ?? DEFAULT_SOURCE;
  const intensity = params?.envIntensity ?? 1;
  const rotationY = params?.envRotationY ?? 0;
  const background = params?.envBackground ?? false;
  const mode = source.kind;

  const setParam = (paramPath: string, value: unknown, label: string) =>
    dispatch({ type: 'setParam', nodeId, paramPath, value }, 'user', label);

  // Animatable-field spines (diamond + Auto-Key + evaluated read — the H104
  // affordance), so the env intensity / Y-rotation keyframe. These RENDER via seam B
  // (SceneEnvChannelsR re-applies the channels onto the live scene per frame).
  const intensityField = useAnimatableField(nodeId, 'envIntensity', intensity, (v) =>
    setParam('envIntensity', v, 'set environment intensity'),
  );
  const rotationField = useAnimatableField(nodeId, 'envRotationY', rotationY, (v) =>
    setParam('envRotationY', v, 'set environment rotation'),
  );

  const setSource = (next: EnvironmentSource) =>
    setParam('envSource', next, `set environment ${next.kind}`);

  // Switching to 'preset' preserves the last preset name if we already had one.
  const onPickMode = (kind: EnvironmentSource['kind']) => {
    if (kind === mode) return;
    if (kind === 'none') {
      setSource({ kind: 'none' });
    } else if (kind === 'preset') {
      const name = source.kind === 'preset' ? source.name : 'studio';
      setSource({ kind: 'preset', name });
    } else {
      // 'file' — need an assetRef. Reuse the existing one, else open the picker.
      if (source.kind === 'file') setSource(source);
      else fileInputRef.current?.click();
    }
  };

  const onImport = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const assetRef = await importEnvironmentHdri(bytes, file.name);
      // Keep the user's original filename for display — the assetRef is the
      // content-hash path, which is meaningless to read.
      setSource({ kind: 'file', assetRef, name: file.name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      useAssetErrorStore.getState().report(`${nodeId}:env`, `Environment import failed: ${msg}`);
    }
  };

  return (
    <div className="flex flex-col" data-testid={`inspector-environment-${nodeId}`}>
      {/* Source mode */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
        <span className="font-mono text-fg/60">source</span>
        <span className="flex items-center gap-1">
          {(['none', 'preset', 'file'] as const).map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`inspector-env-mode-${k}`}
              aria-pressed={mode === k}
              onClick={() => onPickMode(k)}
              className={`${MODE_BTN} ${
                mode === k
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-border bg-muted text-fg/80 hover:text-accent'
              }`}
            >
              {k}
            </button>
          ))}
        </span>
      </div>

      {/* Preset dropdown */}
      {mode === 'preset' ? (
        <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
          <span className="font-mono text-fg/60">preset</span>
          <select
            data-testid={`inspector-env-preset-${nodeId}`}
            value={source.kind === 'preset' ? source.name : 'studio'}
            onChange={(e) => setSource({ kind: 'preset', name: e.target.value })}
            className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {ENV_PRESET_NAMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {/* File import */}
      {mode === 'file' ? (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
          <span
            className="truncate font-mono text-[10px] text-fg/40"
            data-testid={`inspector-env-file-name-${nodeId}`}
          >
            {source.kind === 'file' ? fileLabel(source) : '— none'}
          </span>
          <button
            type="button"
            data-testid={`inspector-env-import-${nodeId}`}
            onClick={() => fileInputRef.current?.click()}
            className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-fg/80 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {source.kind === 'file' ? 'replace' : 'import…'}
          </button>
        </div>
      ) : null}

      {/* Hidden file input — shared by the File mode button and import/replace. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".hdr,.exr,image/vnd.radiance,image/x-exr"
        aria-label="environment HDRI file"
        data-testid={`inspector-env-file-${nodeId}`}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onImport(f);
          e.target.value = '';
        }}
      />

      {/* Shared lighting params — only meaningful when a source is set. */}
      {mode !== 'none' ? (
        <>
          <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
            <span className="flex items-center gap-1">
              <ParamDiamond nodeId={nodeId} paramPath="envIntensity" value={intensity} />
              <span className="font-mono text-fg/60">intensity</span>
            </span>
            <input
              type="number"
              step={0.1}
              min={0}
              value={intensityField.effective}
              readOnly={intensityField.readOnly}
              data-readonly-while-playing={intensityField.readOnly || undefined}
              data-testid={`inspector-env-intensity-${nodeId}`}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) intensityField.onEdit(n);
              }}
              className="w-16 rounded border border-border bg-muted px-1.5 py-0.5 text-right text-[10px] text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
          </label>
          <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
            <span className="flex items-center gap-1">
              <ParamDiamond nodeId={nodeId} paramPath="envRotationY" value={rotationY} />
              <span className="font-mono text-fg/60">rotation Y°</span>
            </span>
            <input
              type="number"
              step={5}
              value={rotationField.effective}
              readOnly={rotationField.readOnly}
              data-readonly-while-playing={rotationField.readOnly || undefined}
              data-testid={`inspector-env-rotation-${nodeId}`}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) rotationField.onEdit(n);
              }}
              className="w-16 rounded border border-border bg-muted px-1.5 py-0.5 text-right text-[10px] text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
            <span className="font-mono text-fg/60">show as background</span>
            <input
              type="checkbox"
              checked={background}
              data-testid={`inspector-env-background-${nodeId}`}
              onChange={(e) => setParam('envBackground', e.target.checked, 'toggle environment bg')}
              className="h-3.5 w-3.5 accent-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
          </label>
        </>
      ) : null}
    </div>
  );
}
