// EffectControlsSection — the EFFECT-section renderer for the Controls panel (Inc 3
// Slice D step 3). The panel folds the layer's effect chain in beside the SOURCE
// section: each effect (ColorCorrect today) renders its keyframeable param rows — the
// SAME content the timeline twirl-down shows (LayerTimeline's OutlineEffectPropRow),
// the two surfaces of the AE contract. Both wire the ONE shared animatable seam
// (useAnimatableField + ParamDiamond — H104) targeting the effect node directly with a
// free-floating [[V57]] channel, so the panel diamond and the timeline diamond read the
// SAME channel and cannot drift. Effect params are plain scalars → the native first-key
// road (KeyframeChannelNumber) is correct (no comfy valueKind dispatch needed here).
//
// The panel diamond testids are namespaced `controls-effect-*` — DISTINCT from the
// timeline's `layer-effect-*` (H95: two surfaces rendering a diamond for the same
// (nodeId, paramPath) must not collide on a strict locator).
//
// REF: docs/COMPOSITOR-DESIGN.md §7.1; src/app/video/LayerTimeline.tsx
//      (OutlineEffectPropRow — the mirrored row); src/app/animate/useAnimatableField.ts
//      + src/app/ParamDiamond.tsx; vyapti V57/V58; hetvabhasa H104/H95.

import { useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import { ParamDiamond } from '../ParamDiamond';
import { useAnimatableField } from '../animate/useAnimatableField';

/** A keyframeable scalar param of an effect node. */
interface EffectParam {
  readonly key: string;
  readonly label: string;
  readonly paramPath: string;
  readonly step: number;
  readonly fallback: number;
}

/** Per-effect-type param tables. New effects register by adding their type → params
 *  (mirrors LayerTimeline's EFFECT_PROPS — the same scalars, the same default). */
const EFFECT_PARAMS: Record<string, readonly EffectParam[]> = {
  ColorCorrect: [
    { key: 'brightness', label: 'Brightness', paramPath: 'brightness', step: 0.05, fallback: 1 },
    { key: 'contrast', label: 'Contrast', paramPath: 'contrast', step: 0.05, fallback: 1 },
    { key: 'saturation', label: 'Saturation', paramPath: 'saturation', step: 0.05, fallback: 1 },
  ],
};

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function EffectControlsSection({ nodeId }: { nodeId: NodeId }) {
  const nodeType = useDagStore((s) => s.state.nodes[nodeId]?.type);
  const params = nodeType ? (EFFECT_PARAMS[nodeType] ?? []) : [];
  if (params.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] text-mute">No controls for {nodeType ?? 'effect'} yet.</p>
    );
  }
  return (
    <div data-testid={`effect-controls-${nodeId}`} className="flex flex-col">
      {params.map((p) => (
        <EffectParamRow key={p.key} effectId={nodeId} param={p} />
      ))}
    </div>
  );
}

/** One effect scalar param — an animatable row (value field + diamond) routed through
 *  the shared seam, targeting the effect node directly (free-floating V57 channel). */
function EffectParamRow({ effectId, param }: { effectId: NodeId; param: EffectParam }) {
  const base = useDagStore((s) =>
    num(
      (s.state.nodes[effectId]?.params as Record<string, unknown>)?.[param.paramPath],
      param.fallback,
    ),
  );
  const { effective, readOnly, onEdit } = useAnimatableField<number>(
    effectId,
    param.paramPath,
    base,
    (next) =>
      useDagStore
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: effectId, paramPath: param.paramPath, value: next }],
          'user',
          `set ${param.label}`,
        ),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = parseFloat(draft);
    if (Number.isFinite(n)) onEdit(n);
    setDraft(null);
  };
  const display = String(Math.round(effective * 100) / 100);
  return (
    <div
      data-testid={`controls-effect-row-${effectId}-${param.key}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
    >
      <span className="flex-1 truncate text-mute" title={param.label}>
        {param.label}
      </span>
      <input
        type="number"
        step={param.step}
        value={draft ?? display}
        readOnly={readOnly}
        data-testid={`controls-effect-input-${effectId}-${param.key}`}
        onFocus={() => setDraft(display)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-16 rounded border border-line bg-bg-2 px-1 text-right text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
      <ParamDiamond
        nodeId={effectId}
        paramPath={param.paramPath}
        value={base}
        testid={`controls-effect-diamond-${effectId}-${param.key}`}
      />
    </div>
  );
}
