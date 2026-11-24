// The variants a `ModelGenerate` has produced, with Keep and Regenerate (#1720).
//
// Shown in two places, from one component: under the Generate form while a run is the active
// one, and in the Library's details for an asset a Model generate made — so Regenerate on a kept
// model happens beside the record of where it came from, and the new variant appears there.
//
// It reads the node from the graph and nothing else; every action goes through the road in
// `src/app/asset/generateModel.ts`, which dispatches. V8: app-layer.

import { useMemo, useState, type ReactNode } from 'react';
import { useDagStore } from '../../core/dag/store';
import {
  keepModelVariant,
  modelGenerateParamsOfNode,
  regenerateModel,
} from '../asset/generateModel';
import { useModelGenerationStore } from '../stores/modelGenerationStore';

/** A stable colour per seed, so two variants read as two at a glance before thumbnails exist. */
export function variantSwatch(seed: number): string {
  const hue = Math.abs(Math.imul(seed, 2654435761) >>> 0) % 360;
  return `hsl(${hue} 45% 55%)`;
}

export function ModelVariants({ nodeId }: { nodeId: string }): ReactNode {
  // The node itself is the selected slice (a stable reference until it changes); parsing it into
  // params happens outside the selector, which must not return a fresh object per call.
  const node = useDagStore((s) => s.state.nodes[nodeId]);
  const params = useMemo(() => modelGenerateParamsOfNode(node), [node]);
  const run = useModelGenerationStore((s) => s.run);
  const [keeping, setKeeping] = useState<number | null>(null);
  if (!params) return null;

  const runningHere = run?.nodeId === nodeId;
  const pending = runningHere ? Math.max(0, run.total - run.done) : 0;
  const busy = run !== null || keeping !== null;

  return (
    <div data-testid="model-variants" data-node-id={nodeId} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px] text-fg-dim">
        <span>
          Variants · <span className="tabular-nums">{params.variants.length}</span>
        </span>
        <button
          type="button"
          data-testid="model-regenerate"
          disabled={busy}
          onClick={() => void regenerateModel(nodeId)}
          title="Run the same request again with a new seed"
          className="rounded border border-border px-2 py-0.5 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          Regenerate
        </button>
      </div>
      <ul className="grid grid-cols-2 gap-1.5">
        {params.variants.map((v, i) => (
          <li
            key={v.seed}
            data-testid={`model-variant-${v.seed}`}
            data-kept={v.kept || undefined}
            className="flex flex-col gap-1 rounded border border-border bg-bg/40 p-1.5"
          >
            <span
              aria-hidden
              className="h-10 w-full rounded"
              style={{ background: variantSwatch(v.seed) }}
            />
            <span className="truncate text-[11px] text-fg/80">
              {i + 1} · seed <span className="font-mono">{v.seed}</span>
            </span>
            {v.kept ? (
              <span className="text-[11px] text-accent">Kept</span>
            ) : (
              <button
                type="button"
                data-testid={`model-variant-keep-${v.seed}`}
                disabled={busy}
                onClick={() => {
                  setKeeping(v.seed);
                  // Never rejects — the banner carries a failure.
                  void keepModelVariant(nodeId, v.seed).finally(() => setKeeping(null));
                }}
                className="rounded border border-border px-2 py-0.5 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {keeping === v.seed ? 'Keeping…' : 'Keep'}
              </button>
            )}
          </li>
        ))}
        {Array.from({ length: pending }, (_, i) => (
          <li
            key={`pending-${i}`}
            data-testid="model-variant-pending"
            className="flex h-[86px] items-center justify-center rounded border border-dashed border-border text-[11px] text-fg-mute"
          >
            generating…
          </li>
        ))}
      </ul>
    </div>
  );
}
