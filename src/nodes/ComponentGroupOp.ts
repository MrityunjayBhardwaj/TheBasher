// ComponentGroupOp — the first operator whose attribute VALUES are the author's statement.
// #1027, gate 1 of #734's chain, under #607.
//
// It names a set of faces. Houdini's Group SOP at the substrate; Blender's vertex-group panel
// at the interaction model — the split #607 already draws. The geometry is untouched: what
// leaves here is the same mesh carrying one more face-domain attribute, so this sits in the
// modifier stack the way `SetMaterialOp` does, having an opinion about the DATA on the mesh
// rather than about its shape.
//
// ── WHY THIS NODE IS THE GATE, STATED PRECISELY ───────────────────────────────────────
//
// 🔴 IT IS NOT "THE FIRST OPERATOR THAT AUTHORS AN ATTRIBUTE" — `UVProjectModifier` (#994)
// holds that, and claiming it here would have been this repo's most-repeated defect, a comment
// asserting a status the code contradicts. The difference is narrower and it is the one the
// chain actually turns on:
//
//   #994 authors a LAYER whose VALUES are a geometric function — a projection of built
//        positions, chosen per face from that face's normal. The author picks a size, never a
//        value. Consequently the layer cannot ride a minting kind at all (#881: a key is
//        content-derived, and those values need built positions).
//   here the values ARE the author's statement — "these faces are called `arm`" is derivable
//        from nothing else in the system — and the NAME is too. Because membership is a
//        function of the descriptor, it rides the carriage that #994's layer cannot.
//
// So what was missing was not a writer in general; it was an attribute the author supplies
// the values of, which is the only kind a named region can be made of. Measured before
// building it: all seven mint sites in `meshAttributes` derive their values, and a sweep of
// 650 production files finds no other road — the ten `setAttribute` hits are all
// `THREE.BufferGeometry.setAttribute`, carrying a model attribute OUT to the GPU.
//
// What it does NOT need to build, because it was already true: the propagation. A face
// attribute rides the tiled carriage, which is keyed on the DOMAIN and not on the attribute's
// name, so a group survives a topology change for free. Observed on a box before this node
// existed — `group:arm` on faces {0,1,2}, arrayed x3, comes out as eighteen faces with the
// membership repeated per copy; an `edge`-domain attribute minted in the same set is dropped
// by the same call, so the survival is a real positive and not a probe that reports
// everything.
//
// ── WHAT IS STILL REFUSED, AND WHY THAT IS THE NEXT COMMIT AND NOT THIS ONE ───────────
//
// A group authored here cannot yet be ADDRESSED by name: `scopeQuery` refuses a bare name
// with *"named groups are not implemented"*. Writing the group and teaching the query to read
// it are two changes with two different falsifiers, and landing them together would mean
// neither is tested against the other's absence. The name resolves in the commit after this
// one; until then this node's output is observable through the attribute set, which is where
// its gate reads it.
//
// ── THE ONE THING A DIRECTOR CAN GET WRONG, MADE UNCONSTRUCTIBLE ──────────────────────
//
// A group name is refined by `isValidGroupName` on the schema, so a name the query grammar
// could never address again — anything with `-`, `:`, `*`, `@`, a leading digit — never enters
// params. That is the same rung `scope` stands on: not guarded at read time, but without a
// constructor. It matters more here than usual because the failure would be SILENT and LATE —
// the group would mint, ride the carriage correctly, and simply have no spelling that names it.
//
// REF: src/nodes/componentGroups.ts (the name rule and why it is the query grammar's
//      complement); src/nodes/meshAttributes.ts (`mintGroupAttributes`);
//      src/nodes/componentSelection.ts (the ONE resolver); issues #1027, #607, #734.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ScopeDomain } from './attributes';
import type { ObjectData } from './types';
import { refWithAttributeKey } from '../app/modifierGeometry';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';
import { requireResolvedScope, SCOPE_PARAM, scopeParam } from './componentSelection';
import { isValidGroupName } from './componentGroups';
import { mintGroupAttributes } from './meshAttributes';

export const ComponentGroupOpParams = z.object({
  /**
   * THE GROUP'S NAME — the whole point of the node, and the only field a director must fill.
   *
   * Blank is the unconfigured state and passes through untouched, exactly as an unwired target
   * does. An empty name is not a group called "": it is an author who has added the node and
   * not yet said what they are naming, and minting `group:` for them would put an unaddressable
   * attribute on the mesh and re-key its geometry for nothing.
   *
   * 🔴 `.refine()` IS LOAD-BEARING — see the header. A name outside the grammar's reach mints
   * happily and can never be written in a query again, which is a silent loss rather than an
   * error. Refusing it at the schema means it never reaches params.
   */
  name: z
    .string()
    .refine((v) => v === '' || isValidGroupName(v), {
      message:
        'not a group name — start with a letter or underscore and use only letters, digits and underscores (the query grammar spends `-`, `:`, `*`, `@`, `!` and `^` on other things)',
    })
    .default(''),
  /**
   * Stack mute-bypass (V58). The param CARRIES the state; `chain.bypass` below names it and
   * the evaluator honours it, handing the spine value back without running `evaluate`.
   * Nothing in this file reads it.
   */
  muted: z.boolean().default(false),
  /**
   * THE COMPONENT SCOPE — which faces the name applies to.
   *
   * Nothing in this file reads it: the param carries the authored text and the evaluator
   * resolves it through the ONE resolver, handing `evaluate` the answer. An operator reading
   * this field itself would be a second producer of the scope beside the resolver.
   */
  [SCOPE_PARAM]: scopeParam(),
});
export type ComponentGroupOpParams = z.infer<typeof ComponentGroupOpParams>;

/**
 * The atom class this operator's scope names. Face-only in v1, following #607: a group of
 * points or edges is the same mechanism at a domain that has no consumer yet — `edge` is
 * declared `dropped` by the carriage table for exactly that reason.
 */
const SCOPE_DOMAIN: ScopeDomain = 'face';

export const ComponentGroupOpNode: NodeDefinition<ComponentGroupOpParams, ObjectData> = {
  type: 'ComponentGroupOp',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ComponentGroupOpParams,
  inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  chain: {
    input: 'target',
    // `'target'`, with the Mask: the selection names the components that RECEIVE the write —
    // here the write is membership. A generator's `'source'` means the opposite, that the
    // selection names what is generated FROM while the whole input is preserved.
    scope: { kind: 'target', domain: SCOPE_DOMAIN },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    name: 'modifier',
    muted: 'modifier',
    [SCOPE_PARAM]: 'modifier',
  },
  evaluate(params, inputs, _ctx, scope) {
    const selection = requireResolvedScope(scope, 'ComponentGroupOp');
    const src = inputs.target as ObjectData | undefined;
    // Unwired (transient authoring state) — nothing to name.
    if (!src) return src as unknown as ObjectData;
    // Nothing said yet. See the `name` param on why blank is not a group called "".
    if (params.name === '') return src;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — no face domain to name.
    if (!source) return src;

    const minted = mintGroupAttributes(source.geometry, params.name, selection, 'evaluate');
    // `null` is "this geometry has no derivable face count" — a glTF or baked source. There
    // is no domain to write onto, so the source rides through unchanged rather than carrying
    // a group that names nothing. Declared limit; it lifts with #605.
    if (minted === null) return src;

    const geometry = refWithAttributeKey(source.geometry, minted.key);
    return {
      kind: 'ModifiedData',
      geometry,
      material: source.material,
      attributeKey: minted.key,
      ...slotTableThrough(source, geometry),
    };
  },
};
