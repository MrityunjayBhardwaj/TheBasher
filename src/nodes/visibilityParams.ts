// #1503 — visibility, as two params: shown in the viewport, and included in the render. Blender
// keeps the two apart — measured in Blender 5.1.1 (Cycles, headless): an object with its eye off
// still renders, and one with its render toggle off does not. Houdini does not (#1546): at the
// object level its one display flag hides a node from the viewport AND takes it out of the
// objects a render considers (Mantra's Candidate Objects need the flag on; only Force Objects
// ignores it), and a separate Render flag exists only inside a geometry network. Basher follows
// Blender here. Spread into ObjectParams, GroupParams and CollectionParams.
//
// Blender's eye and its "Disable in Viewports" toggle are merged into one `viewport` flag: the eye
// belongs to a view layer, and Basher has one scene and no view layers, so a second flag would be
// the same switch twice.
//
// Both `.optional()` for the reason `slotOverrides` is (ObjectNode.ts): a `.default(true)` would
// write two `true`s into every saved node, which is a format change dressed as a default. Absent
// means shown, so a project that hides nothing saves byte-identical. Read through `ownShown`
// (src/app/collections.ts), never by hand.

import { z } from 'zod';

/** The two params, spread into the param schema of every node type the eye can hide. */
export const visibilityParams = {
  viewport: z.boolean().optional(),
  render: z.boolean().optional(),
};
