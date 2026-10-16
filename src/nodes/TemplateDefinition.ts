// #1557 — the node that holds a template's definition (`core/dag/templates.ts`).
//
// It sits in the graph so making, changing and deleting a template are ordinary operations, the
// way a Blender node group is a data-block of the `.blend`. Nothing reads it as a value: it has
// no inputs and no outputs, and its definition is a node type while it is in the graph.

import type { NodeDefinition } from '../core/dag/types';
import { TEMPLATE_DEFINITION_TYPE, TemplateDefinitionParams } from '../core/dag/templates';

export const TemplateDefinitionNode: NodeDefinition<TemplateDefinitionParams, null> = {
  type: TEMPLATE_DEFINITION_TYPE,
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: TemplateDefinitionParams,
  inputs: {},
  outputs: {},
  evaluate: () => null,
};
