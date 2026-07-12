// Null — a physical, transformable SCENE OBJECT with no geometry (#296). Blender's
// Empty / Houdini's Null: a first-class CONTROLLER. It carries a full TRS, appears in
// the Outliner (a leaf scene child), is grabbed by the existing transform gizmo (it has
// a `position` param — Gizmo.tsx getManipulable), and renders only a selectable axis
// glyph (editor chrome, excluded from image renders). A driver reads its transform
// CHANNELS (tx…sz) to drive other params — the Blender "Transform Channel" idiom, the
// primary controller path (the spare-param handles are the secondary custom-knob path).
//
// Source node (no input), unlike Transform which WRAPS a child. Its value carries only
// the TRS; there is nothing to render but the glyph, so the child union gains a
// dedicated `Null` kind (not a childless Transform — that renders an empty container).
//
// H14 hydrate seam: pre-field projects can't exist for a new node, but mirror the
// defensive `?? default` guards the mesh/light evaluates use so a hand-authored or
// migrated param bag never yields undefined TRS.
//
// REF: src/nodes/types.ts (NullValue); src/viewport/NullGlyph.tsx (the glyph);
//      src/app/Gizmo.tsx (grabbable via position param); issue #296.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { NullValue, Vec3 } from './types';

export const NullParams = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
});
export type NullParams = z.infer<typeof NullParams>;

export const NullNode: NodeDefinition<NullParams, NullValue> = {
  type: 'Null',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NullParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['transform', 'constraint'],
  evaluate(params) {
    return {
      kind: 'Null',
      position: (params.position ?? [0, 0, 0]) as Vec3,
      rotation: (params.rotation ?? [0, 0, 0]) as Vec3,
      scale: (params.scale ?? [1, 1, 1]) as Vec3,
    };
  },
};
