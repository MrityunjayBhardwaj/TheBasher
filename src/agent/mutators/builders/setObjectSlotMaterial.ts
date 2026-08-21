// setObjectSlotMaterial Mutator — points ONE Object's material slot somewhere else, without
// touching the data node it shares (#645 P4).
//
// ── WHAT THIS IS THE AUTHORING HALF OF ────────────────────────────────────────────────
//
// #645 gave `ObjectValue` a sparse per-slot override and moved the derivation so the
// renderer and the read side both resolve through it. Nothing could ASK for one: the
// capability shipped and no surface reached it. This is that surface for the agent road.
//
// An entry's presence IS the reference's `link == OBJECT` for that slot; its absence is
// `link == DATA`. So this Mutator's whole job is to put one entry into
// `ObjectParams.slotOverrides`, and the interesting part is not the write — it is the
// refusal below.
//
// ── THE REFUSAL, WHICH IS THE POINT OF THIS FILE ──────────────────────────────────────
//
// The resolution (`objectSlotsOf`) maps overrides over the DATA's table, so an override
// naming an index the data has no slot for is a NO-OP. It has to be: the resolution runs on
// the render road and cannot throw, and in the reference an object's slot count IS its
// data's, so there is no such slot to point anywhere.
//
// A silent no-op at the authoring surface is exactly the failure this whole area has been
// paying for — a write that appears to succeed and changes nothing. `objectSlotsOf` cannot
// refuse it, so this can and does. That obligation was written down when the resolution
// landed, and this is it being met rather than remembered.
//
// ⚠️ IT COSTS AN EVALUATION, and that is a deliberate exception. Preconditions here are
// shape-only by rule (P-5), and 1 of 26 builders evaluates. But "how many slots does this
// object's data declare" is not answerable from shape: the table is built by whatever the
// modifier and material chain produced, so only the resolved value knows. The alternative
// is not a cheaper check — it is no check, and a silently dropped write.
//
// ⚠️ NOT `MaterialOverrideValue.slotIndex`. That names the i-th `isMesh` in a cloned glTF's
// traverse order — a different addressing dimension entirely. Two meanings of "slot"; this
// one indexes the material slot TABLE.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op, EvalCtx } from '../../../core/dag/types';
import { resolveEvaluatedMesh } from '../../../app/resolveEvaluatedMesh';
import { hydrateInlineMaterial } from '../../../nodes/materialSchema';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Frame 0. The slot COUNT is a property of the chain's shape, not of the timeline — but
 *  the resolver needs a time, and every other static caller uses this one. */
const STATIC_CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

const SetObjectSlotMaterialSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  slotIndex: z
    .number()
    .int()
    .nonnegative()
    .describe('Which material slot of the object to re-point, counting from 0.'),
  color: z
    .string()
    .regex(HEX_RE, '#rrggbb hex required (CSS convention).')
    .describe('CSS hex color, e.g. "#00ff00".'),
});
export type SetObjectSlotMaterialSpec = z.infer<typeof SetObjectSlotMaterialSpec>;

/** The object's slot count, or null when the target is not an object carrying a mesh. */
function slotCountOf(state: DagState, id: string): number | null {
  const mesh = resolveEvaluatedMesh(state, id, STATIC_CTX);
  return mesh ? mesh.materials.slots.length : null;
}

export const setObjectSlotMaterialMutator: MutatorDefinition<SetObjectSlotMaterialSpec> = {
  name: 'mutator.setObjectSlotMaterial',
  description:
    'Re-point ONE material slot on an object, leaving the data node it reads untouched. ' +
    'Two objects sharing one mesh can wear different materials this way, without adding an ' +
    'operator to either branch. Slots not named here keep coming from the shared data.',
  spec: SetObjectSlotMaterialSpec,
  specExample: { targetSelectors: ['node_id'], slotIndex: 0, color: '#00ff00' },
  contract: {
    requiredEdges: ['data'],
    requiredNodeTypes: [],
    // The point of the mechanism: the shared data node is never written.
    preserves: ['position', 'rotation', 'scale', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['parent', 'data'],
    };
  },
  preconditions(spec, _closure, state) {
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      if (!node) return { ok: false, reason: `Target "${id}" not in DAG.` };
      if (node.type !== 'Object') {
        return {
          ok: false,
          reason:
            `Target "${id}" is a ${node.type}. A slot override lives on the OBJECT, which ` +
            `is what lets two objects share one mesh and still look different — so the ` +
            `target has to be the Object, not the data it reads.`,
        };
      }
      const count = slotCountOf(state, id);
      if (count === null) {
        return { ok: false, reason: `Target "${id}" is an Object with no mesh data to slot.` };
      }
      // 🔴 THE REFUSAL. An out-of-range index resolves to nothing — the table's length is
      // the data's — so accepting it would write a param that changes no pixel and reports
      // no error. Named with the actual count, because "invalid slot" leaves the author
      // guessing at the one number that would have helped.
      if (spec.slotIndex >= count) {
        return {
          ok: false,
          reason:
            `Target "${id}" has ${count} material slot${count === 1 ? '' : 's'} ` +
            `(0..${count - 1}); slot ${spec.slotIndex} does not exist. An object's slot ` +
            `count comes from its data — give the data more slots first, or pick an ` +
            `existing one.`,
        };
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, _state: DagState): Op[] {
    // Hydrated to a full spec rather than handed a partial. A half-built material reaching
    // the renderer is how a slot silently loses its roughness — and the slot table is read
    // by identity in places, so what lands here is what draws.
    const material = hydrateInlineMaterial(null, spec.color);
    return spec.targetSelectors.map((id) => ({
      type: 'setParam',
      nodeId: id,
      paramPath: `slotOverrides.${spec.slotIndex}`,
      value: material,
    }));
  },
};
