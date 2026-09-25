// BakePoseConnector — "bake motion to keys" on an armature Object (#1215).
//
// Shown only while the Object's pose chain stands on COMPUTED motion (a retarget, a generated clip):
// `computedSourceOf`, the rule the bake itself reads, so the button cannot offer a bake that would be
// refused as "keys already". It dispatches the agent's own verb, `mutator.animate.bakePose`, at every
// pose or every Nth (Blender's Bake Action frame step; Houdini's MotionClip thinning), linear keys.
// After it, the motion is an override layer of keys at the bottom of the chain, editable; the
// computed source is detached and kept, and one undo takes the bake back.
//
// V8: reads DAG state through a subscribed selector; mutates only through the mutator seam.
//
// REF: src/app/animate/bakePose.ts; src/agent/mutators/builders/bakePose.ts; issue #1215.

import { useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { computedSourceOf, freeBakedLayerId } from './bakePose';
import { nodeDisplayName } from '../sceneTreeWalk';

export function BakePoseConnector({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const [nth, setNth] = useState(1);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const node = state.nodes[nodeId];
  if (!node || node.type !== 'Object') return null;
  const source = computedSourceOf(state, nodeId);
  if (source === null) return said ? <Said said={said} /> : null;

  const bake = () => {
    const res = dispatchMutatorFromUI(
      'mutator.animate.bakePose',
      {
        object: nodeId,
        poses: nth > 1 ? { nth } : 'every',
        interpolation: 'linear',
        layerId: freeBakedLayerId(state, nodeId),
      },
      'bake motion to keys',
    );
    setSaid(
      res.ok
        ? { ok: true, text: `baked ${nodeDisplayName(state.nodes, source.node)} to keys` }
        : { ok: false, text: res.reason },
    );
  };

  return (
    <div className="mt-2" data-testid="inspector-bake-pose">
      <div className="flex items-center gap-1 text-[11px] text-fg/80">
        <span className="font-mono text-[10px] text-fg/50">every</span>
        <input
          type="number"
          min={1}
          step={1}
          aria-label="bake every Nth pose"
          value={nth}
          data-testid="inspector-bake-pose-nth"
          className="w-12 rounded border border-border bg-muted px-1.5 py-0.5 text-right font-mono text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isInteger(n) && n >= 1) setNth(n);
          }}
        />
        <span className="font-mono text-[10px] text-fg/50">pose</span>
        <button
          type="button"
          className="ml-auto rounded border border-border px-2 py-0.5 font-mono text-[10px] text-fg/70 hover:text-fg"
          data-testid="inspector-bake-pose-button"
          title={`Bake ${nodeDisplayName(state.nodes, source.node)} into keys you can edit`}
          onClick={bake}
        >
          bake motion to keys
        </button>
      </div>
      {said ? <Said said={said} /> : null}
    </div>
  );
}

function Said({ said }: { said: { ok: boolean; text: string } }) {
  return (
    <div
      className={`mt-1 font-mono text-[10px] ${said.ok ? 'text-fg/60' : 'text-warn'}`}
      data-testid={said.ok ? 'inspector-bake-pose-done' : 'inspector-bake-pose-refusal'}
    >
      {said.text}
    </div>
  );
}
