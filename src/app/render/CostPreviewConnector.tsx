// CostPreviewConnector — wires <CostPreview /> to the boot-resolved
// ComfyUI + storage capabilities and the preset compile factory.
//
// Inspector renders this when a ComfyUIWorkflow node is selected. Keeps
// the pure CostPreview component free of boot/preset coupling so vitest
// can mount it with deterministic deps.
//
// REF: project_p5_close_prompt Wave C5; vyapti V8 (UI surfaces resolve
// caps from boot helpers, never instantiate them inline).

import { useEffect, useState } from 'react';
import { getComfyCapability, getStorage } from '../boot';
import type { NodeId } from '../../core/dag/types';
import { stylizedRealismPreset } from '../../agent/strategy/presets/stylizedRealism';
import { CostPreview, type CostPreviewDeps } from './CostPreview';

export function CostPreviewConnector({ workflowNodeId }: { workflowNodeId: NodeId }) {
  const [deps, setDeps] = useState<CostPreviewDeps | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getComfyCapability(), getStorage()])
      .then(([capability, storage]) => {
        if (cancelled) return;
        // v0.5: only stylizedRealism is registered (D-02). v0.6 dispatches
        // over presetId via the preset registry.
        const compileWorkflow = stylizedRealismPreset.compile({ storage });
        setDeps({ capability, storage, compileWorkflow });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div
        data-testid="cost-preview-init-error"
        className="border-t border-border bg-muted/30 px-3 py-2 text-[10px] text-red-300"
      >
        cost preview unavailable: {error}
      </div>
    );
  }
  if (!deps) {
    return (
      <div
        data-testid="cost-preview-loading"
        className="border-t border-border bg-muted/30 px-3 py-2 text-[10px] text-fg/40"
      >
        loading capabilities…
      </div>
    );
  }
  return <CostPreview workflowNodeId={workflowNodeId} deps={deps} />;
}
