// LightProfileSelect — the PROFILE SWITCH (epic #201, slice #208 increment 2;
// §7.5, [[V62]]). Picks one `LightRig` out of N by name and exposes it on a single
// output that feeds `Scene.inputs.lightRig` — so exactly one lighting profile is
// live at a time, while every rig stays co-resident in the DAG (V34).
//
// This is the ClipSelect pattern (src/nodes/ClipSelect.ts) lifted to lighting: the
// switch is a SINGLE param (`selectedProfile`), so changing the live profile is one
// `setParam` → keyframeable for free (V57): a shot can animate from one lighting
// setup to another, which BLS itself can't do. null-on-miss is deliberate (not a
// fallback to the first rig) — it makes "the selected profile is gone" visible.
//
// Pure: output is a function of (params, inputs.rigs). The renderer recovers the
// selected rig's light node ids through the SAME hop (`resolveRigLightSources` →
// `resolveActiveRigNode`, which reads {@link wiredProfileRigs}), so render and read
// agree on which profile is live.
//
// REF: src/nodes/ClipSelect.ts (the switch pattern); src/nodes/LightRig.ts;
//      src/app/resolveRigLightSources.ts (the matching id-side hop);
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.5; vyapti V62.

import { z } from 'zod';
import type { DagState } from '../core/dag/state';
import type { NodeDefinition, NodeRef, ResolvedInputs } from '../core/dag/types';
import { optionsParam, type ParamOption } from './paramWidget';
import type { LightRigValue } from './types';

/**
 * The rigs a select chooses between: its own `rigs` edges, in order, that point at a
 * `LightRig`, with each rig's `params.name`.
 *
 * ONE reading for both halves that need it. The render hop matches the stored name against
 * this list, and the picker's options are drawn from it, so an option cannot name a rig the
 * resolver would not find (#1064). The value side, `evaluate`, matches the same names off the
 * evaluated rigs (`LightRig.evaluate` copies `params.name`).
 */
export function wiredProfileRigs(
  state: DagState,
  selectId: string,
): readonly { readonly id: string; readonly name: unknown }[] {
  const binding = state.nodes[selectId]?.inputs.rigs;
  const refs: readonly NodeRef[] = Array.isArray(binding)
    ? (binding as NodeRef[])
    : binding
      ? [binding as NodeRef]
      : [];
  const out: { id: string; name: unknown }[] = [];
  for (const ref of refs) {
    const rig = state.nodes[ref.node];
    if (rig?.type === 'LightRig') {
      out.push({ id: rig.id, name: (rig.params as { name?: unknown }).name });
    }
  }
  return out;
}

/**
 * The profiles this select can be switched to — every wired rig, by name.
 *
 * Two kinds are LISTED but disabled, each with the reason, because selecting by name cannot
 * reach them:
 * - a rig whose name is blank: `""` is also this param's "no profile", so the two cannot be
 *   told apart (#1109);
 * - a second rig with a name already taken above it: the lookup takes the first match, so
 *   choosing the name selects the other rig.
 */
export function profileOptions(state: DagState, nodeId: string): ParamOption[] {
  const taken = new Set<string>();
  return wiredProfileRigs(state, nodeId).map(({ name }) => {
    const n = typeof name === 'string' ? name : '';
    if (n === '') {
      return { value: '', label: 'unnamed rig', disabledReason: 'name it to select it' };
    }
    if (taken.has(n)) {
      return { value: n, label: n, disabledReason: 'a rig above has the same name' };
    }
    taken.add(n);
    return { value: n, label: n };
  });
}

export const LightProfileSelectParams = z.object({
  /**
   * The `name` of the live `LightRig`. Empty / no-match → null (no profile) — while no wired
   * rig's name is blank; a blank-named rig makes `""` select it (#1109).
   */
  selectedProfile: optionsParam(z.string().default(''), profileOptions, 'no profile'),
});
export type LightProfileSelectParams = z.infer<typeof LightProfileSelectParams>;

export const LightProfileSelectNode: NodeDefinition<
  LightProfileSelectParams,
  LightRigValue | null
> = {
  type: 'LightProfileSelect',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LightProfileSelectParams,
  inputs: {
    rigs: { type: 'LightRig', cardinality: 'list' },
  },
  outputs: { out: { type: 'LightRig', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params, inputs: ResolvedInputs): LightRigValue | null {
    const raw = inputs.rigs;
    const candidates: readonly LightRigValue[] = Array.isArray(raw)
      ? (raw as LightRigValue[]).filter((r): r is LightRigValue => r != null)
      : raw
        ? [raw as LightRigValue]
        : [];
    return candidates.find((r) => r.name === params.selectedProfile) ?? null;
  },
};
