// #1451 — the first slice of Collections (#397): a named set of scene Objects, for organising and
// hiding them. NOT a transform and not a parent: it holds its members by `members` edges, which the
// outliner and the viewport read off the graph, while each member stays where it hangs in the
// scene (at the top, or under its parent). Blender's model — "Scene → master Collection → nested
// Collections", "explicitly independent of parenting" (#397). The `Group` node is Blender's parent
// Empty, a different axis; this node must never gain a transform (#397: "resist the pull to just
// add a flag to Group").
//
// The name is the node's `meta.name`, as an Object's is; a Collection with its `viewport` (or
// `render`) flag off hides its members there (`hiddenByCollection`, #1503) — a member it shares
// with a shown collection stays (#1481).
//
// REF: issues #397, #1451; Blender 5.1.1 `io_scene_gltf2/blender/imp/node.py` (an import links its
// objects into a Collection named after the file's scene).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { CollectionValue } from './types';
import { visibilityParams } from './visibilityParams';

// #1503 — a collection's own viewport and render flags; a member hides only when every
// collection holding it is hidden (#1481). Not keyable, as Blender's collection toggles are not.
export const CollectionParams = z.object({ ...visibilityParams }).passthrough();
export type CollectionParams = z.infer<typeof CollectionParams>;

export const CollectionNode: NodeDefinition<CollectionParams, CollectionValue> = {
  type: 'Collection',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CollectionParams,
  inputs: { members: { type: 'SceneObject', cardinality: 'list' } },
  outputs: { out: { type: 'Collection', cardinality: 'single' } },
  inspectorSections: ['layout'],
  home: {},
  evaluate(_params, inputs) {
    return {
      kind: 'Collection',
      memberCount: ((inputs.members as unknown[] | undefined) ?? []).length,
    };
  },
};
