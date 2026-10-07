// WrapInRigConnector — "wrap in a Rig" on an armature Object (#1357).
//
// Shown only while the Object's own wire holds an ik layer that is not in a Rig yet
// (`rigCandidateLayers`, the rule the wrap itself reads, so the button cannot offer a wrap that
// would be refused as "no layers"). It dispatches the agent's own verb,
// `mutator.animate.wrapInRig`: the solves and the layers over them move inside one Rig node, and
// the pose the character draws does not change. One undo takes it back.
//
// V8: reads DAG state through a subscribed selector; mutates only through the mutator seam.
//
// REF: src/app/animate/wrapInRig.ts; src/agent/mutators/builders/wrapInRig.ts; issue #1357.

import { useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { WRAP_IN_RIG_LABEL, freeRigIds, rigCandidateLayers } from './wrapInRig';

export function WrapInRigConnector({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const node = state.nodes[nodeId];
  if (!node || node.type !== 'Object') return null;
  const layers = rigCandidateLayers(state, nodeId);
  if (layers.length === 0) {
    return said ? (
      <div className="mt-2 px-3">
        <Said said={said} />
      </div>
    ) : null;
  }

  const wrap = () => {
    const res = dispatchMutatorFromUI(
      'mutator.animate.wrapInRig',
      { object: nodeId, layers, ...freeRigIds(state, nodeId) },
      WRAP_IN_RIG_LABEL,
    );
    setSaid(
      res.ok
        ? {
            ok: true,
            text: `${layers.length} ${layers.length === 1 ? 'layer is' : 'layers are'} inside a Rig`,
          }
        : { ok: false, text: res.reason },
    );
  };

  return (
    <div className="mt-2 px-3" data-testid="inspector-wrap-in-rig">
      <div className="flex items-center gap-1 text-[11px] text-fg/80">
        <span className="font-mono text-[10px] text-fg/50">
          {layers.length} {layers.length === 1 ? 'layer' : 'layers'} from the IK up
        </span>
        <button
          type="button"
          className="ml-auto rounded border border-border px-2 py-0.5 font-mono text-[10px] text-fg/70 hover:text-fg"
          data-testid="inspector-wrap-in-rig-button"
          title="Move the IK layers and the layers over them inside one Rig node. The pose does not change."
          onClick={wrap}
        >
          {WRAP_IN_RIG_LABEL}
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
      data-testid={said.ok ? 'inspector-wrap-in-rig-done' : 'inspector-wrap-in-rig-refusal'}
    >
      {said.text}
    </div>
  );
}
